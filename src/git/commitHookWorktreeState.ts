// 저장소 내부 custom hook이 다음 커밋에 섞이지 않도록 index/ignore 상태를 계산한다.
// - Git metadata 외부 hook에만 적용하며 조회 오류는 fail-closed로 상위 서비스에 전달한다.
import * as path from "node:path";
import { GitError, runGit, runGitWithInput } from "./gitExec";
import type {
  CommitHookEntry,
  CommitHookName,
} from "./commitHookService";
import type { ResolvedHookDirectory } from "./commitHookPaths";

/** custom hook의 UI 상태와 index가 이미 예약한 표준 이름 묶음. */
export interface CommitHookGitState {
  hooks: CommitHookEntry[];
  reservedNames: CommitHookName[];
}

/**
 * custom hook의 index 추적 여부와 현재 파일 이름의 ignore 안전성을 조회한다.
 * - Git metadata 또는 symlink를 따라 저장소 밖에 있는 파일은 작업트리에 포함되지 않으므로 조회하지 않는다.
 * @param repoRoot Git index/ignore 규칙을 읽을 저장소 루트
 * @param resolved hook 관리/실행 경로와 metadata 경계 정보
 * @param hooks 파일 시스템에서 발견한 hook 항목
 * @param names 서비스가 지원하는 전체 표준 hook 이름
 * @returns 보강된 UI hook 상태와 tracked-deleted 이름
 */
export async function commitHookGitState(
  repoRoot: string,
  resolved: ResolvedHookDirectory,
  hooks: CommitHookEntry[],
  names: readonly CommitHookName[]
): Promise<CommitHookGitState> {
  if (resolved.localMetadata || !resolved.insideWorktree) {
    return { hooks, reservedNames: [] };
  }
  const relativePaths = names
    .flatMap((name) => [
      normalizedRelativePath(resolved.canonicalRepoRoot, resolved.canonicalDirectory, name),
      normalizedRelativePath(resolved.canonicalRepoRoot, resolved.canonicalDirectory, `${name}.disabled`),
    ])
    .filter(
      (relative) =>
        relative &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative)
    );
  if (!relativePaths.length) {
    return { hooks, reservedNames: [] };
  }
  const [trackedOutput, ignoredOutput] = await Promise.all([
    runGit(["ls-files", "-z", "--", ...relativePaths], repoRoot),
    readIgnoredPaths(repoRoot, relativePaths),
  ]);
  const tracked = nullSeparatedPathSet(trackedOutput);
  const ignored = nullSeparatedPathSet(ignoredOutput);
  const reservedNames = names.filter((name) => {
    const active = normalizedRelativePath(
      resolved.canonicalRepoRoot,
      resolved.canonicalDirectory,
      name
    );
    return tracked.has(active) || tracked.has(`${active}.disabled`);
  });
  return {
    hooks: hooks.map((hook) =>
      withWorktreeSafety(
        resolved.canonicalRepoRoot,
        resolved.canonicalDirectory,
        hook,
        tracked,
        ignored
      )
    ),
    reservedNames,
  };
}

/**
 * hook 한 건에 tracked/untracked 위험과 토글 차단 이유를 반영한다.
 * @param repoRoot 상대 경로 기준 저장소 루트
 * @param directory hook 관리 디렉터리
 * @param hook 파일 시스템에서 읽은 hook 상태
 * @param tracked index에 등록된 후보 경로 집합
 * @param ignored 활성/비활성 양쪽 ignore 후보 경로 집합
 * @returns 작업트리 안전 상태가 추가된 새 hook entry
 */
function withWorktreeSafety(
  repoRoot: string,
  directory: string,
  hook: CommitHookEntry,
  tracked: Set<string>,
  ignored: Set<string>
): CommitHookEntry {
  const active = normalizedRelativePath(repoRoot, directory, hook.name);
  const disabled = `${active}.disabled`;
  const isTracked = tracked.has(active) || tracked.has(disabled);
  const current = hook.state === "disabled" ? disabled : active;
  const isVisible = !isTracked && !ignored.has(current);
  return {
    ...hook,
    tracked: isTracked,
    worktreeVisible: isVisible,
    canToggle: hook.canToggle && !isTracked && !isVisible,
    toggleBlockedReason: isTracked
      ? "tracked"
      : isVisible
        ? "worktree"
        : hook.toggleBlockedReason,
  };
}

/**
 * 활성/비활성 후보 경로가 ignore 규칙에 포함되는지 Git 자체 규칙으로 조회한다.
 * - check-ignore exit 1은 정상적인 "일치 없음"이므로 빈 stderr일 때만 빈 결과로 바꾼다.
 * @param repoRoot ignore 규칙을 평가할 저장소 루트
 * @param relativePaths 저장소 상대 hook 후보 경로
 * - 일부 Git 버전은 경로 인자와 `-z` 조합을 거부하므로 `--stdin`으로 NUL 구분 경로를 전달한다.
 * @returns NUL로 구분된 ignored 경로 출력
 */
async function readIgnoredPaths(
  repoRoot: string,
  relativePaths: string[]
): Promise<string> {
  try {
    return await runGitWithInput(
      ["check-ignore", "--no-index", "-z", "--stdin"],
      repoRoot,
      `${relativePaths.join("\0")}\0`
    );
  } catch (error) {
    if (error instanceof GitError && !error.stderr.trim()) {
      return error.stdout;
    }
    throw error;
  }
}

/**
 * NUL 구분 Git 경로 출력을 플랫폼 정규화된 Set으로 변환한다.
 * @param output `ls-files -z` 또는 `check-ignore -z` 출력
 * @returns 빠른 포함 검사용 상대 경로 집합
 */
function nullSeparatedPathSet(output: string): Set<string> {
  return new Set(
    output
      .split("\0")
      .filter(Boolean)
      .map((relative) => path.normalize(relative))
  );
}

/**
 * hook 디렉터리와 파일 이름을 저장소 상대 정규 경로로 결합한다.
 * @param repoRoot 상대화 기준 저장소 루트
 * @param directory hook 관리 디렉터리
 * @param name 활성 또는 `.disabled` hook 파일 이름
 * @returns 플랫폼 separator를 사용하는 정규 상대 경로
 */
function normalizedRelativePath(
  repoRoot: string,
  directory: string,
  name: string
): string {
  return path.normalize(path.relative(repoRoot, path.join(directory, name)));
}
