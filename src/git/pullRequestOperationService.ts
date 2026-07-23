// PR 단위 cherry-pick/rebase/revert 명령을 조립하는 공개 Git 서비스.
// - 상태/snapshot은 PullRequestOperationSnapshot, dirty worktree 실행은 Worktree,
//   revert 대상 준비는 PullRequestRevertPlanService에 위임한다.
import { detectOperation } from "./conflictService";
import { runDeferredCommitRebase } from "./deferredCommitRebase";
import { GitError, runGit } from "./gitExec";
import { pullRequestCommitHashes } from "./pullRequestOperationFormat";
import {
  PullRequestOperationSnapshot,
  type PullRequestOperationUndoResult,
} from "./pullRequestOperationSnapshot";
import {
  PullRequestOperationWorktree,
  type PullRequestOperationResult,
} from "./pullRequestOperationWorktree";
import type { PullRequestInfo } from "./pullRequestInfo";
import {
  PullRequestRevertPlanService,
  type PullRequestRevertOperation,
  type PullRequestRevertPlan,
} from "./pullRequestRevertPlan";
import { assertCurrentBranchHead } from "./refSafety";
import {
  pushPreservedLocalChangesStash,
  restorePreservedLocalChangesStash,
} from "./stashExec";

export type {
  PullRequestOperationResult,
  PullRequestOperationUndoResult,
  PullRequestRevertPlan,
};

/** 호출자가 강제로 임시 worktree 실행을 선택할 수 있는 PR 작업 옵션 */
export interface PullRequestOperationOptions {
  strategy?: "auto" | "worktree";
}

/** deferred rebase 동안 보존한 사용자 local changes의 stash 정보 */
interface PreservedLocalChanges {
  hash: string;
}

/** PR 단위 Git 명령을 하위 상태·실행 모듈로 조립하는 서비스 */
export class PullRequestOperationService {
  private readonly state: PullRequestOperationSnapshot;
  private readonly worktree: PullRequestOperationWorktree;
  private readonly revertPlans: PullRequestRevertPlanService;

  constructor(public readonly repoRoot: string) {
    this.state = new PullRequestOperationSnapshot(repoRoot);
    this.worktree = new PullRequestOperationWorktree(repoRoot, this.state);
    this.revertPlans = new PullRequestRevertPlanService(repoRoot);
  }

