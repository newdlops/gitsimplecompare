// PR 작업의 브랜치 상태 검사, undo snapshot, 안전한 reset을 담당하는 Git snapshot 모듈.
// - 실제 cherry-pick/revert 조립과 분리해 snapshot 생명주기를 다른 PR 작업에서도 재사용한다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { detectOperation, type MergeOperation } from "./conflictService";
import { restorePendingDeferredCommitRebaseLocalChangesForBranch } from "./deferredCommitRebase";
import { GitError, runGit } from "./gitExec";
import {
  PULL_REQUEST_OPERATION_COMMANDS,
  createSnapshotSnowflake,
  legacySnapshotRefForBranch,
  snapshotRefForBranch,
  snapshotRefForCommand,
  snapshotRefForCommandSnowflake,
  type PullRequestOperationCommand,
} from "./pullRequestOperationFormat";
import { restorePendingPullRequestLocalChangesForBranch } from "./pullRequestRebaseContinuation";
import { assertCurrentBranchHead, assertTargetDescendsFrom } from "./refSafety";

/** PR 작업 undo가 복원한 브랜치와 commit */
export interface PullRequestOperationUndoResult {
  branch: string;
  restoredHead: string;
}

/**
 * PR 작업 전후의 repository 상태와 snapshot ref를 관리한다.
 * 작업 내용 생성은 담당하지 않고, 브랜치 이동과 사용자 변경 보호 규칙만 한곳에서 강제한다.
 */
export class PullRequestOperationSnapshot {
  constructor(public readonly repoRoot: string) {}

  /**
   * PR 작업 전 진행 중인 Git operation과 unmerged index가 없는지 확인한다.
   * 일반 staged/unstaged 변경은 임시 worktree 경로로 처리하므로 여기서 차단하지 않는다.
   */
  async assertReadyForPrOperation(): Promise<void> {
    const operation = await detectOperation(this.repoRoot);
    if (operation !== "none") {
      throw new Error(`Cannot start PR operation while ${operation} is in progress.`);
    }
    await this.assertNoUnmergedChanges();
  }

  /**
   * 현재 작업트리나 index에 커밋되지 않은 변경이 있는지 확인한다.
   * fsmonitor daemon 상태와 무관한 정확한 결과를 위해 이 명령에서만 fsmonitor를 끈다.
   */
  async hasLocalChanges(): Promise<boolean> {
    const output = await runGit(
      ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z"],
      this.repoRoot
    );
    return output.length > 0;
  }

  /** 현재 index에 unmerged entry가 하나라도 있으면 true를 반환한다. */
  async hasUnmergedChanges(): Promise<boolean> {
    const output = await runGit(
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      this.repoRoot
    );
    return output.length > 0;
  }

  /**
   * 현재 index 또는 working tree에 commit할 변경이 있는지 확인한다.
   * `git diff --quiet`의 exit code 1은 오류가 아니라 차이가 있다는 의미로 변환한다.
   */
  async hasPendingChanges(): Promise<boolean> {
    const staged = await runGit(
      ["diff", "--cached", "--quiet"],
      this.repoRoot
    ).then(() => false, () => true);
    const unstaged = await runGit(
      ["diff", "--quiet"],
      this.repoRoot
    ).then(() => false, () => true);
    return staged || unstaged;
  }

  /**
   * 지정 worktree의 index 또는 working tree에 commit할 변경이 있는지 확인한다.
   * @param cwd 임시 worktree 경로
   */
  async hasPendingChangesIn(cwd: string): Promise<boolean> {
    const staged = await runGit(
      ["diff", "--cached", "--quiet"],
      cwd
    ).then(() => false, () => true);
    const unstaged = await runGit(
      ["diff", "--quiet"],
      cwd
    ).then(() => false, () => true);
    return staged || unstaged;
  }

  /**
   * 지정 worktree에 충돌로 남은 unmerged index entry가 있는지 확인한다.
   * 조회 자체가 실패하면 충돌로 단정하지 않고 false를 반환해 원래 Git 오류를 유지한다.
   * @param cwd 임시 worktree 경로
   */
  async hasUnmergedChangesIn(cwd: string): Promise<boolean> {
    const output = await runGit(
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      cwd
    ).catch(() => "");
    return output.length > 0;
  }

