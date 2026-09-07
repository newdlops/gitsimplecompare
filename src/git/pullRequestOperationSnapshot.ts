// PR 작업의 브랜치 상태 검사, undo snapshot, 안전한 reset을 담당하는 Git snapshot 모듈.
// - 실제 cherry-pick/revert 조립과 분리해 snapshot 생명주기를 다른 PR 작업에서도 재사용한다.
import { detectOperation } from "./conflictService";
import { restorePendingDeferredCommitRebaseLocalChangesForBranch } from "./deferredCommitRebase";
import { GitError, runGit } from "./gitExec";
import {
  PULL_REQUEST_OPERATION_COMMANDS,
  createSnapshotSnowflake,
  snapshotRefForBranch,
  snapshotRefForCommand,
  snapshotRefForCommandSnowflake,
  type PullRequestOperationCommand,
} from "./pullRequestOperationFormat";
import { restorePendingPullRequestLocalChangesForBranch } from "./pullRequestRebaseContinuation";
import { assertCurrentBranchHead, assertTargetDescendsFrom } from "./refSafety";
import { OperationUndoStore, type OperationUndoPlan } from "./operationUndoStore";
import { logInfo } from "../ui/outputLog";

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
  private readonly undoStore: OperationUndoStore;

  /** 개별 worktree의 PR 기록만 사용해 다른 브랜치 작업의 snapshot과 섞이지 않게 한다. */
  constructor(public readonly repoRoot: string) {
    this.undoStore = new OperationUndoStore(repoRoot, "pull-request");
  }

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
      await this.undoStore.start(branch, head, snapshotRef);
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
   * 같은 작업 ID와 Git 상태를 다시 검증한 뒤 해당 작업과 일치하는 stash만 복원한다.
   * @param branchName detached rebase 등에서 호출자가 알고 있는 대상 브랜치
   * @param approvedPlan 확인창을 열기 전에 고정한 Undo 계획
   * @returns 복원된 브랜치와 HEAD
   */
  async undoLastOperation(
    branchName?: string,
    approvedPlan?: OperationUndoPlan
  ): Promise<PullRequestOperationUndoResult> {
    const plan = approvedPlan ?? await this.prepareUndo(branchName);
    const { branch, snapshotRef, restoredHead } = plan;
    try {
      await this.undoStore.undo(plan);
      if (plan.worktreeBranch === branch) {
        await this.restorePendingLocalChanges(branch, snapshotRef);
      }
      await this.undoStore.remove(plan);
      await this.deleteSnapshotRef(branch, snapshotRef);
      return { branch, restoredHead };
    } catch (error) {
      logInfo("PR operation undo stopped; recovery snapshot preserved", {
        repoRoot: this.repoRoot, branch, snapshotRef, id: plan.id, error: gitErrorText(error),
      });
      throw error;
    }
  }

  /** 확인창 이전의 작업 ID·브랜치·HEAD를 고정한다. 출처를 검증할 수 없으면 실행을 차단한다. */
  async prepareUndo(branchName?: string): Promise<OperationUndoPlan> {
    return this.undoStore.prepare(branchName);
  }

  /** 완료된 PR 결과를 기록한다. 실제 결과 적용 후, 사용자 stash를 복원하기 전에 호출한다. */
  async recordCompleted(branch: string, snapshotRef: string): Promise<void> {
    await this.undoStore.capture(branch, snapshotRef, "completed");
  }

  /**
   * 실패한 squash의 부분 결과를 기록하되 기록 실패가 원래 Git 오류를 가리지 않게 한다.
   * @param branch 이 호출이 작업을 시작한 브랜치
   * @param snapshotRef 다른 작업과 구별할 immutable snapshot
   */
  async recordFailedSquash(branch: string, snapshotRef: string): Promise<void> {
    try {
      const operation = await detectOperation(this.repoRoot);
      await this.undoStore.capture(branch, snapshotRef, operation === "none" ? "squash" : "replay");
    } catch (error) {
      logInfo("PR partial result could not be bound to Undo", { repoRoot: this.repoRoot, branch, snapshotRef, error: gitErrorText(error) });
    }
  }

  /**
   * 현재 또는 지정 브랜치에 유효한 undo snapshot이 있는지 확인한다.
   * preflight에서 실패해 snapshot을 만들지 않은 작업은 false로 반환한다.
   * @param branchName 확인할 브랜치. 생략하면 현재/진행 중 rebase 브랜치를 찾는다.
   */
  async hasUndoSnapshot(branchName?: string): Promise<boolean> {
    return this.prepareUndo(branchName).then(() => true, () => false);
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

  /** latest symbolic ref가 특정 immutable snapshot을 가리키도록 갱신한다. */
  private async updateLatestSnapshotRef(
    latestRef: string,
    snapshotRef: string
  ): Promise<void> {
    await runGit(["symbolic-ref", latestRef, snapshotRef], this.repoRoot);
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

  /** 두 deferred PR 경로가 보존한 사용자 변경을 undo 대상 브랜치에 복원한다. */
  private async restorePendingLocalChanges(branch: string, snapshotRef: string): Promise<void> {
    const message =
      "PR operation was undone, but preserved local changes could not be restored.";
    await restorePendingPullRequestLocalChangesForBranch(
      this.repoRoot,
      branch,
      message,
      snapshotRef
    );
    await restorePendingDeferredCommitRebaseLocalChangesForBranch(
      this.repoRoot,
      branch,
      message,
      snapshotRef
    );
  }
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
