// 모든 임시 PR 작업의 충돌 해결·큐 재개·원래 브랜치 반영을 하나의 서비스로 연결한다.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { continuePendingDeferredCommitRebase } from "./deferredCommitRebase";
import { ConflictService } from "./conflictService";
import { runConflictMutation } from "./conflictMutationCoordinator";
import { GitError, runGit } from "./gitExec";
import { assertGitOperation, captureGitOperation } from "./operationControl";
import { PullRequestOperationSnapshot } from "./pullRequestOperationSnapshot";
import { squashBody, squashRevertBody, squashRevertTitle, squashTitle } from "./pullRequestOperationFormat";
import { replayPullRequestSquash, PullRequestSquashReplayConflict } from "./pullRequestSquashReplay";
import {
  assertPullRequestRecoveryIdentity, createPullRequestWorktreeRecovery,
  readPullRequestWorktreeRecovery, removePullRequestWorktreeRecovery, writePullRequestWorktreeRecovery,
  pinPullRequestRecoverySources,
  listPullRequestWorktreeRecoveries,
  type PullRequestWorktreeRecovery,
} from "./pullRequestWorktreeRecoveryState";
import { removeTemporaryWorktree } from "./temporaryWorktree";
import { logError, logInfo } from "../ui/outputLog";
import type { PullRequestOperationResult } from "./pullRequestOperationWorktree";

/** UI가 긴 Git stderr를 파싱하지 않고 정확한 복구 명령으로 연결할 수 있는 오류다. */
export class PullRequestWorktreeRecoveryError extends Error {
  constructor(public readonly recovery: PullRequestWorktreeRecovery, message: string) { super(message); }
}

/** 복구 저장에 필요한 실행 정보. Git directory와 native 세대는 저장 시 직접 읽는다. */
export type PullRequestRecoveryInput = Omit<PullRequestWorktreeRecovery,
  "version" | "id" | "originGitDir" | "worktreeGitDir" | "createdAt" | "nativeOperation">;

/**
 * 충돌 또는 결과 반영 실패를 영속화하고 UI에 전달할 구조화 오류를 만든다.
 * @param input 원래 브랜치와 보존된 임시 worktree의 실행 정보
 * @param failure Output에서 확인할 원래 Git 오류
 * @returns 저장 ID를 가진 오류. 원래 작업트리는 변경하지 않는다.
 */
export async function preservePullRequestWorktreeRecovery(
  input: PullRequestRecoveryInput, failure: unknown
): Promise<PullRequestWorktreeRecoveryError> {
  const record = await createPullRequestWorktreeRecovery({
    ...input, nativeOperation: await captureGitOperation(input.worktreePath),
  });
  await pinPullRequestRecoverySources(record);
  await writePullRequestWorktreeRecovery(record);
  await runGit(["worktree", "lock", "--reason", recoveryLockReason(record), record.worktreePath], record.originRoot);
  logError("PR operation preserved for recovery", failure, {
    repoRoot: record.originRoot, id: record.id, number: record.pr.number, command: record.command,
    phase: record.phase, worktreePath: record.worktreePath, remaining: record.remaining.length,
  });
  const detail = failure instanceof GitError ? [failure.message, failure.stderr, failure.stdout].filter(Boolean).join("\n")
    : failure instanceof Error ? failure.message : String(failure);
  const location = record.phase === "conflicts" ? "preserved temporary worktree" : "preserved in a temporary worktree";
  return new PullRequestWorktreeRecoveryError(record,
    `PR #${record.pr.number} paused; the current working tree was not changed. ` +
    `The PR result is ${location}: ${record.worktreePath}. ${detail}`);
}

/**
 * 같은 HEAD·PR·작업을 다시 눌렀을 때 새 worktree를 만들지 않고 이미 저장된 해결로 연결한다.
 * @param input 동일 재시도를 판별할 원래 저장소·브랜치·HEAD·PR·작업 종류
 */
