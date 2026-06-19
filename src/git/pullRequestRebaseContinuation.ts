// PR rebase 충돌 해결 이후의 후속 처리를 담당하는 모듈.
// - 시작 작업은 PullRequestOperationService 가 수행하고, 충돌 후 continue/abort/stash 정리는
//   Conflicts 명령에서 이 모듈을 통해 이어받는다.
import { detectOperation } from "./conflictService";
import { runGit } from "./gitExec";
import {
  clearPendingPullRequestRebase,
  readPendingPullRequestRebase,
  type PendingPullRequestRebase,
} from "./pullRequestOperationState";
import {
  dropPreservedLocalChangesStash,
  restorePreservedLocalChangesStash,
} from "./stashExec";

/** 충돌 해결 후 PR rebase 후처리 결과 */
export type PullRequestRebaseResumeResult =
  | { status: "none" }
  | { status: "pending" }
  | { status: "completed"; branch: string; afterHead: string; restoredLocalChanges: boolean }
  | { status: "restoreConflicts"; branch: string; preservedStashHash?: string };

/** PR rebase 상태 파일 정리 결과 */
export type PullRequestRebaseCleanupResult =
  | { status: "none" }
  | { status: "restored"; branch: string }
  | { status: "dropped"; branch: string };

/**
 * rebase 가 끝난 PR 작업 브랜치를 목적 브랜치에 fast-forward 하고 보존 stash 를 복원한다.
 * @param repoRoot git 저장소 루트
 * @param pending 충돌 전 저장해 둔 PR rebase 상태
 * @param rebasedHead rebase 가 완료된 PR 작업 브랜치 HEAD
 */
export async function completePendingPullRequestRebase(
  repoRoot: string,
  pending: PendingPullRequestRebase,
  rebasedHead: string
): Promise<void> {
  await switchToBranch(repoRoot, pending.destinationBranch);
  await runGit(["merge", "--ff-only", rebasedHead], repoRoot, { env: { GIT_EDITOR: "true" } });
  await restorePendingLocalChanges(repoRoot, pending, "PR rebase completed, but local changes could not be restored.");
}

/**
 * 충돌 해결 후 `git rebase --continue` 가 끝난 PR rebase 를 목적 브랜치에 반영한다.
 * - rebase 가 아직 진행 중이면 pending 을 반환해 다음 충돌 해결을 기다린다.
 * @param repoRoot git 저장소 루트
 */
export async function finishPendingPullRequestRebaseAfterContinue(
  repoRoot: string
): Promise<PullRequestRebaseResumeResult> {
  const pending = await readPendingPullRequestRebase(repoRoot);
  if (!pending) {
    return { status: "none" };
  }
  if (await isConflictState(repoRoot)) {
    return { status: "pending" };
  }
  const rebasedHead = await currentHead(repoRoot);
  try {
    await completePendingPullRequestRebase(repoRoot, pending, rebasedHead);
  } catch (err) {
    if (await hasUnmergedChanges(repoRoot)) {
      return {
        status: "restoreConflicts",
        branch: pending.destinationBranch,
        preservedStashHash: pending.preservedStashHash,
      };
    }
    throw err;
  }
  return {
    status: "completed",
    branch: pending.destinationBranch,
    afterHead: await currentHead(repoRoot),
    restoredLocalChanges: Boolean(pending.preservedStashHash),
  };
}

/**
 * PR rebase abort 뒤 목적 브랜치와 보존 stash 를 복원한다.
 * @param repoRoot git 저장소 루트
 */
export async function restorePendingPullRequestRebaseAfterAbort(
  repoRoot: string
): Promise<PullRequestRebaseCleanupResult> {
  const pending = await readPendingPullRequestRebase(repoRoot);
  if (!pending || await isConflictState(repoRoot)) {
    return { status: "none" };
  }
  await switchToBranch(repoRoot, pending.destinationBranch);
  await restorePendingLocalChanges(repoRoot, pending, "PR rebase was aborted, but preserved local changes could not be restored.");
  await runGit(["update-ref", "-d", pending.snapshotRef], repoRoot).catch(() => "");
  return { status: "restored", branch: pending.destinationBranch };
}