  /**
   * PR commit 목록을 현재 브랜치에 하나의 squash commit으로 적용한다.
   * 로컬 변경이 있거나 worktree 전략을 강제하면 격리된 worktree에서 결과를 계산한다.
   * @param pr graph에서 선택된 PR 정보
   * @param options 실행 전략
   * @returns undo 가능한 작업 결과
   */
  async squashCherryPick(
    pr: PullRequestInfo,
    options?: PullRequestOperationOptions
  ): Promise<PullRequestOperationResult> {
    const commits = pullRequestCommitHashes(pr);
    if (!commits.length) {
      throw new Error(`PR #${pr.number} has no commit hashes to cherry-pick.`);
    }
    await this.state.assertReadyForPrOperation();
    const branch = await this.state.currentBranch();
    const beforeHead = await this.state.currentHead();
    if (
      options?.strategy === "worktree" ||
      await this.state.hasLocalChanges()
    ) {
      return this.worktree.squashCherryPick(
        pr,
        commits,
        branch,
        beforeHead
      );
    }
    const snapshotRef = await this.state.createSnapshot(
      branch,
      beforeHead,
      "squash"
    );
    try {
      await runGit(["cherry-pick", "--no-commit", ...commits], this.repoRoot);
      if (!await this.state.hasPendingChanges()) {
        throw new Error(`PR #${pr.number} did not produce changes to commit.`);
      }
      await runGit(["add", "-A"], this.repoRoot);
      await this.worktree.commitSquash(pr, this.repoRoot);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    return {
      status: "completed",
      branch,
      beforeHead,
      afterHead: await this.state.currentHead(),
      snapshotRef,
    };
  }

  /**
   * PR commit 범위를 현재 브랜치 HEAD 위에 commit 단위로 재적용한다.
   * 충돌 commit은 deferred queue에 남겨 Conflicts 뷰에서 계속할 수 있게 한다.
   * @param pr graph에서 선택된 PR 정보
   * @param options 실행 전략
   * @returns 완료 또는 충돌 대기 결과
   */
  async rebasePullRequest(
    pr: PullRequestInfo,
    options?: PullRequestOperationOptions
  ): Promise<PullRequestOperationResult> {
    const commits = pullRequestCommitHashes(pr);
    if (!commits.length) {
      throw new Error(`PR #${pr.number} has no commit hashes to rebase.`);
    }
    await this.state.assertReadyForPrOperation();
    const destinationBranch = await this.state.currentBranch();
    const beforeHead = await this.state.currentHead();
    if (
      options?.strategy === "worktree" ||
      await this.state.hasLocalChanges()
    ) {
      return this.worktree.rebasePullRequest(
        pr,
        commits,
        destinationBranch,
        beforeHead
      );
    }
    const snapshotRef = await this.state.createSnapshot(
      destinationBranch,
      beforeHead,
      "rebase"
    );
    const preserved = await this.preserveLocalChanges(
      `before PR #${pr.number} rebase`
    );
    try {
      const result = await runDeferredCommitRebase({
        kind: "pr-rebase",
        label: `PR #${pr.number}`,
        repoRoot: this.repoRoot,
        commits,
        destinationBranch,
        beforeHead,
        snapshotRef,
        sourceRef: pr.headRefName || pr.headHash,
        preservedStashHash: preserved?.hash,
        guardCurrentBranch: true,
      });
      return {
        status: result.status,
        branch: destinationBranch,
        beforeHead,
        afterHead: result.afterHead,
        snapshotRef,
        sourceBranch: result.sourceRef,
        preservedStashHash: result.preservedStashHash,
      };
    } catch (error) {
      const restored = await this.restoreAfterFailedDeferredRebase(
        preserved,
        destinationBranch,
        beforeHead,
        snapshotRef,
        "PR rebase merge failed, but local changes could not be restored."
      );
      if (restored) {
        await this.state.deleteSnapshotRef(destinationBranch, snapshotRef);
      }
      throw this.withPreservedStashNotice(
        error,
        restored ? undefined : preserved,
        destinationBranch
      );
    }
  }

  /**
   * Rebase Revert 사전검증 계획을 사용해 PR commit별 revert를 실행한다.
   * 이 모드는 commit 개수를 보존하므로 mergeHash가 아니라 원본 commit을 materialize한다.
   * @param pr graph에서 선택된 PR 정보
   * @param options 실행 전략
   * @param preparedPlan 사용자 확인 전에 준비한 계획
   * @returns 완료 또는 충돌 대기 결과
   */
  async rebaseRevertPullRequest(
    pr: PullRequestInfo,
    options?: PullRequestOperationOptions,
    preparedPlan?: PullRequestRevertPlan
  ): Promise<PullRequestOperationResult> {
    let destinationBranch: string;
    let beforeHead: string;
    let plan: PullRequestRevertPlan;
    try {
      await this.state.assertReadyForPrOperation();
      destinationBranch = await this.state.currentBranch();
      beforeHead = await this.state.currentHead();
      plan = await this.resolveRevertPlan(
        pr,
        "rebaseRevert",
        beforeHead,
        preparedPlan
      );
    } catch (error) {
      if (preparedPlan) {
        await this.releaseRevertPlanQuietly(preparedPlan);
      }
      throw error;
    }
    const commits = plan.commits.map((commit) => commit.hash);
    if (
      options?.strategy === "worktree" ||
      await this.state.hasLocalChanges()
    ) {
      const result = await this.worktree.rebaseRevertPullRequest(
        pr,
        commits,
        destinationBranch,
        beforeHead
      );
      if (result.status === "completed") {
        await this.releaseRevertPlanQuietly(plan);
      }
      return result;
    }
    const snapshotRef = await this.state.createSnapshot(
      destinationBranch,
      beforeHead,
      "rebaseRevert"
    );
    const preserved = await this.preserveLocalChanges(
      `before PR #${pr.number} rebase revert`
    );
    let releasePlan = false;
    try {
      const result = await runDeferredCommitRebase({
        kind: "pr-revert",
        operation: "revert",
        label: `PR #${pr.number} revert`,
        repoRoot: this.repoRoot,
        commits,
        destinationBranch,
        beforeHead,
        snapshotRef,
        sourceRef: pr.headRefName || pr.headHash,
        preservedStashHash: preserved?.hash,
        guardCurrentBranch: true,
      });
      releasePlan = result.status === "completed";
      return {
        status: result.status,
        branch: destinationBranch,
        beforeHead,
        afterHead: result.afterHead,
        snapshotRef,
        sourceBranch: result.sourceRef,
        preservedStashHash: result.preservedStashHash,
      };
    } catch (error) {
      const restored = await this.restoreAfterFailedDeferredRebase(
        preserved,
        destinationBranch,
        beforeHead,
        snapshotRef,
        "PR rebase revert failed, but local changes could not be restored."
      );
      if (restored) {
        await this.state.deleteSnapshotRef(destinationBranch, snapshotRef);
        releasePlan = true;
      }
      throw this.withPreservedStashNotice(
        error,
        restored ? undefined : preserved,
        destinationBranch
      );
    } finally {
      if (releasePlan) {
        await this.releaseRevertPlanQuietly(plan);
      }
    }
  }

  /**
   * Squash Revert 계획을 현재 브랜치에 적용해 단일 revert commit을 만든다.
   * 현재 이력에 mergeHash가 있으면 실제 병합 결과를, 아니면 materialize한 원본 commit을 사용한다.
   * @param pr graph에서 선택된 PR 정보
   * @param options 실행 전략
   * @param preparedPlan 사용자 확인 전에 준비한 계획
   * @returns 완료 또는 충돌 대기 결과
   */
  async squashRevertPullRequest(
    pr: PullRequestInfo,
    options?: PullRequestOperationOptions,
    preparedPlan?: PullRequestRevertPlan
  ): Promise<PullRequestOperationResult> {
    let branch: string;
    let beforeHead: string;
    let plan: PullRequestRevertPlan;
    try {
      await this.state.assertReadyForPrOperation();
      branch = await this.state.currentBranch();
      beforeHead = await this.state.currentHead();
      plan = await this.resolveRevertPlan(
        pr,
        "squashRevert",
        beforeHead,
        preparedPlan
      );
    } catch (error) {
      if (preparedPlan) {
        await this.releaseRevertPlanQuietly(preparedPlan);
      }
      throw error;
    }
    if (
      options?.strategy === "worktree" ||
      await this.state.hasLocalChanges()
    ) {
      const result = await this.worktree.squashRevert(
        pr,
        plan.commits,
        branch,
        beforeHead
      );
      if (result.status === "completed") {
        await this.releaseRevertPlanQuietly(plan);
      }
      return result;
    }
    const snapshotRef = await this.state.createSnapshot(
      branch,
      beforeHead,
      "squashRevert"
    );
    try {
      await this.worktree.applySquashRevert(plan.commits, this.repoRoot);
      if (!await this.state.hasPendingChanges()) {
        throw new Error(`PR #${pr.number} did not produce changes to commit.`);
      }
      await runGit(["add", "-A"], this.repoRoot);
      await this.worktree.commitSquashRevert(pr, this.repoRoot);
      const result: PullRequestOperationResult = {
        status: "completed",
        branch,
        beforeHead,
        afterHead: await this.state.currentHead(),
        snapshotRef,
        sourceBranch: this.sourceLabel(pr, plan),
      };
      await this.releaseRevertPlanQuietly(plan);
      return result;
    } catch (error) {
      if (await this.state.hasUnmergedChanges()) {
        return {
          status: "conflicts",
          branch,
          beforeHead,
          afterHead: beforeHead,
          snapshotRef,
          sourceBranch: this.sourceLabel(pr, plan),
        };
      }
      await this.state.deleteSnapshotRef(branch, snapshotRef);
      await this.releaseRevertPlanQuietly(plan);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * 사용자 확인창 전에 PR revert 대상·위험도·누락 object fetch를 완료한다.
   * UI는 반환된 targetKind/materialized/outsideCurrentBranch를 OUTPUT과 경고 문구에 사용한다.
   * @param pr 준비할 PR
   * @param operation squash/rebase revert 모드
   */
  async preparePullRequestRevert(
    pr: PullRequestInfo,
    operation: PullRequestRevertOperation
  ): Promise<PullRequestRevertPlan> {
    return this.revertPlans.prepare(pr, operation);
  }

  /**
   * 사용자가 확인창을 취소했거나 계획이 불필요해졌을 때 materialized ref를 정리한다.
   * @param plan preparePullRequestRevert가 반환한 계획
   * @returns 실제 숨김 ref를 삭제했는지 여부
   */
  async releasePullRequestRevertPlan(
    plan: PullRequestRevertPlan
  ): Promise<boolean> {
    return this.revertPlans.release(plan);
  }

  /**
   * 호환용 API로 현재 Squash Revert 계획의 외부 commit 수를 반환한다.
   * 호출 후 materialized ref를 정리하며, 오류를 0으로 숨기지 않고 그대로 전달한다.
   * @param pr 검사할 PR
   */
  async countRevertCommitsOutsideCurrentBranch(
    pr: PullRequestInfo
  ): Promise<number> {
    const plan = await this.preparePullRequestRevert(pr, "squashRevert");
    try {
      return plan.outsideCurrentBranch;
    } finally {
      await this.releaseRevertPlanQuietly(plan);
    }
  }

  /**
   * 현재 브랜치의 마지막 PR 작업을 snapshot으로 되돌린다.
   * @param branchName 오류 metadata에서 복구한 선택적 대상 브랜치
   */
  async undoLastOperation(
    branchName?: string
  ): Promise<PullRequestOperationUndoResult> {
    return this.state.undoLastOperation(branchName);
  }

  /**
   * 현재 또는 지정 브랜치에 유효한 PR 작업 undo snapshot이 있는지 확인한다.
   * @param branchName 확인할 선택적 브랜치
   */
  async hasUndoSnapshot(branchName?: string): Promise<boolean> {
    return this.state.hasUndoSnapshot(branchName);
  }

  /**
   * 전달된 계획을 검증하거나 현재 HEAD용 새 계획을 만든다.
   * @param pr 작업 대상 PR
   * @param operation revert 모드
   * @param currentHead 실제 실행 직전 HEAD
   * @param preparedPlan UI 사전검증에서 준비한 선택 계획
   */
  private async resolveRevertPlan(
    pr: PullRequestInfo,
    operation: PullRequestRevertOperation,
    currentHead: string,
    preparedPlan?: PullRequestRevertPlan
  ): Promise<PullRequestRevertPlan> {
    if (!preparedPlan) {
      return this.revertPlans.prepare(pr, operation, currentHead);
    }
    this.revertPlans.assertPreparedPlan(
      preparedPlan,
      pr,
      operation,
      currentHead
    );
    return preparedPlan;
  }

  /**
   * 성공·취소 후 materialized ref를 정리하되 cleanup 오류가 완료된 PR 작업을 실패로 바꾸지 않게 한다.
   * 충돌/보존 worktree 경로에서는 호출하지 않아 continuation에 필요한 object를 유지한다.
   * @param plan 정리할 계획
   */
  private async releaseRevertPlanQuietly(
    plan: PullRequestRevertPlan
  ): Promise<void> {
    await this.revertPlans.release(plan).catch(() => false);
  }

  /** 결과와 OUTPUT에 표시할 실제 revert 출처를 선택한다. */
  private sourceLabel(pr: PullRequestInfo, plan: PullRequestRevertPlan): string {
    return plan.targetKind === "mergedResult"
      ? pr.mergeHash || plan.commits[0]?.hash
      : pr.headRefName || pr.headHash || plan.commits[0]?.hash;
  }

  /** 로컬 변경이 있으면 deferred 작업 전 전용 stash로 보존한다. */
  private async preserveLocalChanges(
    reason: string
  ): Promise<PreservedLocalChanges | undefined> {
    if (!await this.state.hasLocalChanges()) {
      return undefined;
    }
    return pushPreservedLocalChangesStash(
      this.repoRoot,
      `Git Simple Compare ${reason}`
    );
  }

  /** 보존 stash를 working tree에 복원하고 성공하면 stash 목록에서 제거한다. */
  private async restorePreservedLocalChanges(
    preserved: PreservedLocalChanges | undefined,
    failureMessage: string
  ): Promise<void> {
    if (!preserved) {
      return;
    }
    await restorePreservedLocalChangesStash(
      this.repoRoot,
      preserved.hash,
      failureMessage
    );
  }

  /**
   * deferred rebase 시작 중 실패하면 snapshot으로 원복하고 사용자 stash를 복원한다.
   * 이미 conflict operation이 시작됐으면 상태를 보존해야 하므로 false를 반환한다.
   */
  private async restoreAfterFailedDeferredRebase(
    preserved: PreservedLocalChanges | undefined,
    branch: string,
    beforeHead: string,
    snapshotRef: string,
    restoreFailureMessage: string
  ): Promise<boolean> {
    if (await detectOperation(this.repoRoot) !== "none") {
      return false;
    }
    await this.state.switchToBranch(branch);
    await assertCurrentBranchHead(
      this.repoRoot,
      branch,
      beforeHead,
      "restoring failed PR operation"
    );
    await runGit(["reset", "--hard", snapshotRef], this.repoRoot);
    await this.restorePreservedLocalChanges(preserved, restoreFailureMessage);
    return true;
  }

  /**
   * 충돌로 멈춘 deferred 작업 오류에 사용자 stash와 undo 브랜치 정보를 보존한다.
   * @param error 원래 Git 오류
   * @param preserved 복원하지 못한 사용자 stash
   * @param undoBranch snapshot이 속한 브랜치
   */
  private withPreservedStashNotice(
    error: unknown,
    preserved: PreservedLocalChanges | undefined,
    undoBranch?: string
  ): Error {
    const base =
      error instanceof Error ? error : new Error(String(error));
    if (undoBranch) {
      (base as Error & { undoBranch?: string }).undoBranch = undoBranch;
    }
    if (!preserved) {
      return base;
    }
    const next = new Error(
      `${gitErrorText(error)}\nLocal changes were preserved in stash ${preserved.hash}.`
    );
    if (undoBranch) {
      (next as Error & { undoBranch?: string }).undoBranch = undoBranch;
    }
    return next;
  }
}

/** GitError의 stderr/stdout을 보존해 사용자에게 재현 가능한 오류 문자열을 제공한다. */
function gitErrorText(error: unknown): string {
  if (error instanceof GitError) {
    return [error.stderr.trim(), error.stdout.trim(), error.message]
      .filter(Boolean)
      .join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}