  /**
   * 현재 checkout된 로컬 브랜치 이름을 반환한다.
   * detached HEAD는 PR 작업 대상이 아니므로 사용자에게 명확한 오류를 제공한다.
   */
  async currentBranch(): Promise<string> {
    const branch = await runGit(
      ["symbolic-ref", "--short", "HEAD"],
      this.repoRoot
    ).catch(() => "");
    if (!branch.trim()) {
      throw new Error("PR operations require a checked-out local branch.");
    }
    return branch.trim();
  }

  /** 현재 HEAD를 전체 commit hash로 반환한다. */
  async currentHead(): Promise<string> {
    return (await runGit(
      ["rev-parse", "--verify", "HEAD"],
      this.repoRoot
    )).trim();
  }

  /**
   * 지정 worktree의 HEAD를 전체 commit hash로 반환한다.
   * @param cwd 임시 worktree 경로
   */
  async currentHeadIn(cwd: string): Promise<string> {
    return (await runGit(["rev-parse", "--verify", "HEAD"], cwd)).trim();
  }

  /**
   * 현재 브랜치 HEAD를 PR command용 immutable snapshot과 latest 포인터에 저장한다.
   * 세 포인터 중 하나라도 실패하면 만들어진 snapshot을 정리해 반쪽 상태를 남기지 않는다.
   * @param branch snapshot 소유 브랜치
   * @param head 작업 시작 전 HEAD
   * @param command snapshot을 만든 PR 작업 종류
   */
  async createSnapshot(
    branch: string,
    head: string,
    command: PullRequestOperationCommand
  ): Promise<string> {
    const snowflake = createSnapshotSnowflake();
    const snapshotRef = snapshotRefForCommandSnowflake(branch, command, snowflake);
    try {
      await runGit(["update-ref", snapshotRef, head], this.repoRoot);
      await this.updateLatestSnapshotRef(
        snapshotRefForCommand(branch, command),
        snapshotRef
      );
      await this.updateLatestSnapshotRef(snapshotRefForBranch(branch), snapshotRef);
      return snapshotRef;
    } catch (error) {
      await this.deleteSnapshotRef(branch, snapshotRef);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * snapshot target과 그 target을 가리키는 latest 포인터를 함께 삭제한다.
   * 다른 최신 작업을 가리키도록 이미 갱신된 포인터는 건드리지 않는다.
   * @param branch snapshot 소유 브랜치
   * @param snapshotRef 삭제할 immutable snapshot ref
   */
  async deleteSnapshotRef(branch: string, snapshotRef: string): Promise<void> {
    await this.deleteLatestSnapshotRefIfTarget(
      snapshotRefForBranch(branch),
      snapshotRef
    );
    await Promise.all(
      PULL_REQUEST_OPERATION_COMMANDS.map((command) =>
        this.deleteLatestSnapshotRefIfTarget(
          snapshotRefForCommand(branch, command),
          snapshotRef
        )
      )
    );
    await runGit(["update-ref", "-d", snapshotRef], this.repoRoot).catch(() => "");
  }

  /**
   * 현재 브랜치의 마지막 PR 작업을 시작 전 snapshot으로 되돌린다.
   * 진행 중인 rebase/cherry-pick은 먼저 abort하고, 보존 stash도 해당 브랜치에 복원한다.
   * @param branchName detached rebase 등에서 호출자가 알고 있는 대상 브랜치
   * @returns 복원된 브랜치와 HEAD
   */
  async undoLastOperation(
    branchName?: string
  ): Promise<PullRequestOperationUndoResult> {
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
        await this.restorePendingLocalChanges(branch);
        await this.deleteSnapshotRef(branch, snapshotRef);
        return { branch, restoredHead };
      }
      await this.updateBranchRef(branch, snapshotRef);
      await this.deleteSnapshotRef(branch, snapshotRef);
      return { branch, restoredHead };
    }
    await this.abortOperationIfNeeded(operation);
    await this.resetCurrentBranchToSnapshot(snapshotRef);
    await this.restorePendingLocalChanges(branch);
    await this.deleteSnapshotRef(branch, snapshotRef);
    return { branch, restoredHead };
  }

  /**
   * 현재 또는 지정 브랜치에 유효한 undo snapshot이 있는지 확인한다.
   * preflight에서 실패해 snapshot을 만들지 않은 작업은 false로 반환한다.
   * @param branchName 확인할 브랜치. 생략하면 현재/진행 중 rebase 브랜치를 찾는다.
   */
  async hasUndoSnapshot(branchName?: string): Promise<boolean> {
    const branch = branchName || await this.currentBranchForUndo().catch(() => "");
    if (!branch) {
      return false;
    }
    return Boolean(
      await this.latestSnapshotRefForBranch(branch).catch(() => "")
    );
  }

