// 격리 replay/squash의 worktree 준비와 충돌 시 파일 복원을 소유한다. Native Git 엔진은 유지한다.
import { lstat } from "node:fs/promises";
import * as path from "node:path";
import { GitError, runGit, runGitWithInput } from "./gitExec";
import { canUseCompactReplayWorktree, minimumCompactWorktreeEntries, type CompactWorktreeOperation } from "./replayWorktreePolicy";
import { readReplayWorktreePaths, readSkippedReplayWorktreePaths } from "./replayWorktreePaths";
import { createBranchOperationWorktree, createPrOperationWorktree, removeTemporaryWorktree } from "./temporaryWorktree";
import { logError, logInfo } from "../ui/outputLog";

/** 실행 중인 소유 worktree의 위치와 아직 파일 복원이 필요한지 여부다. */
export interface ReplayWorktree { path: string; compact: boolean }

/**
 * 큰 일반 index와 hook/filter 없는 조건에서만 파일 checkout을 생략하고 Native skip-worktree를 사용한다.
 * @param root 원래 저장소 @param beforeHead 고정 시작 OID @param commits 기존 Native 엔진에 전달할 OID 배열
 * @returns 실행 후 정리하거나 복구용으로 보존할 worktree. 원래 index/config는 변경하지 않는다.
 */
export async function createReplayWorktree(root: string, beforeHead: string, commits: readonly string[]): Promise<ReplayWorktree> {
  return createCompactWorktree(root, beforeHead, commits, "replay");
}

/**
 * 로컬 변경을 보존하는 브랜치 squash의 큰 임시 checkout만 생략한다.
 * @param root 원래 저장소 @param beforeHead 고정 목적 OID @param sourceHead 고정 병합 OID
 * @returns Native merge에 전달할 독립 index/worktree. 충돌 시 compact 파일을 펼친 뒤 노출해야 한다.
 */
export function createBranchSquashWorktree(root: string, beforeHead: string, sourceHead: string): Promise<ReplayWorktree> {
  return createCompactWorktree(root, beforeHead, [sourceHead], "merge");
}

/** 작업 종류의 생성 경로와 hook 검증을 유지하면서 index 준비·실패 정리를 공유한다. */
async function createCompactWorktree(
  root: string, beforeHead: string, commits: readonly string[], operation: CompactWorktreeOperation
): Promise<ReplayWorktree> {
  const create = operation === "merge" ? createBranchOperationWorktree : createPrOperationWorktree;
  const label = operation === "merge" ? "branch squash" : "PR replay";
  const compact = await canUseCompactReplayWorktree(root, beforeHead, commits, operation);
  const worktreePath = await create(root, beforeHead, !compact);
  if (!compact) return { path: worktreePath, compact: false };
  const started = Date.now();
  let registered = true;
  /** 지원하지 않는 조건에서는 빈 소유 등록만 정리하고 hook을 포함한 원래 Native 생성 의미를 유지한다. */
  const fullWorktree = async (reason: string): Promise<ReplayWorktree> => {
    await removeTemporaryWorktree(root, worktreePath); registered = false;
    logInfo(`${label} full worktree selected`, { repoRoot: root, reason });
    return { path: await create(root, beforeHead), compact: false };
  };
  try {
    await runGit(["read-tree", beforeHead], worktreePath);
    // includeIf·worktreeConfig·detached HEAD 때문에 원래 worktree와 유효 설정이 다를 수 있다.
    // 새 worktree에서 다시 확인하고, hook이 필요하면 빈 등록만 정리한 뒤 원래 Native 생성 경로를 쓴다.
    if (!await canUseCompactReplayWorktree(worktreePath, beforeHead, commits, operation)) {
      return await fullWorktree("worktreeConfiguration");
    }
    const paths = await readReplayWorktreePaths(worktreePath);
    if (!paths || paths.count < minimumCompactWorktreeEntries(operation)) {
      // submodule 등은 reset으로 checkout을 흉내 내지 않고 기존 worktree add 경로로 실행한다.
      return await fullWorktree("unsupportedIndexPaths");
    }
    await runGitWithInput(["update-index", "--skip-worktree", "-z", "--stdin"], worktreePath, paths.input);
    logInfo(`${label} index-only worktree prepared`, { repoRoot: root, worktreePath, entries: paths.count,
      pathBytes: paths.input.length, elapsedMs: Date.now() - started });
    return { path: worktreePath, compact: true };
  } catch (error) {
    try { if (registered) await removeTemporaryWorktree(root, worktreePath); }
    catch (cleanup) { logError(`${label} preparation cleanup failed`, cleanup, { repoRoot: root, worktreePath }); }
    throw error;
  }
}

/**
 * 복구를 노출하기 전에 남은 S-tag 파일만 펼친다. 이미 생긴 파일·수동 삭제·충돌 해결은 덮지 않는다.
 * @param root 출처 검증이 끝난 소유 compact worktree. 실패하면 S-tag를 남겨 같은 복구로 재시도한다.
 * @param label 복구 안내와 OUTPUT에 표시할 작업 이름
 */
export async function materializeReplayWorktree(root: string, label = "PR"): Promise<void> {
  const started = Date.now(), paths = await readSkippedReplayWorktreePaths(root);
  if (!paths) throw new Error(`Cannot fully materialize the preserved ${label} worktree: path limits exceeded. Worktree: ${root}.`);
  if (!paths.count) return;
  try {
    await runGitWithInput(["checkout-index", "--ignore-skip-worktree-bits", "--index", "--quiet", "-z", "--stdin"], root, paths.input);
  } catch (error) {
    if (!(error instanceof GitError) || error.code !== 1 || error.killed || error.signal) throw error;
    // Native는 기존 수동 파일도 code 1로 남긴다. 모든 선택 경로가 실제 파일일 때만 이를 허용한다.
    await assertMaterializedPaths(root, paths.input, label);
  }
  await runGitWithInput(["update-index", "--no-skip-worktree", "-z", "--stdin"], root, paths.input);
  logInfo(`${label === "PR" ? "PR replay" : label} worktree materialized`,
    { worktreePath: root, entries: paths.count, elapsedMs: Date.now() - started });
}

/** code 1에서만 최대 네 개의 lstat을 병렬 실행해 기존 파일은 보존하고 실제 누락·권한 오류는 전파한다. */
async function assertMaterializedPaths(root: string, input: Buffer, label: string): Promise<void> {
  let offset = 0;
  let failure: unknown;
  /** 같은 Buffer의 NUL 경로를 하나씩 소유해 비 UTF-8 이름도 원본 바이트로 확인한다. */
  const worker = async () => {
    while (offset < input.length && failure === undefined) {
      const start = offset, end = input.indexOf(0, start); offset = end + 1;
      const file = Buffer.concat([Buffer.from(root + path.sep), input.subarray(start, end)]);
      try {
        const info = await lstat(file);
        if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`A local path blocks ${label} worktree materialization. Worktree: ${root}.`);
      } catch (error) { failure ??= error; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (failure !== undefined) throw failure;
}