export async function assertNoDuplicatePullRequestRecovery(
  input: Pick<PullRequestRecoveryInput, "originRoot" | "branch" | "beforeHead" | "pr" | "command">
): Promise<void> {
  const saved = (await listPullRequestWorktreeRecoveries(input.originRoot)).find(record =>
    record.phase !== "applied" && record.branch === input.branch && record.beforeHead === input.beforeHead &&
    record.command === input.command && record.pr.number === input.pr.number && record.pr.headHash === input.pr.headHash);
  if (!saved) return;
  await assertPullRequestRecoveryIdentity(saved);
  throw new PullRequestWorktreeRecoveryError(saved, `PR #${saved.pr.number} already has a saved operation. Resume it instead of replaying it again.`);
}

/** 저장된 임시 worktree를 해결한 후 남은 PR 작업을 원래 대상 브랜치에 반영한다. */
export class PullRequestWorktreeRecoveryService {
  constructor(public readonly originRoot: string) {}

  /**
   * 동일 저장소의 이중 클릭을 직렬화하고 저장된 작업만 재개한다.
   * @param id 알림 또는 복구 목록에서 선택한 작업 UUID
   * @returns 다음 충돌이면 같은 작업을 보존하고, 완료이면 Undo 가능한 결과를 반환한다.
   */
  async continue(id: string): Promise<PullRequestOperationResult> {
    const selected = await readPullRequestWorktreeRecovery(this.originRoot, id);
    return runConflictMutation(selected.originRoot, async () => {
      const record = await readPullRequestWorktreeRecovery(selected.originRoot, id);
      return runConflictMutation(record.worktreePath, () => this.resume(record));
    });
  }

  /**
   * worktree 출처·native 작업 세대·사용자 해결 여부를 검증한 뒤 실행 단계를 이어간다.
   * @param saved reload 전후에도 같은 작업을 가리키는 영속 레코드
   */
  private async resume(saved: PullRequestWorktreeRecovery): Promise<PullRequestOperationResult> {
    await assertPullRequestRecoveryIdentity(saved);
    let record = { ...saved };
    if (record.phase === "replaying") {
      throw new Error("The PR replay was interrupted during a Git write. Its worktree was preserved; inspect it before retrying.");
    }
    if (record.phase === "conflicts") {
      await assertGitOperation(record.worktreePath, record.nativeOperation);
      const conflicts = await new ConflictService(record.worktreePath).listConflicts();
      if (conflicts.length) throw new Error(`Resolve and stage the remaining ${conflicts.length} conflict(s) before continuing the PR.`);
      await assertNoUnstagedChanges(record.worktreePath);
      if (record.command === "squash" || record.command === "squashRevert") {
        record = await this.resumeSquash(record);
      } else {
        record = await this.resumeRebase(record);
      }
      if (record.phase === "conflicts") return pausedResult(record);
    }
    return this.applyResult(record);
  }

  /**
   * 해결한 index를 유지한 채 native marker를 종료하고 남은 patch를 commit 없이 재생한다.
   * @param record 사용자가 충돌을 해결한 squash 작업
   * @returns 다음 충돌 또는 하나의 squash commit을 준비한 상태
   */
  private async resumeSquash(record: PullRequestWorktreeRecovery): Promise<PullRequestWorktreeRecovery> {
    let current = { ...record, phase: "replaying" as const };
    await writePullRequestWorktreeRecovery(current);
    if (record.nativeOperation.operation !== "none") {
      await assertGitOperation(record.worktreePath, record.nativeOperation);
      await runGit([record.nativeOperation.operation, "--quit"], record.worktreePath);
    }
    try {
      await replayPullRequestSquash(record.worktreePath, record.remaining,
        record.command === "squash" ? "cherry-pick" : "revert", async remaining => {
          current = { ...current, remaining };
          await writePullRequestWorktreeRecovery(current);
        });
    } catch (error) {
      if (!(error instanceof PullRequestSquashReplayConflict)) throw error;
      const paused: PullRequestWorktreeRecovery = {
        ...record, phase: "conflicts", remaining: error.remaining,
        nativeOperation: await captureGitOperation(record.worktreePath),
      };
      await writePullRequestWorktreeRecovery(paused);
      logInfo("PR recovery paused on next squash conflict", { id: record.id, worktreePath: record.worktreePath, remaining: paused.remaining.length });
      return paused;
    }
    await assertNoUnstagedChanges(record.worktreePath);
    const resolved: PullRequestWorktreeRecovery = {
      ...record, remaining: [], phase: "conflicts", nativeOperation: await captureGitOperation(record.worktreePath),
    };
    // commit hook이 거부하면 이미 해결한 patch를 재생하지 않고 commit만 다시 시도한다.
    await writePullRequestWorktreeRecovery(resolved);
    const isRevert = record.command === "squashRevert";
    const title = isRevert ? squashRevertTitle(record.pr) : squashTitle(record.pr);
    const body = isRevert ? squashRevertBody(record.pr) : squashBody(record.pr);
    // --allow-empty는 모든 변경을 현재 상태로 해결했을 때도 한 번 기록해 무한 재시도를 막는다.
    await runGit(["commit", "--allow-empty", "--no-verify", "-m", title, "-m", body], record.worktreePath,
      { env: { GIT_EDITOR: "true", HUSKY: "0" } });
    return this.saveReady(resolved);
  }

