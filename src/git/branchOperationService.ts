// 브랜치 단위 squash merge / rebase merge 작업을 담당하는 서비스.
// - graph UI 는 확인과 결과 안내만 하고, 실제 git 상태 변경은 이 모듈로 모은다.
import { randomUUID } from "node:crypto";
import { detectOperation, detectOperationInGitDir } from "./conflictService";
import { readGitCheckoutIdentity } from "./repositoryIdentity";
import { withGitStatePathScope } from "./gitStatePathScope";
import { recoverFailedRebaseStart } from "./rebaseFailureRecovery";
import { OperationUndoStore as BranchOperationUndoStore, type OperationUndoPlan as BranchOperationUndoPlan } from "./operationUndoStore";
import { logError, logInfo } from "../ui/outputLog";
import {
  assertPendingBranchRebaseMergeLocalChangesRestoreSafe,
  restorePendingBranchRebaseMergeLocalChangesForBranch,
  runBranchRebaseMerge,
} from "./branchRebaseMerge";
import { GitError, runGit } from "./gitExec";
import { commitPreparedIndex } from "./preparedIndexCommit";
import { assertCurrentBranchHead } from "./refSafety";
import { pushPreservedLocalChangesStash } from "./stashExec";
import { listUnmergedFiles } from "./unmergedFiles";
import { hasStagedWorkingTreeChanges, hasWorkingTreeChanges } from "./workingTreeChanges";
import { BranchRebaseCompletionError } from "./branchRebaseCompletionError";
import { createBranchSquashWorktree, materializeReplayWorktree } from "./replayWorktree";
import { removeTemporaryWorktree } from "./temporaryWorktree";
import { resetOperationResult } from "./operationResultReset";
import { readBranchSquashResult } from "./branchSquashResult";

/** 브랜치 단위 작업 실행 결과와 undo 에 필요한 snapshot 정보 */
export interface BranchOperationResult {
  status: "completed" | "conflicts";
  branch: string;
  sourceBranch: string;
  beforeHead: string;
  afterHead: string;
  snapshotRef: string;
  preservedStashHash?: string;
  rebaseTodo?: import("./rebaseTodoProgress").RebaseTodoProgress;
}

/** 브랜치 단위 작업 undo 결과 */
export interface BranchOperationUndoResult {
  branch: string;
  restoredHead: string;
}

interface PreservedLocalChanges {
  hash: string;
}

/** 브랜치 단위 git 작업 서비스 */
export class BranchOperationService {
  private readonly undoStore: BranchOperationUndoStore;

  constructor(public readonly repoRoot: string) {
    this.undoStore = new BranchOperationUndoStore(repoRoot);
  }

  /**
   * source 브랜치의 변경을 현재 브랜치에 squash commit 하나로 병합한다.
   * - 깨끗한 작업트리에서는 현재 브랜치에 직접 `merge --squash` 를 수행해 충돌 파일을 바로 보여준다.
   * - 로컬 변경이 있으면 임시 worktree 에서 squash commit 을 만든 뒤 현재 브랜치에 안전하게 가져온다.
   * @param sourceBranch 병합할 로컬 브랜치 이름
   * @returns undo 가능한 작업 결과 또는 충돌 대기 상태
   */
  async squashMerge(sourceBranch: string): Promise<BranchOperationResult> {
    return withGitStatePathScope(this.repoRoot, () => this.squashMergeScoped(sourceBranch));
  }