/**
 * stash 복원 충돌이 사용자의 파일 해결로 끝난 뒤 보존 stash 와 상태 파일을 정리한다.
 * @param repoRoot git 저장소 루트
 */
export async function dropPendingPullRequestStashAfterResolvedRestore(
  repoRoot: string
): Promise<PullRequestRebaseCleanupResult> {
  const pending = await readPendingPullRequestRebase(repoRoot);
  if (!pending || await isConflictState(repoRoot)) {
    return { status: "none" };
  }
  if (pending.preservedStashHash) {
    await dropPreservedLocalChangesStash(repoRoot, pending.preservedStashHash);
    await clearPendingPullRequestRebase(repoRoot);
    return { status: "dropped", branch: pending.destinationBranch };
  }
  await clearPendingPullRequestRebase(repoRoot);
  return { status: "none" };
}

/**
 * 지정 브랜치의 pending PR rebase stash 를 복원한다.
 * @param repoRoot git 저장소 루트
 * @param branch 현재 복원 대상 브랜치
 * @param failureMessage stash 복원 실패 시 붙일 사용자 메시지
 */
export async function restorePendingPullRequestLocalChangesForBranch(
  repoRoot: string,
  branch: string,
  failureMessage: string
): Promise<void> {
  const pending = await readPendingPullRequestRebase(repoRoot);
  if (!pending || pending.destinationBranch !== branch) {
    return;
  }
  await restorePendingLocalChanges(repoRoot, pending, failureMessage);
}

/**
 * pending 상태의 보존 stash 를 복원하고 상태 파일을 제거한다.
 * @param repoRoot git 저장소 루트
 * @param pending 저장된 PR rebase 상태
 * @param failureMessage stash 복원 실패 시 붙일 사용자 메시지
 */
async function restorePendingLocalChanges(
  repoRoot: string,
  pending: PendingPullRequestRebase,
  failureMessage: string
): Promise<void> {
  if (pending.preservedStashHash) {
    await restorePreservedLocalChangesStash(repoRoot, pending.preservedStashHash, failureMessage);
  }
  await clearPendingPullRequestRebase(repoRoot);
}

/**
 * 진행 중 작업 또는 unmerged index entry 가 남아 있는지 확인한다.
 * @param repoRoot git 저장소 루트
 */
async function isConflictState(repoRoot: string): Promise<boolean> {
  const [operation, hasUnmerged] = await Promise.all([
    detectOperation(repoRoot),
    hasUnmergedChanges(repoRoot),
  ]);
  return operation !== "none" || hasUnmerged;
}

/**
 * index 에 unmerged 상태로 남은 파일이 있는지 확인한다.
 * @param repoRoot git 저장소 루트
 */
async function hasUnmergedChanges(repoRoot: string): Promise<boolean> {
  return (await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], repoRoot)).length > 0;
}

/**
 * 현재 로컬 브랜치 이름을 읽는다.
 * @param repoRoot git 저장소 루트
 */
async function currentBranch(repoRoot: string): Promise<string> {
  return (await runGit(["symbolic-ref", "--short", "HEAD"], repoRoot).catch(() => "")).trim();
}

/**
 * 지정한 로컬 브랜치로 working tree 를 전환한다.
 * @param repoRoot git 저장소 루트
 * @param branch 전환할 브랜치 이름
 */
async function switchToBranch(repoRoot: string, branch: string): Promise<void> {
  if (await currentBranch(repoRoot) === branch) {
    return;
  }
  await runGit(["switch", branch], repoRoot);
}

/**
 * 현재 HEAD commit hash 를 반환한다.
 * @param repoRoot git 저장소 루트
 */
async function currentHead(repoRoot: string): Promise<string> {
  return (await runGit(["rev-parse", "--verify", "HEAD"], repoRoot)).trim();
}