  /**
   * native Continue를 작업 세대에 고정해 실행하고 기존 deferred queue를 끝까지 진행한다.
   * @param record detached worktree에서 멈춘 commit 단위 PR 작업
   * @returns 다음 충돌 또는 반영 대기 중인 완성 commit 목록
   */
  private async resumeRebase(record: PullRequestWorktreeRecovery): Promise<PullRequestWorktreeRecovery> {
    const service = new ConflictService(record.worktreePath);
    await writePullRequestWorktreeRecovery({ ...record, phase: "replaying" });
    try {
      await service.continueOperation(record.nativeOperation.operation, record.nativeOperation);
    } catch (error) {
      // 모든 변경을 원래 내용으로 해결한 빈 commit은 소유권이 검증된 현재 항목만 건너뛴다.
      if (!isEmptyCommit(error) || (await service.listConflicts()).length) {
        // Git이 HEAD/marker를 바꾸지 않은 실패는 동일한 해결 결과로 재시도할 수 있다.
        try { await assertGitOperation(record.worktreePath, record.nativeOperation); await writePullRequestWorktreeRecovery(record); }
        catch { /* 바뀐 작업은 replaying 상태로 보존해 자동 재실행하지 않는다. */ }
        throw error;
      }
      await assertGitOperation(record.worktreePath, record.nativeOperation);
      await service.skipOperation(record.nativeOperation.operation, record.nativeOperation);
    }
    const result = await continuePendingDeferredCommitRebase(record.worktreePath);
    if (result.status === "conflicts") {
      const paused: PullRequestWorktreeRecovery = {
        ...record, nativeOperation: await captureGitOperation(record.worktreePath), phase: "conflicts",
      };
      await writePullRequestWorktreeRecovery(paused);
      return paused;
    }
    if (result.status !== "completed") throw new Error("The saved PR replay queue could not be verified. Its worktree was preserved.");
    return this.saveReady(record);
  }

  /** commit을 만든 뒤 고정 HEAD와 작업 세대를 저장해 원래 브랜치 반영만 재시도할 수 있게 한다. */
  private async saveReady(record: PullRequestWorktreeRecovery): Promise<PullRequestWorktreeRecovery> {
    const identity = await captureGitOperation(record.worktreePath);
    const ready: PullRequestWorktreeRecovery = {
      ...record, phase: "ready", remaining: [], afterHead: identity.head, nativeOperation: identity,
    };
    await writePullRequestWorktreeRecovery(ready);
    return ready;
  }

