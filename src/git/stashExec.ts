// stash 계열 git 명령을 실행하는 공통 헬퍼.
// - 일부 저장소에서 fsmonitor daemon IPC 가 깨져 있으면 stash apply/pop/push 가 index 쓰기 단계에서
//   `could not write index` 로 실패할 수 있어, stash 명령에는 fsmonitor 를 명시적으로 끈다.
import { GitError, runGit, type RunGitOptions } from "./gitExec";

export interface PreservedLocalChangesStash {
  hash: string;
  includesUntracked: boolean;
}

/**
 * `git stash ...` 명령을 fsmonitor 비활성화 옵션과 함께 실행한다.
 * - 일반 git 실행 경로(runGit)는 유지하되, stash 가 index 를 갱신하는 순간 fsmonitor 오류에 막히지 않게 한다.
 * @param args `stash` 뒤에 붙일 인자 배열
 * @param repoRoot git 저장소 루트
 * @param options 추가 env 또는 lock 재시도 옵션
 * @returns git 표준 출력
 */
export function runStash(
  args: string[],
  repoRoot: string,
  options?: RunGitOptions
): Promise<string> {
  return runGit(["-c", "core.fsmonitor=false", "stash", ...args], repoRoot, {
    ...options,
    beforeRetry: async () => {
      await refreshIndex(repoRoot);
      await options?.beforeRetry?.();
    },
  });
}

/**
 * 로컬 변경을 PR/branch operation 전용 임시 stash 로 보존한다.
 * - 기본은 untracked 포함 stash 이다.
 * - 일부 저장소에서 `stash push -u`가 index 쓰기 오류로 실패하면 index refresh 후 재시도한다.
 * - 그래도 실패하면 추적 파일만 보존하는 fallback 으로 작업 시작 가능성을 높인다.
 * @param repoRoot git 저장소 루트
 * @param message stash 메시지
 * @returns 새로 만든 stash hash. 저장할 변경이 없으면 undefined
 */
export async function pushPreservedLocalChangesStash(
  repoRoot: string,
  message: string
): Promise<PreservedLocalChangesStash | undefined> {
  const before = await topStashHash(repoRoot);
  try {
    await runStash(["push", "--include-untracked", "-m", message], repoRoot);
    return stashCreatedAfter(repoRoot, before, true);
  } catch (err) {
    if (!isCouldNotWriteIndexError(err)) {
      throw err;
    }
    const partial = await stashCreatedAfter(repoRoot, before, true);
    if (partial) {
      throw new Error(
        "Local changes were saved, but Git could not clean the working tree after writing the stash. " +
          `Preserved stash: ${partial.hash}. ${errText(err)}`
      );
    }
    await refreshIndex(repoRoot);
    const retried = await tryIncludeUntrackedStash(repoRoot, message, before);
    if (retried) {
      return retried;
    }
    try {
      await runStash(["push", "-m", `${message} (tracked files only)`], repoRoot);
    } catch (fallbackErr) {
      throw new Error(
        "Local changes could not be preserved because Git could not write the index. " +
          `${errText(err)}\nTracked-only stash fallback also failed: ${errText(fallbackErr)}`
      );
    }
    return stashCreatedAfter(repoRoot, before, false);
  }
}

/** include-untracked stash 를 한 번 더 시도하되, 부분 stash 생성 여부를 먼저 확인한다. */
async function tryIncludeUntrackedStash(
  repoRoot: string,
  message: string,
  before: string | undefined
): Promise<PreservedLocalChangesStash | undefined> {
  try {
    await runStash(["push", "--include-untracked", "-m", message], repoRoot, { retryOnLock: false });
    return stashCreatedAfter(repoRoot, before, true);
  } catch (err) {
    const partial = await stashCreatedAfter(repoRoot, before, true);
    if (partial) {
      throw new Error(
        "Local changes were saved, but Git could not clean the working tree after writing the stash. " +
          `Preserved stash: ${partial.hash}. ${errText(err)}`
      );
    }
    if (!isCouldNotWriteIndexError(err)) {
      throw err;
    }
    return undefined;
  }
}

/** stash stack 의 최신 항목 commit hash 를 반환한다. */
async function topStashHash(repoRoot: string): Promise<string | undefined> {
  const hash = (await runGit(["rev-parse", "--verify", "stash@{0}"], repoRoot).catch(() => "")).trim();
  return hash || undefined;
}

/** before 이후 새 stash 가 만들어졌는지 확인한다. */
async function stashCreatedAfter(
  repoRoot: string,
  before: string | undefined,
  includesUntracked: boolean
): Promise<PreservedLocalChangesStash | undefined> {
  const after = await topStashHash(repoRoot);
  if (!after || after === before) {
    return undefined;
  }
  return { hash: after, includesUntracked };
}

/** index refresh 를 best-effort 로 실행한다. */
async function refreshIndex(repoRoot: string): Promise<void> {
  await runGit(
    ["-c", "core.fsmonitor=false", "update-index", "--really-refresh", "-q"],
    repoRoot,
    { retryOnLock: false }
  ).catch(() => undefined);
}

/** 오류가 Git index 쓰기 실패인지 확인한다. */
function isCouldNotWriteIndexError(err: unknown): boolean {
  return /could not write index/i.test(errText(err));
}

/** 오류 메시지를 사용자에게 보여줄 짧은 문자열로 만든다. */
function errText(err: unknown): string {
  if (err instanceof GitError) {
    return [err.stderr.trim(), err.stdout.trim(), err.message]
      .filter(Boolean)
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
}