  /**
   * 현재 브랜치가 작업 시작 시점의 이름과 HEAD를 그대로 유지하는지 검증한다.
   * 임시 worktree 결과가 시작 HEAD에서 파생됐는지도 함께 확인해 고아 commit 생성을 막는다.
   * @param branch 작업 시작 브랜치
   * @param beforeHead 작업 시작 HEAD
   * @param targetRef 적용하려는 임시 worktree 결과
   */
  async assertStillOnBranch(
    branch: string,
    beforeHead: string,
    targetRef: string
  ): Promise<void> {
    await assertCurrentBranchHead(
      this.repoRoot,
      branch,
      beforeHead,
      "applying PR operation result"
    );
    await assertTargetDescendsFrom(
      this.repoRoot,
      beforeHead,
      targetRef,
      "applying PR operation result"
    );
  }

  /**
   * 현재 브랜치를 target ref로 이동하되 사용자 변경을 덮으면 중단한다.
   * @param targetRef reset 대상 commit/ref
   * @param failureMessage reset 실패에 앞에 붙일 복구 안내
   */
  async resetCurrentBranchPreservingLocalChanges(
    targetRef: string,
    failureMessage: string
  ): Promise<void> {
    try {
      await runGit(
        ["-c", "core.fsmonitor=false", "reset", "--keep", targetRef],
        this.repoRoot
      );
    } catch (error) {
      throw new Error(`${failureMessage} ${gitErrorText(error)}`);
    }
  }

  /**
   * 지정 로컬 브랜치로 working tree를 전환한다.
   * 이미 대상 브랜치에 있으면 불필요한 Git 이벤트를 만들지 않는다.
   * @param branch 전환할 로컬 브랜치명
   */
  async switchToBranch(branch: string): Promise<void> {
    if (await this.currentBranch().catch(() => "") === branch) {
      return;
    }
    await runGit(["switch", branch], this.repoRoot);
  }

  /** merge 상태가 아닌 unmerged 파일은 stash할 수 없으므로 PR 작업 전에 차단한다. */
  private async assertNoUnmergedChanges(): Promise<void> {
    if (await this.hasUnmergedChanges()) {
      throw new Error("Resolve unmerged files before running a PR operation.");
    }
  }

  /** PR undo가 새 사용자 변경이나 무관한 Git operation을 덮지 않는지 확인한다. */
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

  /**
   * undo 대상 브랜치를 찾는다.
   * rebase 중 detached HEAD라면 Git rebase metadata의 원래 branch 이름을 사용한다.
   */
  private async currentBranchForUndo(): Promise<string> {
    const branch = await this.currentBranch().catch(() => "");
    if (branch) {
      return branch;
    }
    if (await detectOperation(this.repoRoot) === "rebase") {
      const rebaseBranch = await this.currentRebaseBranch();
      if (rebaseBranch) {
        return rebaseBranch;
      }
    }
    throw new Error("PR operation undo requires a checked-out local branch.");
  }

