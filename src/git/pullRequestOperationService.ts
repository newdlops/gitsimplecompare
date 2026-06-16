// PR 단위 cherry-pick/rebase 작업을 담당하는 서비스.
// - graph UI 는 확인과 결과 안내만 하고, 실제 git 상태 변경은 이 모듈로 모은다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { detectOperation, type MergeOperation } from "./conflictService";
import {
  restorePendingDeferredCommitRebaseLocalChangesForBranch,
  runDeferredCommitRebase,
} from "./deferredCommitRebase";
import { GitError, runGit } from "./gitExec";
import {
  PULL_REQUEST_OPERATION_COMMANDS,
  createSnapshotSnowflake,
  legacySnapshotRefForBranch,
  pullRequestCommitHashes,
  pullRequestRevertCommitHashes,
  snapshotRefForCommand,
  snapshotRefForCommandSnowflake,
  snapshotRefForBranch,
  squashBody,
  squashRevertBody,
  squashRevertTitle,
  squashTitle,
  type PullRequestOperationCommand,
} from "./pullRequestOperationFormat";
import { restorePendingPullRequestLocalChangesForBranch } from "./pullRequestRebaseContinuation";
import type { PullRequestInfo } from "./pullRequestService";
import { pushPreservedLocalChangesStash, runStash } from "./stashExec";
import { createPrOperationWorktree, removeTemporaryWorktree } from "./temporaryWorktree";

/** PR 작업 실행 결과와 undo 에 필요한 snapshot 정보 */
export interface PullRequestOperationResult {
  status: "completed" | "conflicts";
  branch: string;
  beforeHead: string;
  afterHead: string;
  snapshotRef: string;
  sourceBranch?: string;
  preservedStashHash?: string;
}

/** PR 작업 undo 결과 */
export interface PullRequestOperationUndoResult {
  branch: string;
  restoredHead: string;
}

interface PreservedLocalChanges {
  hash: string;
}

export interface PullRequestOperationOptions {
  strategy?: "auto" | "worktree";
}

/** PR 단위 git 작업 서비스 */
export class PullRequestOperationService {
  constructor(public readonly repoRoot: string) {}