  /**
   * 원래 branch/HEAD가 시작 시점과 같을 때만 반영하고 Undo와 완료 기록을 저장한다.
   * @param record 사용자가 해결한 완성 commit을 가진 worktree 기록
   * @returns 완료 결과. 반영 대상의 새 편집이나 이력이 바뀌면 같은 기록을 유지한다.
   */
  private async applyResult(record: PullRequestWorktreeRecovery): Promise<PullRequestOperationResult> {
    const afterHead = record.afterHead;
    if (!afterHead) throw new Error("The PR recovery has no verified result commit.");
    await assertGitOperation(record.worktreePath, record.nativeOperation);
    if (record.expectedTree && (await runGit(["rev-parse", `${record.afterHead}^{tree}`], record.worktreePath)).trim() !== record.expectedTree) {
      throw new Error("PR squash commit tree changed during commit; applying the result was stopped.");
    }
    const state = new PullRequestOperationSnapshot(record.originRoot);
    await state.assertReadyForPrOperation();
    if (record.phase === "applied") {
      if (await state.currentBranch() !== record.branch || await state.currentHead() !== record.afterHead) {
        throw new Error("The destination changed after applying the PR. Its recovery record was kept.");
      }
    } else {
      await state.assertStillOnBranch(record.branch, record.beforeHead, afterHead);
      if (!record.snapshotRef) {
        record = { ...record, snapshotRef: await state.createSnapshot(record.branch, record.beforeHead, record.command) };
        await writePullRequestWorktreeRecovery(record);
      }
      await state.assertStillOnBranch(record.branch, record.beforeHead, afterHead);
      await state.resetCurrentBranchPreservingLocalChanges(afterHead,
        "The resolved PR could not be applied without overwriting local changes. Its worktree and snapshot were kept.",
        { branch: record.branch, head: record.beforeHead });
      record = { ...record, phase: "applied" };
      await writePullRequestWorktreeRecovery(record);
    }
    await state.recordCompleted(record.branch, record.snapshotRef!);
    // 충돌 해결 파일은 모두 commit되어야 한다. 사용자가 새로 만든 미추적 파일은 삭제하지 않는다.
    try {
      const extra = await runGit(["ls-files", "--others", "-z"], record.worktreePath);
      const clean = !extra && await isCleanWorktree(record.worktreePath, record.checkout);
      const lock = await readFile(join(record.worktreeGitDir, "locked"), "utf8").catch(() => "");
      const ownedLock = lock.trimEnd() === recoveryLockReason(record);
      if (ownedLock) await runGit(["worktree", "unlock", record.worktreePath], record.originRoot);
      if (clean && ownedLock) await removeTemporaryWorktree(record.originRoot, record.worktreePath);
      else logInfo("completed PR recovery worktree retained for additional local files or external lock", { worktreePath: record.worktreePath });
      await removePullRequestWorktreeRecovery(record);
    } catch (error) {
      // 이미 반영한 PR을 정리 실패 때문에 다시 실행하거나 실패로 표시하지 않는다.
      logError("completed PR recovery cleanup deferred", error, { id: record.id, worktreePath: record.worktreePath });
    }
    logInfo("PR recovery completed", { repoRoot: record.originRoot, id: record.id, branch: record.branch, afterHead: record.afterHead });
    return {
      status: "completed", branch: record.branch, beforeHead: record.beforeHead,
      afterHead, snapshotRef: record.snapshotRef!,
    };
  }
}

/** UUID가 일치하는 복구 작업만 worktree 잠금을 해제할 수 있도록 출처를 표시한다. */
function recoveryLockReason(record: PullRequestWorktreeRecovery): string {
  return `Git Simple Compare PR #${record.pr.number} recovery ${record.id}`;
}

/** @param root 해결용 worktree. stage하지 않은 편집은 commit·삭제하지 않고 해결을 요청한다. */
async function assertNoUnstagedChanges(root: string): Promise<void> {
  const output = await runGit(["diff", "--name-only", "-z"], root);
  if (output) throw new Error("Save and stage your conflict resolutions before continuing the PR.");
}

/** --no-checkout으로 만든 빈 디렉터리는 허용하고, 추가 파일이나 편집이 있으면 보존한다. */
async function isCleanWorktree(root: string, checkout: boolean): Promise<boolean> {
  const files = await readdir(root);
  if (!checkout && files.every(file => file === ".git")) return true;
  return !(await runGit(["status", "--porcelain=v1", "--untracked-files=all"], root));
}

/** 같은 복구 ID를 유지하면서 다음 충돌을 UI에 반환한다. */
function pausedResult(record: PullRequestWorktreeRecovery): PullRequestOperationResult {
  return { status: "conflicts", branch: record.branch, beforeHead: record.beforeHead,
    afterHead: record.nativeOperation.head, snapshotRef: record.snapshotRef ?? "" };
}

/** Git Continue가 해결 후 내용이 비어 commit하지 못한 경우인지 확인한다. */
function isEmptyCommit(error: unknown): boolean {
  const message = error instanceof GitError ? `${error.stderr}\n${error.stdout}` : String(error);
  return /previous cherry-pick is now empty|nothing to commit|nothing added to commit/i.test(message);
}