  /** 진행 중인 rebase의 원래 branch 이름을 Git 상태 파일에서 읽는다. */
  private async currentRebaseBranch(): Promise<string | undefined> {
    const gitDirRaw = (
      await runGit(["rev-parse", "--git-dir"], this.repoRoot)
    ).trim();
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

  /** checkout되지 않은 로컬 브랜치 ref를 snapshot commit으로 직접 이동한다. */
  private async updateBranchRef(branch: string, ref: string): Promise<void> {
    await runGit(["update-ref", `refs/heads/${branch}`, ref], this.repoRoot);
  }

  /** latest symbolic ref가 특정 immutable snapshot을 가리키도록 갱신한다. */
  private async updateLatestSnapshotRef(
    latestRef: string,
    snapshotRef: string
  ): Promise<void> {
    await runGit(["symbolic-ref", latestRef, snapshotRef], this.repoRoot);
  }

  /** 브랜치의 최신 snapshot을 command별·legacy ref까지 호환해 찾는다. */
  private async latestSnapshotRefForBranch(branch: string): Promise<string> {
    const branchLatest = await this.resolvedSnapshotRef(snapshotRefForBranch(branch));
    if (branchLatest) {
      return branchLatest;
    }
    const commandLatest = (
      await Promise.all(
        PULL_REQUEST_OPERATION_COMMANDS.map(async (command) => {
          const ref = await this.resolvedSnapshotRef(
            snapshotRefForCommand(branch, command)
          );
          return ref ? { ref, sortKey: snapshotSortKey(ref) } : undefined;
        })
      )
    )
      .filter((item): item is { ref: string; sortKey: string } => Boolean(item))
      .sort((left, right) => right.sortKey.localeCompare(left.sortKey))[0];
    if (commandLatest) {
      return commandLatest.ref;
    }
    const legacy = await this.resolvedSnapshotRef(
      legacySnapshotRefForBranch(branch)
    );
    if (legacy) {
      return legacy;
    }
    throw new Error("No PR operation snapshot is available for the current branch.");
  }

  /** symbolic latest ref를 실제 snapshot으로 풀고 유효한 commit일 때만 반환한다. */
  private async resolvedSnapshotRef(ref: string): Promise<string | undefined> {
    const target = await this.symbolicRefTarget(ref);
    const snapshotRef = target || ref;
    return this.resolveSnapshot(snapshotRef).then(
      () => snapshotRef,
      () => undefined
    );
  }

  /** symbolic ref의 target을 반환하며 일반 ref거나 없으면 undefined를 반환한다. */
  private async symbolicRefTarget(ref: string): Promise<string | undefined> {
    const target = await runGit(
      ["symbolic-ref", "-q", ref],
      this.repoRoot
    ).catch(() => "");
    return target.trim() || undefined;
  }

  /** latest 포인터가 지정 snapshot을 가리킬 때만 해당 symbolic ref를 삭제한다. */
  private async deleteLatestSnapshotRefIfTarget(
    latestRef: string,
    snapshotRef: string
  ): Promise<void> {
    if (await this.symbolicRefTarget(latestRef) === snapshotRef) {
      await runGit(["symbolic-ref", "-d", latestRef], this.repoRoot).catch(() => "");
    }
  }

  /** undo snapshot ref가 실제 commit이면 전체 hash를 반환한다. */
  private async resolveSnapshot(ref: string): Promise<string> {
    const hash = await runGit(
      ["rev-parse", "--verify", `${ref}^{commit}`],
      this.repoRoot
    ).catch(() => "");
    if (!hash.trim()) {
      throw new Error("No PR operation snapshot is available for the current branch.");
    }
    return hash.trim();
  }

  /** 진행 중인 rebase/cherry-pick류 작업을 undo 전에 중단한다. */
  private async abortOperationIfNeeded(operation: MergeOperation): Promise<void> {
    if (operation !== "none") {
      await runGit([operation, "--abort"], this.repoRoot);
    }
  }

  /** 현재 브랜치를 snapshot으로 되돌리되 로컬 변경을 덮으면 snapshot을 남기고 중단한다. */
  private async resetCurrentBranchToSnapshot(snapshotRef: string): Promise<void> {
    await this.resetCurrentBranchPreservingLocalChanges(
      snapshotRef,
      "PR operation undo would overwrite local changes, so it was stopped. " +
        "Commit or stash the local changes, then run undo again. " +
        `The undo snapshot was kept at ${snapshotRef}.`
    );
  }

  /** 두 deferred PR 경로가 보존한 사용자 변경을 undo 대상 브랜치에 복원한다. */
  private async restorePendingLocalChanges(branch: string): Promise<void> {
    const message =
      "PR operation was undone, but preserved local changes could not be restored.";
    await restorePendingPullRequestLocalChangesForBranch(
      this.repoRoot,
      branch,
      message
    );
    await restorePendingDeferredCommitRebaseLocalChangesForBranch(
      this.repoRoot,
      branch,
      message
    );
  }
}

/** snapshot ref의 snowflake 끝부분을 최신순 정렬 키로 반환한다. */
function snapshotSortKey(ref: string): string {
  return ref.split("/").pop() || "";
}

/** GitError의 stderr/stdout을 보존해 reset 실패 복구 안내에 포함한다. */
function gitErrorText(error: unknown): string {
  if (error instanceof GitError) {
    return [error.stderr.trim(), error.stdout.trim(), error.message]
      .filter(Boolean)
      .join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}
