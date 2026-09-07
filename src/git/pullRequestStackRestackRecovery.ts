// stack rollback에서 저장한 결과 OID만 되돌리고 새 커밋/로컬 편집을 보존한다.
import { detectOperation } from "./conflictService";
import { runGit } from "./gitExec";
import { PullRequestStackMetadataService } from "./pullRequestStackMetadata";
import { clearRestackState, writeRestackState } from "./pullRequestStackRestackRuntime";
import type { PendingPullRequestStackRestack } from "./pullRequestStackRestack";
import { WorktreeService } from "./worktreeService";
import { logInfo } from "../ui/outputLog";

/**
 * 모든 layer의 소유권을 먼저 검사한 뒤 역순으로 원래 OID와 metadata를 복원한다.
 * @param repoRoot stack의 원래 저장소 루트
 * @param state 각 layer의 시작/완료 OID와 snapshot을 보관한 실행 기록
 * @returns 전체 복구 완료 시에만 pending을 제거하며, 실패 시 모든 backup ref를 남긴다.
 */
export async function rollbackRestack(repoRoot: string, state: PendingPullRequestStackRestack): Promise<void> {
  const worktrees = await new WorktreeService(repoRoot).listWorktrees();
  const restorations = [];
  for (const step of state.steps) {
    const expected = step.afterHead ?? step.beforeHead;
    const current = (await runGit(["rev-parse", `refs/heads/${step.branch}`], repoRoot)).trim();
    const snapshot = (await runGit(["rev-parse", step.snapshotRef], repoRoot)).trim();
    if (current !== expected || snapshot !== step.beforeHead) {
      logInfo("stack rollback stopped", { repoRoot, branch: step.branch, expected, current, snapshot });
      throw new Error(`Cannot restore '${step.branch}': the branch changed after restack. New commits and recovery snapshots were kept.`);
    }
    const owner = worktrees.find(worktree => worktree.branch === step.branch);
    if (owner) await assertCleanOwner(owner.path, step.branch, expected);
    restorations.push({ step, owner, expected, snapshot });
  }
  for (const { step, owner, expected, snapshot } of restorations.reverse()) {
    if (expected !== snapshot) {
      if (owner) {
        await assertCleanOwner(owner.path, step.branch, expected);
        await runGit(["reset", "--keep", snapshot], owner.path, { retryOnLock: false });
      } else {
        await runGit(["update-ref", `refs/heads/${step.branch}`, snapshot, expected], repoRoot, { retryOnLock: false });
      }
      // 중간 복구 실패 후 재시도 시에도 이미 되돌린 layer를 이 작업 결과로 식별한다.
      step.afterHead = snapshot;
      await writeRestackState(repoRoot, state);
    }
    if (step.temporaryWorktree && step.worktreePath) {
      await runGit(["worktree", "remove", step.worktreePath], repoRoot, { retryOnLock: false });
      step.worktreePath = undefined;
      step.temporaryWorktree = false;
      await writeRestackState(repoRoot, state);
    }
  }
  const metadata = new PullRequestStackMetadataService(repoRoot);
  for (const checkpoint of state.metadataBefore) {
    await metadata.restoreParent(checkpoint.branch, checkpoint.parentBranch, checkpoint.parentHead);
  }
  await clearRestackState(repoRoot);
}

/** reset 직전에 branch/HEAD/작업 상태/모든 로컬 변경을 다시 확인한다. */
async function assertCleanOwner(worktreePath: string, branch: string, expected: string): Promise<void> {
  const [currentBranch, head, status, operation] = await Promise.all([
    runGit(["branch", "--show-current"], worktreePath),
    runGit(["rev-parse", "HEAD"], worktreePath),
    runGit(["status", "--porcelain=v1", "--untracked-files=all"], worktreePath),
    detectOperation(worktreePath),
  ]);
  if (currentBranch.trim() !== branch || head.trim() !== expected || status || operation !== "none") {
    throw new Error(`Cannot restore '${branch}': worktree '${worktreePath}' changed or still has a Git operation. Recovery snapshots were kept.`);
  }
}