  /** 실행 한 번의 metadata 경로만 공유하며 snapshot/현재 브랜치 검증은 기존 쓰기 경계마다 수행한다. */
  private async squashMergeScoped(sourceBranch: string): Promise<BranchOperationResult> {
    const { branch, head: beforeHead } = await this.assertReadyForBranchOperation();
    const sourceHead = await this.assertSourceBranch(sourceBranch);
    this.assertDifferentBranches(branch, sourceBranch);
    // 같은 OID끼리의 squash는 결과가 없다. 이전 Undo와 사용자 index를 건드리기 전에 끝낸다.
    if (sourceHead === beforeHead) {
      logInfo("branch squash skipped", { repoRoot: this.repoRoot, branch, sourceBranch, head: beforeHead, reason: "identicalCommit" });
      throw new Error(`Branch '${sourceBranch}' did not produce changes to commit.`);
    }
    if (await this.hasLocalChanges()) {
      return this.squashMergeWithLocalChanges(sourceBranch, branch, beforeHead, sourceHead);
    }
    // 시작 OID는 먼저 보존하되, 실제 변경이 없으면 이전 완료 작업의 Undo 연결은 그대로 둔다.
    const snapshotRef = await this.createSnapshot(branch, beforeHead, false);
    let bound = false, unchanged = false;
    try {
      // 준비 중 외부 checkout/commit을 건드리지 않도록 native merge 직전에 다시 검증한다.
      await assertCurrentBranchHead(this.repoRoot, branch, beforeHead, "starting branch squash merge");
      await runGit(["merge", "--squash", sourceHead], this.repoRoot, {
        env: { GIT_EDITOR: "true", HUSKY: "0" },
      });
      if (!await this.hasPendingChanges()) {
        unchanged = true;
        await runGit(["update-ref", "-d", snapshotRef, beforeHead], this.repoRoot, { retryOnLock: false });
        logInfo("branch squash skipped", { repoRoot: this.repoRoot, branch, sourceBranch, reason: "noIndexChanges" });
        throw new Error(`Branch '${sourceBranch}' did not produce changes to commit.`);
      }
      await this.undoStore.start(branch, beforeHead, snapshotRef);
      bound = true;
      // merge --squash가 확정한 index만 commit해 이후 생긴 사용자 편집을 다시 stage하지 않는다.
      await assertCurrentBranchHead(this.repoRoot, branch, beforeHead, "committing branch squash result");
      await this.commitSquash(sourceBranch, branch, this.repoRoot);
      const afterHead = await readBranchSquashResult(this.repoRoot, beforeHead);
      await this.undoStore.capture(branch, snapshotRef, "completed", false, afterHead);
      return {
        status: "completed",
        branch,
        sourceBranch,
        beforeHead,
        afterHead,
        snapshotRef,
      };
    } catch (err) {
      if (unchanged) throw err;
      const recorded = await this.recordFailedSquash(branch, beforeHead, snapshotRef, bound);
      if (recorded && await this.hasUnmergedChanges()) {
        return {
          status: "conflicts",
          branch,
          sourceBranch,
          beforeHead,
          afterHead: beforeHead,
          snapshotRef,
        };
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * 현재 브랜치를 선택한 target ref 위로 실제 git rebase 한다.
   * - local/remote target 모두 ref 를 로컬 브랜치로 materialize 하지 않고 commit 으로 resolve 해서 사용한다.
   * - 결과적으로 사용자가 현재 브랜치에서 `git rebase <target>` 을 실행한 것과 같은 방향으로 동작한다.
   * - 충돌이 나면 Git 이 멈춘 todo 위치 그대로 Conflicts 뷰에 노출한다.
   * @param targetRef rebase 대상 local/remote ref 또는 commit
   * @returns undo 가능한 작업 결과 또는 충돌 대기 상태
   */
  async rebaseMerge(targetRef: string): Promise<BranchOperationResult> {
    return withGitStatePathScope(this.repoRoot, () => this.rebaseMergeScoped(targetRef));
  }

  /** 준비부터 native rebase 완료까지 같은 worktree의 private 경로만 재사용한다. */
  private async rebaseMergeScoped(targetRef: string): Promise<BranchOperationResult> {
    const { branch, head: beforeHead } = await this.assertReadyForBranchOperation();
    this.assertDifferentBranches(branch, targetRef);
    const targetHead = await this.resolveCommit(targetRef);
    const snapshotRef = await this.createSnapshot(branch, beforeHead);
    const preserved = await this.preserveLocalChanges(`before rebase onto '${targetRef}'`, branch, beforeHead);
    let result: Awaited<ReturnType<typeof runBranchRebaseMerge>>;
    try {
      result = await runBranchRebaseMerge({
        repoRoot: this.repoRoot,
        branch,
        targetRef,
        beforeHead,
        targetHead,
        snapshotRef,
        preservedStashHash: preserved?.hash,
      });
    } catch (err) {
      if (err instanceof BranchRebaseCompletionError) throw err;
      const { restored, notice } = await recoverFailedRebaseStart({
        repoRoot: this.repoRoot, branch, beforeHead, snapshotRef, preservedStashHash: preserved?.hash,
      });
      if (restored) {
        await runGit(["update-ref", "-d", snapshotRef, beforeHead], this.repoRoot).catch(() => "");
      }
      const error = this.withPreservedStashNotice(err, restored ? undefined : preserved, branch);
      error.message += notice;
      throw error;
    }
    // Git 실행 결과가 확정된 뒤의 기록 실패도 시작 실패 복구로 되돌리지 않는다.
    try {
      if (result.status !== "completed" || preserved?.hash) {
        await this.undoStore.capture(branch, snapshotRef,
          await detectOperation(this.repoRoot) === "rebase" ? "rebase" : "completed", false,
          result.status === "completed" ? result.afterHead : undefined);
      }
    } catch (error) {
      if (result.status === "completed") {
        throw new BranchRebaseCompletionError(error, { branch, snapshotRef, afterHead: result.afterHead });
      }
      throw this.withPreservedStashNotice(error, preserved, branch);
    }
    return {
      status: result.status,
      branch,
      sourceBranch: targetRef,
      beforeHead,
      afterHead: result.afterHead,
      snapshotRef,
      preservedStashHash: result.preservedStashHash,
      rebaseTodo: result.rebaseTodo,
    };
  }

  /**
   * 현재 브랜치의 마지막 branch operation 을 시작 전 snapshot 으로 되돌린다.
   * - rebase merge 가 충돌로 멈춘 경우에는 먼저 진행 중인 git 작업을 abort 한다.
   * @param branchName undo 대상 브랜치. 생략하면 현재 브랜치를 사용한다.
   * @param approvedPlan 확인창 이전에 고정한 작업. 생략하면 현재 상태를 검증해 만든다.
   * @returns 복원된 브랜치와 HEAD
   */
  async undoLastOperation(branchName?: string, approvedPlan?: BranchOperationUndoPlan): Promise<BranchOperationUndoResult> {
    const plan = approvedPlan ?? await this.prepareUndo(branchName);
    const { branch, restoredHead } = plan;
    await assertPendingBranchRebaseMergeLocalChangesRestoreSafe(this.repoRoot, branch, plan.snapshotRef);
    await this.undoStore.undo(plan);
    await restorePendingBranchRebaseMergeLocalChangesForBranch(
      this.repoRoot,
      branch,
      "Branch operation was undone, but preserved local changes could not be restored.",
      plan.snapshotRef
    );
    await this.undoStore.remove(plan);
    return {
      branch,
      restoredHead,
    };
  }

  /** 확인창 대기 중 작업이나 HEAD가 바뀌는 것을 감지하도록 Undo 대상을 고정한다. */
  async prepareUndo(branchName?: string): Promise<BranchOperationUndoPlan> {
    const plan = await this.undoStore.prepare(branchName);
    await assertPendingBranchRebaseMergeLocalChangesRestoreSafe(this.repoRoot, plan.branch, plan.snapshotRef);
    return plan;
  }

  /**
   * 현재 브랜치에 branch operation undo snapshot 이 있는지 확인한다.
   * @param branchName 확인할 브랜치. 생략하면 현재 브랜치를 사용한다.
   */
  async hasUndoSnapshot(branchName?: string): Promise<boolean> {
    return this.prepareUndo(branchName).then(() => true, () => false);
  }

  /**
   * HEAD와 unmerged index를 최대 두 조회로 함께 읽고, 둘 다 완료된 뒤 시작 조건을 확인한다.
   * 조회 실패는 충돌 없음으로 바꾸지 않는다. 실패한 자식도 모두 종료된 뒤 쓰기 없이 중단한다.
   * @returns 진행 중 작업/충돌이 없고 로컬 브랜치를 가리키는 새 checkout identity
   */
  private async assertReadyForBranchOperation() {
    const [identity, unmerged] = await Promise.allSettled([
      readGitCheckoutIdentity(this.repoRoot), listUnmergedFiles(this.repoRoot),
    ]);
    if (identity.status === "rejected") throw identity.reason;
    const checkout = identity.value;
    const operation = detectOperationInGitDir(checkout.gitDir);
    if (operation !== "none") {
      throw new Error(`Cannot start branch operation while ${operation} is in progress.`);
    }
    if (unmerged.status === "rejected") throw unmerged.reason;
    if (unmerged.value.length) {
      throw new Error("Resolve unmerged files before running a branch operation.");
    }
    if (!checkout.branch) throw new Error("Branch operations require a checked-out local branch.");
    return checkout;
  }

  /**
   * source 브랜치 ref 가 실제 로컬 브랜치인지 확인한다.
   * @param sourceBranch 병합할 로컬 브랜치 이름
   * @returns 준비 중 ref가 이동하거나 같은 이름의 tag가 생겨도 실행 대상을 바꾸지 않을 전체 OID
   */
  private async assertSourceBranch(sourceBranch: string): Promise<string> {
    const out = await runGit(
      ["rev-parse", "--verify", `refs/heads/${sourceBranch}^{commit}`],
      this.repoRoot
    ).catch(error => {
      if (error instanceof GitError && (error.code === 1 || error.code === 128)) return "";
      throw error;
    });
    if (!out.trim()) {
      throw new Error(`Local branch not found: ${sourceBranch}`);
    }
    return out.trim();
  }

  /**
   * 현재 브랜치와 source 브랜치가 같은 경우 자기 자신 병합을 막는다.
   * @param branch 현재 브랜치
   * @param sourceBranch 병합할 브랜치
   */
  private assertDifferentBranches(branch: string, sourceBranch: string): void {
    if (branch === sourceBranch) {
      throw new Error("Cannot merge a branch into itself.");
    }
  }

  /** 현재 작업트리나 index 에 커밋되지 않은 변경이 있는지 확인한다. */
  private async hasLocalChanges(): Promise<boolean> {
    return hasWorkingTreeChanges(this.repoRoot);
  }

  /** index 에 unmerged 상태로 남은 파일이 있는지 확인한다. */
  private async hasUnmergedChanges(): Promise<boolean> {
    return (await listUnmergedFiles(this.repoRoot)).length > 0;
  }

  /** squash merge 후 commit 할 변경이 있는지 확인한다. */
  private async hasPendingChanges(): Promise<boolean> {
    return this.hasPendingChangesIn(this.repoRoot);
  }

  /**
   * 시작 commit을 보호하는 ref를 만든다. clean squash는 변경 확인까지 기존 Undo 연결을 유지한다.
   * @param branch 대상 브랜치 @param head 시작 OID @param bind true면 새 작업의 Undo 연결도 즉시 준비한다.
   * @returns 시작 OID를 보존한 고유 ref
   */
  private async createSnapshot(branch: string, head: string, bind = true): Promise<string> {
    const ref = `refs/gitsimplecompare/branch-operation-snapshots/${Buffer.from(branch).toString("hex")}/${randomUUID()}`;
    await runGit(["update-ref", ref, head], this.repoRoot);
    if (bind) await this.undoStore.start(branch, head, ref);
    return ref;
  }

  /**
   * squash 부분 적용의 소유권을 기록한다. 실패하면 다른 Git 충돌을 이 작업의 결과로 분류하지 않는다.
   * @param branch 작업 소유 브랜치 @param beforeHead 시작 OID @param snapshotRef 시작 상태를 보존한 내부 ref
   * @param bound 이미 이 snapshot의 Undo 연결을 준비했는지 여부. 아니면 원래 checkout의 부분 적용부터 확인한다.
   * @returns 현재 HEAD/index/작업 세대까지 기록했으면 true, 오류를 OUTPUT에 남겼으면 false
   */
  private async recordFailedSquash(branch: string, beforeHead: string, snapshotRef: string, bound: boolean): Promise<boolean> {
    try {
      if (!bound) {
        await assertCurrentBranchHead(this.repoRoot, branch, beforeHead, "recording failed branch squash");
        if (!await this.hasPendingChanges()) return false;
        await this.undoStore.start(branch, beforeHead, snapshotRef);
      }
      await this.undoStore.capture(branch, snapshotRef, "squash");
      return true;
    } catch (error) {
      logError("branch squash recovery recording failed; snapshot preserved", error, { repoRoot: this.repoRoot, branch, snapshotRef });
      return false;
    }
  }

  /**
   * local/remote ref 또는 commit-ish 를 commit hash 로 정규화한다.
   * @param ref rebase 대상 ref
   * @returns 전체 commit hash
   */
  private async resolveCommit(ref: string): Promise<string> {
    const hash = (await runGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], this.repoRoot).catch(error => {
      if (error instanceof GitError && (error.code === 1 || error.code === 128)) return "";
      throw error;
    })).trim();
    if (!hash) {
      throw new Error(`Rebase target not found: ${ref}`);
    }
    return hash;
  }

  /** 로컬 변경이 있는 상태에서 squash commit 을 임시 worktree 로 계산해 현재 브랜치에 반영한다. */
  private async squashMergeWithLocalChanges(
    sourceBranch: string,
    branch: string,
    beforeHead: string,
    sourceHead: string
  ): Promise<BranchOperationResult> {
    const worktree = await createBranchSquashWorktree(this.repoRoot, beforeHead, sourceHead);
    const worktreePath = worktree.path;
    let keepWorktree = false;
    let snapshotRef = "";
    try {
      try {
        await runGit(["merge", "--squash", sourceHead], worktreePath, {
          env: { GIT_EDITOR: "true", HUSKY: "0" },
        });
      } catch (err) {
        // 충돌 검사 자체가 실패해도 부분 적용된 index를 삭제하지 않는다.
        keepWorktree = true;
        let unmerged: boolean;
        try {
          unmerged = await this.hasUnmergedChangesIn(worktreePath);
          if (unmerged && worktree.compact) await materializeReplayWorktree(worktreePath, "branch squash");
        } catch (recoveryError) {
          logError("branch squash conflict preparation failed; worktree preserved", recoveryError,
            { repoRoot: this.repoRoot, worktreePath, compact: worktree.compact });
          throw new Error(`${errText(err)}\nConflict recovery could not be prepared. ` +
            `Inspect the preserved temporary worktree: ${worktreePath}. ${errText(recoveryError)}`);
        }
        if (unmerged) {
          throw new Error(
            `Branch '${sourceBranch}' has squash merge conflicts. ` +
            "The current working tree was not changed. " +
            `Resolve the conflict in the preserved temporary worktree: ${worktreePath}. ${errText(err)}`
          );
        }
        keepWorktree = false;
        throw err;
      }
      // index가 준비된 뒤의 hook/반영/기록 실패도 복구 대상이다. 성공 전에는 생성 결과를 지우지 않는다.
      keepWorktree = true;
      try {
        if (!await this.hasPendingChangesIn(worktreePath)) {
          keepWorktree = false;
          throw new Error(`Branch '${sourceBranch}' did not produce changes to commit.`);
        }
        await this.commitSquash(sourceBranch, branch, worktreePath, !worktree.compact);
        const afterHead = await readBranchSquashResult(worktreePath, beforeHead);
        snapshotRef = await this.createSnapshot(branch, beforeHead);
        // 직접 부모를 위에서 검증했다. 원본 branch/HEAD는 실제 index lock 안에서 새로 확인한다.
        await resetOperationResult(this.repoRoot, afterHead, { branch, head: beforeHead }, "branch squash");
        await this.undoStore.capture(branch, snapshotRef, "completed", false, afterHead);
        keepWorktree = false;
        return { status: "completed", branch, sourceBranch, beforeHead, afterHead, snapshotRef };
      } catch (error) {
        if (!keepWorktree) throw error;
        let materialization = "";
        try { if (worktree.compact) await materializeReplayWorktree(worktreePath, "branch squash"); }
        catch (failure) { materialization = ` Recovery files could not be fully materialized: ${errText(failure)}`; }
        logError("branch squash finalization failed; worktree preserved", error,
          { repoRoot: this.repoRoot, branch, worktreePath, snapshotRef, materialization });
        throw new Error(`${errText(error)}\nInspect the preserved temporary worktree: ${worktreePath}.${materialization}`);
      }
    } finally {
      if (!keepWorktree) {
        await removeTemporaryWorktree(this.repoRoot, worktreePath);
      }
    }
  }

  /** squash merge commit 을 만든다. 자동 작업이므로 pre-commit hook 은 실행하지 않는다. */
  private async commitSquash(sourceBranch: string, destinationBranch: string, cwd: string, checkout = true): Promise<void> {
    await commitPreparedIndex(cwd, { title: `Squash merge '${sourceBranch}'`,
      body: `Squash-merged branch '${sourceBranch}' into '${destinationBranch}'.`, checkout });
  }

  /** Native squash가 index에 확정한 변경만 확인한다. 나중에 생긴 unstaged 편집은 commit 대상으로 삼지 않는다. */
  private async hasPendingChangesIn(cwd: string): Promise<boolean> {
    return hasStagedWorkingTreeChanges(cwd);
  }

  /** 지정한 worktree 에 충돌로 남은 unmerged index entry 가 있는지 확인한다. */
  private async hasUnmergedChangesIn(cwd: string): Promise<boolean> {
    return (await listUnmergedFiles(cwd)).length > 0;
  }

  /**
   * 원래 checkout을 새로 검증한 뒤 로컬 변경을 stash로 보존한다. 다른 브랜치의 편집은 이동하지 않는다.
   * @param reason stash 설명 @param branch 준비 시 고정한 브랜치 @param beforeHead 준비 시 고정한 OID
   * @returns 로컬 변경이 없으면 undefined, 보존했으면 소유 stash OID
   */
  private async preserveLocalChanges(reason: string, branch: string, beforeHead: string): Promise<PreservedLocalChanges | undefined> {
    if (!await this.hasLocalChanges()) {
      return undefined;
    }
    await assertCurrentBranchHead(this.repoRoot, branch, beforeHead, "preserving branch rebase local changes");
    return pushPreservedLocalChangesStash(this.repoRoot, `Git Simple Compare ${reason}`);
  }

  /** 충돌로 멈춘 작업에서는 사용자의 원래 변경이 어느 stash 에 보존됐는지 오류에 덧붙인다. */
  private withPreservedStashNotice(
    err: unknown,
    preserved: PreservedLocalChanges | undefined,
    undoBranch?: string
  ): Error {
    const base = err instanceof Error ? err : new Error(String(err));
    if (undoBranch) {
      (base as Error & { undoBranch?: string }).undoBranch = undoBranch;
    }
    if (!preserved) {
      return base;
    }
    const next = new Error(`${errText(err)}\nLocal changes were preserved in stash ${preserved.hash}.`);
    if (undoBranch) {
      (next as Error & { undoBranch?: string }).undoBranch = undoBranch;
    }
    return next;
  }

}

/** 오류 메시지를 사용자에게 보여줄 짧은 문자열로 만든다. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