  /**
   * PR 의 commit 목록을 현재 브랜치에 하나의 squash commit 으로 적용한다.
   * - undo 를 위해 현재 브랜치 HEAD 를 refs/gitsimplecompare/pr-operations 아래에 저장한다.
   * - 로컬 변경이 있으면 임시 worktree 에서 squash commit 을 만든 뒤 reset --keep 으로 안전하게 가져온다.
   * @param pr graph 에서 선택된 PR 정보
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
    await this.assertReadyForPrOperation();
    const branch = await this.currentBranch();
    const beforeHead = await this.currentHead();
    if (options?.strategy === "worktree" || await this.hasLocalChanges()) {
      return this.squashCherryPickWithLocalChanges(pr, commits, branch, beforeHead);
    }
    const snapshotRef = await this.createSnapshot(branch, beforeHead, "squash");
    try {
      await runGit(["cherry-pick", "--no-commit", ...commits], this.repoRoot);
      if (!await this.hasPendingChanges()) {
        throw new Error(`PR #${pr.number} did not produce changes to commit.`);
      }
      await runGit(["add", "-A"], this.repoRoot);
      await this.commitSquash(pr, this.repoRoot);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    return { status: "completed", branch, beforeHead, afterHead: await this.currentHead(), snapshotRef };
  }

  /**
   * PR commit 범위를 현재 브랜치 HEAD 위에 재적용한다.
   * - 충돌 없는 커밋을 먼저 cherry-pick 하고, 충돌 커밋은 마지막 큐로 미뤄 Conflicts 뷰에 노출한다.
   * @param pr graph 에서 선택된 PR 정보
   * @returns undo 가능한 작업 결과 또는 충돌 대기 상태
   */
  async rebasePullRequest(
    pr: PullRequestInfo,
    options?: PullRequestOperationOptions
  ): Promise<PullRequestOperationResult> {
    const commits = pullRequestCommitHashes(pr);
    if (!commits.length) {
      throw new Error(`PR #${pr.number} has no commit hashes to rebase.`);
    }
    await this.assertReadyForPrOperation();
    const destinationBranch = await this.currentBranch();
    const beforeHead = await this.currentHead();
    if (options?.strategy === "worktree" || await this.hasLocalChanges()) {
      return this.rebasePullRequestWithLocalChanges(pr, commits, destinationBranch, beforeHead);
    }
    const snapshotRef = await this.createSnapshot(destinationBranch, beforeHead, "rebase");
    const preserved = await this.preserveLocalChanges(`before PR #${pr.number} rebase`);
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
    } catch (err) {
      const restored = await this.restoreAfterFailedDeferredRebase(
        preserved,
        destinationBranch,
        snapshotRef,
        "PR rebase merge failed, but local changes could not be restored."
      );
      if (restored) {
        await this.deleteSnapshotRef(destinationBranch, snapshotRef);
      }
      throw this.withPreservedStashNotice(
        err,
        restored ? undefined : preserved,
        destinationBranch
      );
    }
  }

  /**
   * PR commit 목록을 현재 브랜치에서 커밋별 revert commit 으로 되돌린다.
   * - revert 는 히스토리 역순으로 수행해야 하므로 PR commit 목록을 최신→오래된 순서로 적용한다.
   * @param pr graph 에서 선택된 PR 정보
   * @returns undo 가능한 작업 결과 또는 충돌 대기 상태
   */
  async rebaseRevertPullRequest(
    pr: PullRequestInfo,
    options?: PullRequestOperationOptions
  ): Promise<PullRequestOperationResult> {
    const commits = pullRequestRevertCommitHashes(pr);
    if (!commits.length) {
      throw new Error(`PR #${pr.number} has no commit hashes to revert.`);
    }
    await this.assertReadyForPrOperation();
    const destinationBranch = await this.currentBranch();
    const beforeHead = await this.currentHead();
    await this.assertSupportedPullRequestRevertCommits(pr, commits);
    if (options?.strategy === "worktree" || await this.hasLocalChanges()) {
      return this.rebaseRevertPullRequestWithLocalChanges(pr, commits, destinationBranch, beforeHead);
    }
    const snapshotRef = await this.createSnapshot(destinationBranch, beforeHead, "rebaseRevert");
    const preserved = await this.preserveLocalChanges(`before PR #${pr.number} rebase revert`);
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
    } catch (err) {
      const restored = await this.restoreAfterFailedDeferredRebase(
        preserved,
        destinationBranch,
        snapshotRef,
        "PR rebase revert failed, but local changes could not be restored."
      );
      if (restored) {
        await this.deleteSnapshotRef(destinationBranch, snapshotRef);
      }
      throw this.withPreservedStashNotice(
        err,
        restored ? undefined : preserved,
        destinationBranch
      );
    }
  }

  /**
   * PR commit 목록을 현재 브랜치에서 하나의 squash revert commit 으로 되돌린다.
   * @param pr graph 에서 선택된 PR 정보
   * @returns undo 가능한 작업 결과 또는 충돌 대기 상태
   */
  async squashRevertPullRequest(
    pr: PullRequestInfo,
    options?: PullRequestOperationOptions
  ): Promise<PullRequestOperationResult> {
    const commits = pullRequestRevertCommitHashes(pr);
    if (!commits.length) {
      throw new Error(`PR #${pr.number} has no commit hashes to revert.`);
    }
    await this.assertReadyForPrOperation();
    const branch = await this.currentBranch();
    const beforeHead = await this.currentHead();
    await this.assertSupportedPullRequestRevertCommits(pr, commits);
    if (options?.strategy === "worktree" || await this.hasLocalChanges()) {
      return this.squashRevertWithLocalChanges(pr, commits, branch, beforeHead);
    }
    const snapshotRef = await this.createSnapshot(branch, beforeHead, "squashRevert");
    try {
      await this.applySquashRevert(commits, this.repoRoot);
      if (!await this.hasPendingChanges()) {
        throw new Error(`PR #${pr.number} did not produce changes to commit.`);
      }
      await runGit(["add", "-A"], this.repoRoot);
      await this.commitSquashRevert(pr, this.repoRoot);
      return {
        status: "completed",
        branch,
        beforeHead,
        afterHead: await this.currentHead(),
        snapshotRef,
        sourceBranch: pr.headRefName || pr.headHash,
      };
    } catch (err) {
      if (await this.hasUnmergedChanges()) {
        return {
          status: "conflicts",
          branch,
          beforeHead,
          afterHead: beforeHead,
          snapshotRef,
          sourceBranch: pr.headRefName || pr.headHash,
        };
      }
      await this.deleteSnapshotRef(branch, snapshotRef);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * 현재 브랜치의 마지막 PR 작업을 시작 전 snapshot 으로 되돌린다.
   * - rebase/cherry-pick 이 충돌로 멈춘 경우에는 먼저 해당 작업을 abort 한다.
   * - 사용자의 unstaged/staged 변경을 덮을 수 있으면 reset --keep 이 중단하므로 snapshot 을 남긴다.
   * @returns 복원된 브랜치와 HEAD
   */
  async undoLastOperation(branchName?: string): Promise<PullRequestOperationUndoResult> {
    const branch = branchName || await this.currentBranchForUndo();
    const snapshotRef = await this.latestSnapshotRefForBranch(branch);
    const restoredHead = await this.resolveSnapshot(snapshotRef);
    const operation = await this.assertReadyForUndo();
    const currentBranch = await this.currentBranch().catch(() => "");
    if (branch !== currentBranch) {
      if (operation !== "none") {
        await this.abortOperationIfNeeded(operation);
        if (await this.currentBranch().catch(() => "") !== branch) {
          await this.switchToBranch(branch);
        }
        await this.resetCurrentBranchToSnapshot(snapshotRef);
        await restorePendingPullRequestLocalChangesForBranch(
          this.repoRoot,
          branch,
          "PR operation was undone, but preserved local changes could not be restored."
        );
        await restorePendingDeferredCommitRebaseLocalChangesForBranch(
          this.repoRoot,
          branch,
          "PR operation was undone, but preserved local changes could not be restored."
        );
        await this.deleteSnapshotRef(branch, snapshotRef);
        return { branch, restoredHead };
      }
      await this.updateBranchRef(branch, snapshotRef);
      await this.deleteSnapshotRef(branch, snapshotRef);
      return { branch, restoredHead };
    }
    await this.abortOperationIfNeeded(operation);
    await this.resetCurrentBranchToSnapshot(snapshotRef);
    await restorePendingPullRequestLocalChangesForBranch(
      this.repoRoot,
      branch,
      "PR operation was undone, but preserved local changes could not be restored."
    );
    await restorePendingDeferredCommitRebaseLocalChangesForBranch(
      this.repoRoot,
      branch,
      "PR operation was undone, but preserved local changes could not be restored."
    );
    await this.deleteSnapshotRef(branch, snapshotRef);
    return { branch, restoredHead };
  }

  /**
   * 현재 브랜치에 undo snapshot 이 있는지 확인한다.
   * - preflight 단계에서 실패한 작업은 snapshot 이 없으므로 UI 에 불필요한 undo 버튼을 띄우지 않는다.
   */
  async hasUndoSnapshot(branchName?: string): Promise<boolean> {
    const branch = branchName || await this.currentBranchForUndo().catch(() => "");
    if (!branch) {
      return false;
    }
    return Boolean(await this.latestSnapshotRefForBranch(branch).catch(() => ""));
  }

  /**
   * PR revert 대상 커밋 중 현재 HEAD 히스토리에 포함되지 않은 커밋 수를 센다.
   * - 사용자는 이런 PR 도 revert 할 수 있지만, inverse patch 를 현재 브랜치에 적용한다는 경고가 필요하다.
   * @param pr graph 에서 선택된 PR 정보
   */
  async countRevertCommitsOutsideCurrentBranch(pr: PullRequestInfo): Promise<number> {
    const commits = pullRequestRevertCommitHashes(pr);
    let count = 0;
    for (const commit of commits) {
      const normalized = await this.normalizeCommit(commit);
      if (!await this.isAncestor(normalized, "HEAD")) {
        count++;
      }
    }
    return count;
  }

  /** PR 작업 전 진행 중인 git 작업과 로컬 변경이 없는지 확인한다. */
  private async assertReadyForPrOperation(): Promise<void> {
    const operation = await detectOperation(this.repoRoot);
    if (operation !== "none") {
      throw new Error(`Cannot start PR operation while ${operation} is in progress.`);
    }
    await this.assertNoUnmergedChanges();
  }

  /** PR undo 가 사용자의 새 로컬 변경이나 무관한 git 작업을 덮어쓰지 않는지 확인한다. */
  private async assertReadyForUndo(): Promise<MergeOperation> {
    const operation = await detectOperation(this.repoRoot);
    if (operation === "merge" || operation === "revert") {
      throw new Error(`Cannot undo PR operation while ${operation} is in progress.`);
    }
    if (operation === "none") {
      await this.assertNoUnmergedChanges();
    }
    return operation;
  }

  /** merge 상태가 아닌 unmerged 파일은 stash 로 보존할 수 없으므로 PR 작업 전에 차단한다. */
  private async assertNoUnmergedChanges(): Promise<void> {
    if (await this.hasUnmergedChanges()) {
      throw new Error("Resolve unmerged files before running a PR operation.");
    }
  }

  /** 현재 작업트리나 index 에 커밋되지 않은 변경이 있는지 확인한다. */
  private async hasLocalChanges(): Promise<boolean> {
    return (await runGit(["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z"], this.repoRoot)).length > 0;
  }

  /** index 에 unmerged 상태로 남은 파일이 있는지 확인한다. */
  private async hasUnmergedChanges(): Promise<boolean> {
    return (await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], this.repoRoot)).length > 0;
  }

  /** squash cherry-pick 후 commit 할 변경이 있는지 확인한다. */
  private async hasPendingChanges(): Promise<boolean> {
    const staged = await runGit(["diff", "--cached", "--quiet"], this.repoRoot).then(() => false, () => true);
    const unstaged = await runGit(["diff", "--quiet"], this.repoRoot).then(() => false, () => true);
    return staged || unstaged;
  }

  /**
   * 입력 ref 가 실제 commit 인지 검증하고 전체 해시로 정규화한다.
   * @param hash 커밋으로 해석할 ref/hash
   */
  private async normalizeCommit(hash: string): Promise<string> {
    return (await runGit(["rev-parse", "--verify", `${hash}^{commit}`], this.repoRoot)).trim();
  }

  /**
   * 지정 커밋의 부모 해시 목록을 반환한다.
   * @param hash 대상 커밋 해시
   */
  private async commitParents(hash: string): Promise<string[]> {
    const out = await runGit(["show", "-s", "--pretty=%P", hash], this.repoRoot);
    return out.trim().split(/\s+/).filter(Boolean);
  }

  /**
   * ancestor 가 target 의 조상인지 확인한다.
   * @param ancestor 조상이어야 하는 커밋
   * @param target   기준 커밋/ref
   */
  private async isAncestor(ancestor: string, target: string): Promise<boolean> {
    try {
      await runGit(["merge-base", "--is-ancestor", ancestor, target], this.repoRoot);
      return true;
    } catch {
      return false;
    }
  }

  /** 현재 로컬 브랜치 이름을 반환한다. detached HEAD 는 PR 작업 대상에서 제외한다. */
  private async currentBranch(): Promise<string> {
    const branch = (await runGit(["symbolic-ref", "--short", "HEAD"], this.repoRoot).catch(() => "")).trim();
    if (!branch) {
      throw new Error("PR operations require a checked-out local branch.");
    }
    return branch;
  }

  /** undo 대상 브랜치를 반환한다. rebase 중 detached HEAD 로 보이면 rebase 메타데이터를 사용한다. */
  private async currentBranchForUndo(): Promise<string> {
    const branch = await this.currentBranch().catch(() => "");
    if (branch) {
      return branch;
    }
    const operation = await detectOperation(this.repoRoot);
    if (operation === "rebase") {
      const rebaseBranch = await this.currentRebaseBranch();
      if (rebaseBranch) {
        return rebaseBranch;
      }
    }
    throw new Error("PR operation undo requires a checked-out local branch.");
  }

  /** 진행 중인 rebase 의 원래 branch 이름을 git rebase 상태 파일에서 읽는다. */
  private async currentRebaseBranch(): Promise<string | undefined> {
    const gitDirRaw = (await runGit(["rev-parse", "--git-dir"], this.repoRoot)).trim();
    const gitDir = path.resolve(this.repoRoot, gitDirRaw);
    for (const file of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
      const raw = await fs.readFile(path.join(gitDir, file), "utf8").catch(() => "");
      const branch = raw.trim().replace(/^refs\/heads\//, "");
      if (branch) {
        return branch;
      }
    }
    return undefined;
  }

  /** 지정한 로컬 브랜치로 working tree 를 전환한다. */
  private async switchToBranch(branch: string): Promise<void> {
    if (await this.currentBranch().catch(() => "") === branch) {
      return;
    }
    await runGit(["switch", branch], this.repoRoot);
  }

  /** 현재 checkout 되지 않은 로컬 브랜치를 snapshot commit 으로 되돌린다. */
  private async updateBranchRef(branch: string, ref: string): Promise<void> {
    await runGit(["update-ref", `refs/heads/${branch}`, ref], this.repoRoot);
  }

  /** 현재 HEAD commit hash 를 반환한다. */
  private async currentHead(): Promise<string> {
    return (await runGit(["rev-parse", "--verify", "HEAD"], this.repoRoot)).trim();
  }

  /** 현재 브랜치와 PR command 용 undo snapshot ref 를 생성한다. */
  private async createSnapshot(
    branch: string,
    head: string,
    command: PullRequestOperationCommand
  ): Promise<string> {
    const snowflake = createSnapshotSnowflake();
    const snapshotRef = snapshotRefForCommandSnowflake(branch, command, snowflake);
    try {
      await runGit(["update-ref", snapshotRef, head], this.repoRoot);
      await this.updateLatestSnapshotRef(snapshotRefForCommand(branch, command), snapshotRef);
      await this.updateLatestSnapshotRef(snapshotRefForBranch(branch), snapshotRef);
      return snapshotRef;
    } catch (err) {
      await this.deleteSnapshotRef(branch, snapshotRef);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** latest 포인터 ref 가 특정 snowflake snapshot 을 바라보게 갱신한다. */
  private async updateLatestSnapshotRef(latestRef: string, snapshotRef: string): Promise<void> {
    await runGit(["symbolic-ref", latestRef, snapshotRef], this.repoRoot);
  }

  /** 브랜치의 최신 PR operation snapshot ref 를 찾는다. */
  private async latestSnapshotRefForBranch(branch: string): Promise<string> {
    const branchLatest = await this.resolvedSnapshotRef(snapshotRefForBranch(branch));
    if (branchLatest) {
      return branchLatest;
    }
    const commandLatest = (
      await Promise.all(
        PULL_REQUEST_OPERATION_COMMANDS.map(async (command) => {
          const ref = await this.resolvedSnapshotRef(snapshotRefForCommand(branch, command));
          return ref ? { ref, sortKey: snapshotSortKey(ref) } : undefined;
        })
      )
    )
      .filter((item): item is { ref: string; sortKey: string } => Boolean(item))
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey))[0];
    if (commandLatest) {
      return commandLatest.ref;
    }
    const legacyRef = await this.resolvedSnapshotRef(legacySnapshotRefForBranch(branch));
    if (legacyRef) {
      return legacyRef;
    }
    throw new Error("No PR operation snapshot is available for the current branch.");
  }

  /** symbolic latest ref 를 실제 snapshot ref 로 풀고, commit 으로 유효한 경우만 반환한다. */
  private async resolvedSnapshotRef(ref: string): Promise<string | undefined> {
    const target = await this.symbolicRefTarget(ref);
    const snapshotRef = target || ref;
    return await this.resolveSnapshot(snapshotRef).then(() => snapshotRef, () => undefined);
  }

  /** symbolic ref 의 target 을 반환한다. 일반 ref 이거나 없으면 undefined 를 반환한다. */
  private async symbolicRefTarget(ref: string): Promise<string | undefined> {
    const target = (await runGit(["symbolic-ref", "-q", ref], this.repoRoot).catch(() => "")).trim();
    return target || undefined;
  }

  /** snapshot target 과 그 target 을 바라보는 latest 포인터를 정리한다. */
  private async deleteSnapshotRef(branch: string, snapshotRef: string): Promise<void> {
    await this.deleteLatestSnapshotRefIfTarget(snapshotRefForBranch(branch), snapshotRef);
    await Promise.all(
      PULL_REQUEST_OPERATION_COMMANDS.map((command) =>
        this.deleteLatestSnapshotRefIfTarget(snapshotRefForCommand(branch, command), snapshotRef)
      )
    );
    await runGit(["update-ref", "-d", snapshotRef], this.repoRoot).catch(() => "");
  }

  /** latest symbolic ref 가 지정 snapshot target 을 바라볼 때만 latest ref 를 삭제한다. */
  private async deleteLatestSnapshotRefIfTarget(latestRef: string, snapshotRef: string): Promise<void> {
    if (await this.symbolicRefTarget(latestRef) === snapshotRef) {
      await runGit(["symbolic-ref", "-d", latestRef], this.repoRoot).catch(() => "");
    }
  }

  /** undo snapshot ref 가 실제 commit 으로 존재하는지 확인한다. */
  private async resolveSnapshot(ref: string): Promise<string> {
    const hash = (await runGit(["rev-parse", "--verify", `${ref}^{commit}`], this.repoRoot).catch(() => "")).trim();
    if (!hash) {
      throw new Error("No PR operation snapshot is available for the current branch.");
    }
    return hash;
  }

  /** 진행 중인 rebase/cherry-pick 류 작업이 있으면 undo 전에 중단한다. */
  private async abortOperationIfNeeded(operation: MergeOperation): Promise<void> {
    if (operation !== "none") {
      await runGit([operation, "--abort"], this.repoRoot);
    }
  }

  /** 현재 브랜치를 snapshot 으로 되돌리되 로컬 변경을 덮을 상황에서는 중단한다. */
  private async resetCurrentBranchToSnapshot(snapshotRef: string): Promise<void> {
    await this.resetCurrentBranchPreservingLocalChanges(
      snapshotRef,
      "PR operation undo would overwrite local changes, so it was stopped. " +
        "Commit or stash the local changes, then run undo again. " +
        `The undo snapshot was kept at ${snapshotRef}.`
    );
  }

  /** 현재 브랜치를 target ref 로 이동하되 로컬 변경을 덮을 상황에서는 중단한다. */
  private async resetCurrentBranchPreservingLocalChanges(
    targetRef: string,
    failureMessage: string
  ): Promise<void> {
    try {
      await runGit(["-c", "core.fsmonitor=false", "reset", "--keep", targetRef], this.repoRoot);
    } catch (err) {
      throw new Error(`${failureMessage} ${errText(err)}`);
    }
  }

  /** 로컬 변경이 있는 상태에서 PR squash commit 을 임시 worktree 로 계산해 현재 브랜치에 반영한다. */
  private async squashCherryPickWithLocalChanges(
    pr: PullRequestInfo,
    commits: string[],
    branch: string,
    beforeHead: string
  ): Promise<PullRequestOperationResult> {
    const worktreePath = await this.createTemporaryWorktree(beforeHead);
    let keepWorktree = false;
    let snapshotRef = "";
    try {
      try {
        await runGit(["cherry-pick", "--no-commit", ...commits], worktreePath);
      } catch (err) {
        if (await this.hasUnmergedChangesIn(worktreePath)) {
          keepWorktree = true;
          throw new Error(
            `PR #${pr.number} has cherry-pick conflicts. ` +
            "The current working tree was not changed. " +
            `Resolve the conflict in the preserved temporary worktree: ${worktreePath}. ${errText(err)}`
          );
        }
        throw err;
      }
      if (!await this.hasPendingChangesIn(worktreePath)) {
        throw new Error(`PR #${pr.number} did not produce changes to commit.`);
      }
      await runGit(["add", "-A"], worktreePath);
      await this.commitSquash(pr, worktreePath);
      const afterHead = await this.currentHeadIn(worktreePath);
      snapshotRef = await this.createSnapshot(branch, beforeHead, "squash");
      await this.assertStillOnBranch(branch);
      await this.resetCurrentBranchPreservingLocalChanges(
        afterHead,
        `PR #${pr.number} squash cherry-pick would overwrite local changes, so it was stopped. ` +
          `The undo snapshot was kept at ${snapshotRef}.`
      );
      return { status: "completed", branch, beforeHead, afterHead, snapshotRef };
    } catch (err) {
      if (snapshotRef) {
        await this.deleteSnapshotRef(branch, snapshotRef);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      if (!keepWorktree) {
        await this.removeTemporaryWorktree(worktreePath);
      }
    }
  }

  /** 로컬 변경이 있는 상태에서 PR squash revert 결과를 임시 worktree 로 계산해 현재 브랜치에 반영한다. */
  private async squashRevertWithLocalChanges(
    pr: PullRequestInfo,
    commits: string[],
    branch: string,
    beforeHead: string
  ): Promise<PullRequestOperationResult> {
    const worktreePath = await this.createTemporaryWorktree(beforeHead);
    let keepWorktree = false;
    let snapshotRef = "";
    try {
      try {
        await this.applySquashRevert(commits, worktreePath);
      } catch (err) {
        if (await this.hasUnmergedChangesIn(worktreePath)) {
          keepWorktree = true;
          throw new Error(
            `PR #${pr.number} has squash revert conflicts. ` +
            "The current working tree was not changed. " +
            `Resolve the conflict in the preserved temporary worktree: ${worktreePath}. ${errText(err)}`
          );
        }
        throw err;
      }
      if (!await this.hasPendingChangesIn(worktreePath)) {
        throw new Error(`PR #${pr.number} did not produce changes to commit.`);
      }
      await runGit(["add", "-A"], worktreePath);
      await this.commitSquashRevert(pr, worktreePath);
      const afterHead = await this.currentHeadIn(worktreePath);
      snapshotRef = await this.createSnapshot(branch, beforeHead, "squashRevert");
      await this.assertStillOnBranch(branch);
      await this.resetCurrentBranchPreservingLocalChanges(
        afterHead,
        `PR #${pr.number} squash revert would overwrite local changes, so it was stopped. ` +
          `The undo snapshot was kept at ${snapshotRef}.`
      );
      return {
        status: "completed",
        branch,
        beforeHead,
        afterHead,
        snapshotRef,
        sourceBranch: pr.headRefName || pr.headHash,
      };
    } catch (err) {
      if (snapshotRef) {
        await this.deleteSnapshotRef(branch, snapshotRef);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      if (!keepWorktree) {
        await this.removeTemporaryWorktree(worktreePath);
      }
    }
  }

  /** 로컬 변경이 있는 상태에서 PR rebase 결과를 임시 worktree 로 계산해 현재 브랜치에 반영한다. */
  private async rebasePullRequestWithLocalChanges(
    pr: PullRequestInfo,
    commits: string[],
    branch: string,
    beforeHead: string
  ): Promise<PullRequestOperationResult> {
    return this.replayPullRequestWithLocalChanges({
      pr,
      commits,
      branch,
      beforeHead,
      command: "rebase",
      operation: "cherry-pick",
      kind: "pr-rebase",
      actionLabel: "rebase",
      failureLabel: "rebase",
    });
  }

  /** 로컬 변경이 있는 상태에서 PR rebase revert 결과를 임시 worktree 로 계산해 현재 브랜치에 반영한다. */
  private async rebaseRevertPullRequestWithLocalChanges(
    pr: PullRequestInfo,
    commits: string[],
    branch: string,
    beforeHead: string
  ): Promise<PullRequestOperationResult> {
    return this.replayPullRequestWithLocalChanges({
      pr,
      commits,
      branch,
      beforeHead,
      command: "rebaseRevert",
      operation: "revert",
      kind: "pr-revert",
      actionLabel: "rebase revert",
      failureLabel: "rebase revert",
    });
  }

  /** 로컬 변경을 stash 하지 않고 임시 worktree 에서 PR 커밋 재생 결과를 만든다. */
  private async replayPullRequestWithLocalChanges(input: {
    pr: PullRequestInfo;
    commits: string[];
    branch: string;
    beforeHead: string;
    command: PullRequestOperationCommand;
    operation: "cherry-pick" | "revert";
    kind: "pr-rebase" | "pr-revert";
    actionLabel: string;
    failureLabel: string;
  }): Promise<PullRequestOperationResult> {
    const worktreePath = await this.createTemporaryWorktree(input.beforeHead);
    let keepWorktree = false;
    let snapshotRef = "";
    try {
      const result = await runDeferredCommitRebase({
        kind: input.kind,
        operation: input.operation === "revert" ? "revert" : undefined,
        label: `PR #${input.pr.number}${input.operation === "revert" ? " revert" : ""}`,
        repoRoot: worktreePath,
        commits: input.commits,
        destinationBranch: input.branch,
        beforeHead: input.beforeHead,
        snapshotRef: input.beforeHead,
        sourceRef: input.pr.headRefName || input.pr.headHash,
      });
      if (result.status === "conflicts") {
        keepWorktree = true;
        throw new Error(
          `PR #${input.pr.number} ${input.actionLabel} has conflicts. ` +
            "The current working tree was not changed because local changes are present. " +
            `Resolve or inspect the preserved temporary worktree: ${worktreePath}.`
        );
      }
      const afterHead = result.afterHead || await this.currentHeadIn(worktreePath);
      snapshotRef = await this.createSnapshot(input.branch, input.beforeHead, input.command);
      await this.assertStillOnBranch(input.branch);
      try {
        await this.resetCurrentBranchPreservingLocalChanges(
          afterHead,
          `PR #${input.pr.number} ${input.failureLabel} result could not be applied to the current working tree. ` +
            "The replayed result was preserved in a temporary worktree. " +
            `Temporary worktree: ${worktreePath}. ` +
            `The undo snapshot was kept at ${snapshotRef}.`
        );
      } catch (err) {
        keepWorktree = true;
        throw err;
      }
      return {
        status: "completed",
        branch: input.branch,
        beforeHead: input.beforeHead,
        afterHead,
        snapshotRef,
        sourceBranch: input.pr.headRefName || input.pr.headHash,
      };
    } catch (err) {
      if (snapshotRef && !keepWorktree) {
        await this.deleteSnapshotRef(input.branch, snapshotRef);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      if (!keepWorktree) {
        await this.removeTemporaryWorktree(worktreePath);
      }
    }
  }

  /** PR commit 목록을 현재 index/working tree 에 squash revert 형태로 적용한다. */
  private async applySquashRevert(commits: string[], cwd: string): Promise<void> {
    const env = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", HUSKY: "0" };
    for (const commit of commits) {
      try {
        await runGit(["revert", "--no-commit", commit], cwd, { env });
      } catch (err) {
        if (await this.hasUnmergedChangesIn(cwd)) {
          throw err;
        }
        if (isEmptyRevertError(err)) {
          await runGit(["revert", "--skip"], cwd, { env }).catch(() => undefined);
          await runGit(["revert", "--abort"], cwd, { env }).catch(() => undefined);
          continue;
        }
        throw err;
      }
    }
  }

  /** PR squash commit 을 만든다. 자동 작업이므로 pre-commit hook 은 실행하지 않는다. */
  private async commitSquash(pr: PullRequestInfo, cwd: string): Promise<void> {
    await runGit(
      ["commit", "--no-verify", "-m", squashTitle(pr), "-m", squashBody(pr)],
      cwd,
      { env: { GIT_EDITOR: "true", HUSKY: "0" } }
    );
  }

  /** PR squash revert commit 을 만든다. 자동 작업이므로 pre-commit hook 은 실행하지 않는다. */
  private async commitSquashRevert(pr: PullRequestInfo, cwd: string): Promise<void> {
    await runGit(
      ["commit", "--no-verify", "-m", squashRevertTitle(pr), "-m", squashRevertBody(pr)],
      cwd,
      { env: { GIT_EDITOR: "true", HUSKY: "0" } }
    );
  }

  /**
   * PR revert 대상 커밋들이 자동 revert 가능한 형태인지 확인한다.
   * @param pr 작업 대상 PR 정보
   * @param commits revert 적용 순서의 커밋 해시 목록
   */
  private async assertSupportedPullRequestRevertCommits(
    pr: PullRequestInfo,
    commits: string[]
  ): Promise<void> {
    for (const commit of commits) {
      const normalized = await this.normalizeCommit(commit);
      const parents = await this.commitParents(normalized);
      if (parents.length > 1) {
        throw new Error(
          `PR #${pr.number} contains merge commit ${shortHash(normalized)}. Revert merge commits one by one.`
        );
      }
    }
  }

  /** PR 작업 도중 사용자가 다른 브랜치로 이동했으면 현재 브랜치 갱신을 중단한다. */
  private async assertStillOnBranch(branch: string): Promise<void> {
    const current = await this.currentBranch();
    if (current !== branch) {
      throw new Error(`Current branch changed from '${branch}' to '${current}' while PR operation was running.`);
    }
  }

  /** 임시 worktree 를 만들어 더러운 작업트리를 건드리지 않고 PR 적용 결과를 계산한다. */
  private async createTemporaryWorktree(startPoint: string): Promise<string> {
    return createPrOperationWorktree(this.repoRoot, startPoint);
  }

  /** 임시 worktree 를 제거한다. 제거 실패 시 남은 디렉터리만 한 번 더 정리한다. */
  private async removeTemporaryWorktree(worktreePath: string): Promise<void> {
    await removeTemporaryWorktree(this.repoRoot, worktreePath);
  }

  /** 지정한 worktree 의 HEAD commit hash 를 반환한다. */
  private async currentHeadIn(cwd: string): Promise<string> {
    return (await runGit(["rev-parse", "--verify", "HEAD"], cwd)).trim();
  }

  /** 지정한 worktree 에 commit 할 변경이 있는지 확인한다. */
  private async hasPendingChangesIn(cwd: string): Promise<boolean> {
    const staged = await runGit(["diff", "--cached", "--quiet"], cwd).then(() => false, () => true);
    const unstaged = await runGit(["diff", "--quiet"], cwd).then(() => false, () => true);
    return staged || unstaged;
  }

  /** 지정한 worktree 에 충돌로 남은 unmerged index entry 가 있는지 확인한다. */
  private async hasUnmergedChangesIn(cwd: string): Promise<boolean> {
    return (await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], cwd).catch(() => "")).length > 0;
  }

  /** 로컬 변경을 임시 stash 로 보존해 PR 작업이 clean tree 에서 시작되도록 한다. */
  private async preserveLocalChanges(reason: string): Promise<PreservedLocalChanges | undefined> {
    if (!await this.hasLocalChanges()) {
      return undefined;
    }
    return pushPreservedLocalChangesStash(this.repoRoot, `Git Simple Compare ${reason}`);
  }

  /** 보존해 둔 로컬 변경을 다시 적용하고 stash 목록에서 제거한다. */
  private async restorePreservedLocalChanges(
    preserved: PreservedLocalChanges | undefined,
    failureMessage: string
  ): Promise<void> {
    if (!preserved) {
      return;
    }
    try {
      await runStash(["apply", preserved.hash], this.repoRoot);
      await this.dropStash(preserved.hash);
    } catch (err) {
      const ref = await this.findStashRef(preserved.hash);
      throw new Error(`${failureMessage} Preserved stash: ${ref ?? preserved.hash}. ${errText(err)}`);
    }
  }

  /** deferred rebase 시작 중 예상치 못하게 실패하면 snapshot 으로 되돌리고 보존 stash 를 복원한다. */
  private async restoreAfterFailedDeferredRebase(
    preserved: PreservedLocalChanges | undefined,
    branch: string,
    snapshotRef: string,
    restoreFailureMessage: string
  ): Promise<boolean> {
    if (await detectOperation(this.repoRoot) !== "none") {
      return false;
    }
    await this.switchToBranch(branch);
    await runGit(["reset", "--hard", snapshotRef], this.repoRoot);
    if (preserved) {
      await this.restorePreservedLocalChanges(
        preserved,
        restoreFailureMessage
      );
    }
    return true;
  }

  /** 충돌로 멈춘 PR 작업에서는 사용자의 원래 변경이 어느 stash 에 보존됐는지 오류에 덧붙인다. */
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
    const message = errText(err);
    const next = new Error(`${message}\nLocal changes were preserved in stash ${preserved.hash}.`);
    if (undoBranch) {
      (next as Error & { undoBranch?: string }).undoBranch = undoBranch;
    }
    return next;
  }

  /** stash commit hash 에 대응하는 stash@{n} 참조를 찾는다. */
  private async findStashRef(hash: string): Promise<string | undefined> {
    const list = await runStash(["list", "--format=%gd%x00%H"], this.repoRoot).catch(() => "");
    for (const line of list.split(/\r?\n/)) {
      const [ref, itemHash] = line.split("\0");
      if (itemHash === hash) {
        return ref;
      }
    }
    return undefined;
  }

  /** 지정한 stash commit 을 stash 목록에서 제거한다. */
  private async dropStash(hash: string): Promise<void> {
    const ref = await this.findStashRef(hash);
    if (ref) {
      await runStash(["drop", ref], this.repoRoot);
    }
  }
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

/** 긴 커밋 해시를 UI/오류 표시용으로 줄인다. */
function shortHash(hash: string): string {
  return hash.slice(0, 10);
}

/** snapshot ref 의 snowflake 부분을 최신순 정렬 키로 사용한다. */
function snapshotSortKey(ref: string): string {
  return ref.split("/").pop() || "";
}

/** git revert 가 적용할 변경이 없어서 실패했는지 확인한다. */
function isEmptyRevertError(err: unknown): boolean {
  const text =
    err instanceof GitError
      ? `${err.message}\n${err.stderr}\n${err.stdout}`
      : err instanceof Error
        ? err.message
        : String(err);
  return /nothing to commit|nothing added to commit|empty|patch contents already upstream/i.test(text);
}
