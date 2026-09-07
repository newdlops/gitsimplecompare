// 브랜치 단위 squash merge / rebase merge 작업을 담당하는 서비스.
// - graph UI 는 확인과 결과 안내만 하고, 실제 git 상태 변경은 이 모듈로 모은다.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { detectOperation } from "./conflictService";
import { BranchOperationUndoStore, type BranchOperationUndoPlan } from "./branchOperationUndoStore";
import { logError } from "../ui/outputLog";
import {
  restorePendingBranchRebaseMergeLocalChangesForBranch,
  runBranchRebaseMerge,
} from "./branchRebaseMerge";
import { runGit } from "./gitExec";
import { assertCurrentBranchHead, assertTargetDescendsFrom } from "./refSafety";
import {
  pushPreservedLocalChangesStash,
  restorePreservedLocalChangesStash,
} from "./stashExec";

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
    await this.assertReadyForBranchOperation();
    await this.assertSourceBranch(sourceBranch);
    const branch = await this.currentBranch();
    this.assertDifferentBranches(branch, sourceBranch);
    const beforeHead = await this.currentHead();
    if (await this.hasLocalChanges()) {
      return this.squashMergeWithLocalChanges(sourceBranch, branch, beforeHead);
    }
    const snapshotRef = await this.createSnapshot(branch, beforeHead);
    try {
      await runGit(["merge", "--squash", sourceBranch], this.repoRoot, {
        env: { GIT_EDITOR: "true", HUSKY: "0" },
      });
      if (!await this.hasPendingChanges()) {
        throw new Error(`Branch '${sourceBranch}' did not produce changes to commit.`);
      }
      await runGit(["add", "-A"], this.repoRoot);
      await this.commitSquash(sourceBranch, branch, this.repoRoot);
      await this.undoStore.capture(branch, snapshotRef, "completed");
      return {
        status: "completed",
        branch,
        sourceBranch,
        beforeHead,
        afterHead: await this.currentHead(),
        snapshotRef,
      };
    } catch (err) {
      await this.recordFailedSquash(branch, snapshotRef);
      if (await this.hasUnmergedChanges()) {
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
    await this.assertReadyForBranchOperation();
    const branch = await this.currentBranch();
    this.assertDifferentBranches(branch, targetRef);
    const beforeHead = await this.currentHead();
    const targetHead = await this.resolveCommit(targetRef);
    const snapshotRef = await this.createSnapshot(branch, beforeHead);
    const preserved = await this.preserveLocalChanges(`before rebase onto '${targetRef}'`);
    try {
      const result = await runBranchRebaseMerge({
        repoRoot: this.repoRoot,
        branch,
        targetRef,
        beforeHead,
        targetHead,
        snapshotRef,
        preservedStashHash: preserved?.hash,
      });
      await this.undoStore.capture(branch, snapshotRef,
        await detectOperation(this.repoRoot) === "rebase" ? "rebase" : "completed");
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
    } catch (err) {
      const restored = await this.restoreAfterFailedDeferredRebase(
        preserved,
        branch,
        beforeHead,
        snapshotRef
      );
      if (restored) {
        await runGit(["update-ref", "-d", snapshotRef], this.repoRoot).catch(() => "");
      }
      throw this.withPreservedStashNotice(err, restored ? undefined : preserved, branch);
    }
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
    return this.undoStore.prepare(branchName);
  }

  /**
   * 현재 브랜치에 branch operation undo snapshot 이 있는지 확인한다.
   * @param branchName 확인할 브랜치. 생략하면 현재 브랜치를 사용한다.
   */
  async hasUndoSnapshot(branchName?: string): Promise<boolean> {
    return this.prepareUndo(branchName).then(() => true, () => false);
  }

  /** 브랜치 작업 전 진행 중인 git 작업과 unmerged 파일이 없는지 확인한다. */
  private async assertReadyForBranchOperation(): Promise<void> {
    const operation = await detectOperation(this.repoRoot);
    if (operation !== "none") {
      throw new Error(`Cannot start branch operation while ${operation} is in progress.`);
    }
    if (await this.hasUnmergedChanges()) {
      throw new Error("Resolve unmerged files before running a branch operation.");
    }
  }

  /**
   * source 브랜치 ref 가 실제 로컬 브랜치인지 확인한다.
   * @param sourceBranch 병합할 로컬 브랜치 이름
   */
  private async assertSourceBranch(sourceBranch: string): Promise<void> {
    const out = await runGit(
      ["rev-parse", "--verify", `refs/heads/${sourceBranch}^{commit}`],
      this.repoRoot
    ).catch(() => "");
    if (!out.trim()) {
      throw new Error(`Local branch not found: ${sourceBranch}`);
    }
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

  /** 현재 로컬 브랜치 이름을 반환한다. detached HEAD 는 브랜치 작업 대상에서 제외한다. */
  private async currentBranch(): Promise<string> {
    const branch = (await runGit(["symbolic-ref", "--short", "HEAD"], this.repoRoot).catch(() => "")).trim();
    if (!branch) {
      throw new Error("Branch operations require a checked-out local branch.");
    }
    return branch;
  }

  /** 현재 HEAD commit hash 를 반환한다. */
  private async currentHead(): Promise<string> {
    return (await runGit(["rev-parse", "--verify", "HEAD"], this.repoRoot)).trim();
  }

  /** 현재 작업트리나 index 에 커밋되지 않은 변경이 있는지 확인한다. */
  private async hasLocalChanges(): Promise<boolean> {
    return (await runGit(["status", "--porcelain=v1", "-z"], this.repoRoot)).length > 0;
  }

  /** index 에 unmerged 상태로 남은 파일이 있는지 확인한다. */
  private async hasUnmergedChanges(): Promise<boolean> {
    return (await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], this.repoRoot).catch(() => "")).length > 0;
  }

  /** squash merge 후 commit 할 변경이 있는지 확인한다. */
  private async hasPendingChanges(): Promise<boolean> {
    const staged = await runGit(["diff", "--cached", "--quiet"], this.repoRoot).then(() => false, () => true);
    const unstaged = await runGit(["diff", "--quiet"], this.repoRoot).then(() => false, () => true);
    return staged || unstaged;
  }

  /** 현재 브랜치용 branch operation undo snapshot ref 를 생성한다. */
  private async createSnapshot(branch: string, head: string): Promise<string> {
    const ref = `refs/gitsimplecompare/branch-operation-snapshots/${Buffer.from(branch).toString("hex")}/${randomUUID()}`;
    await runGit(["update-ref", ref, head], this.repoRoot);
    await this.undoStore.start(branch, head, ref);
    return ref;
  }

  /** squash가 부분 적용된 채 실패하면 복구 정보를 남기고 최초 Git 오류는 그대로 전달한다. */
  private async recordFailedSquash(branch: string, snapshotRef: string): Promise<void> {
    try {
      await this.undoStore.capture(branch, snapshotRef, "squash");
    } catch (error) {
      logError("branch squash recovery recording failed; snapshot preserved", error, { repoRoot: this.repoRoot, branch, snapshotRef });
    }
  }

  /**
   * local/remote ref 또는 commit-ish 를 commit hash 로 정규화한다.
   * @param ref rebase 대상 ref
   * @returns 전체 commit hash
   */
  private async resolveCommit(ref: string): Promise<string> {
    const hash = (await runGit(["rev-parse", "--verify", `${ref}^{commit}`], this.repoRoot).catch(() => "")).trim();
    if (!hash) {
      throw new Error(`Rebase target not found: ${ref}`);
    }
    return hash;
  }

  /** 지정한 로컬 브랜치로 working tree 를 전환한다. */
  private async switchToBranch(branch: string): Promise<void> {
    if (await this.currentBranch().catch(() => "") === branch) {
      return;
    }
    await runGit(["switch", branch], this.repoRoot);
  }

  /** 로컬 변경이 있는 상태에서 squash commit 을 임시 worktree 로 계산해 현재 브랜치에 반영한다. */
  private async squashMergeWithLocalChanges(
    sourceBranch: string,
    branch: string,
    beforeHead: string
  ): Promise<BranchOperationResult> {
    const worktreePath = await this.createTemporaryWorktree(beforeHead);
    let keepWorktree = false;
    let snapshotRef = "";
    try {
      try {
        await runGit(["merge", "--squash", sourceBranch], worktreePath, {
          env: { GIT_EDITOR: "true", HUSKY: "0" },
        });
      } catch (err) {
        if (await this.hasUnmergedChangesIn(worktreePath)) {
          keepWorktree = true;
          throw new Error(
            `Branch '${sourceBranch}' has squash merge conflicts. ` +
            "The current working tree was not changed. " +
            `Resolve the conflict in the preserved temporary worktree: ${worktreePath}. ${errText(err)}`
          );
        }
        throw err;
      }
      if (!await this.hasPendingChangesIn(worktreePath)) {
        throw new Error(`Branch '${sourceBranch}' did not produce changes to commit.`);
      }
      await runGit(["add", "-A"], worktreePath);
      await this.commitSquash(sourceBranch, branch, worktreePath);
      const afterHead = await this.currentHeadIn(worktreePath);
      snapshotRef = await this.createSnapshot(branch, beforeHead);
      await this.assertStillOnBranch(branch, beforeHead, afterHead);
      await runGit(["reset", "--keep", afterHead], this.repoRoot);
      await this.undoStore.capture(branch, snapshotRef, "completed");
      return { status: "completed", branch, sourceBranch, beforeHead, afterHead, snapshotRef };
    } finally {
      if (!keepWorktree) {
        await this.removeTemporaryWorktree(worktreePath);
      }
    }
  }

  /** squash merge commit 을 만든다. 자동 작업이므로 pre-commit hook 은 실행하지 않는다. */
  private async commitSquash(sourceBranch: string, destinationBranch: string, cwd: string): Promise<void> {
    await runGit(
      [
        "commit",
        "--no-verify",
        "-m",
        `Squash merge '${sourceBranch}'`,
        "-m",
        `Squash-merged branch '${sourceBranch}' into '${destinationBranch}'.`,
      ],
      cwd,
      { env: { GIT_EDITOR: "true", HUSKY: "0" } }
    );
  }

  /**
   * 브랜치 작업 결과를 현재 브랜치에 반영해도 되는지 확인한다.
   * - 브랜치 이름과 시작 HEAD 를 함께 검증해, 작업 도중 같은 브랜치 ref 가 다른 커밋으로
   *   이동한 경우 reset 으로 사용자 커밋을 숨기지 않도록 중단한다.
   * @param branch 작업 시작 시점의 대상 브랜치
   * @param beforeHead 작업 시작 시점의 대상 브랜치 HEAD
   * @param targetRef 현재 브랜치에 적용하려는 결과 ref
   */
  private async assertStillOnBranch(
    branch: string,
    beforeHead: string,
    targetRef: string
  ): Promise<void> {
    await assertCurrentBranchHead(this.repoRoot, branch, beforeHead, "applying branch operation result");
    await assertTargetDescendsFrom(this.repoRoot, beforeHead, targetRef, "applying branch operation result");
  }

  /** 임시 worktree 를 만들어 더러운 작업트리를 건드리지 않고 squash 결과를 계산한다. */
  private async createTemporaryWorktree(startPoint: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gsc-branch-operation-"));
    await fs.rm(dir, { recursive: true, force: true });
    await runGit(["worktree", "add", "--detach", dir, startPoint], this.repoRoot);
    return dir;
  }

  /** 임시 worktree 를 제거한다. 제거 실패 시 남은 디렉터리만 한 번 더 정리한다. */
  private async removeTemporaryWorktree(worktreePath: string): Promise<void> {
    await runGit(["worktree", "remove", "--force", worktreePath], this.repoRoot)
      .catch(async () => {
        await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      });
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

  /** 로컬 변경을 임시 stash 로 보존해 branch rebase merge 가 clean tree 에서 시작되도록 한다. */
  private async preserveLocalChanges(reason: string): Promise<PreservedLocalChanges | undefined> {
    if (!await this.hasLocalChanges()) {
      return undefined;
    }
    return pushPreservedLocalChangesStash(this.repoRoot, `Git Simple Compare ${reason}`);
  }

  /** deferred rebase 시작 중 예상치 못하게 실패하면 snapshot 으로 되돌리고 보존 stash 를 복원한다. */
  private async restoreAfterFailedDeferredRebase(
    preserved: PreservedLocalChanges | undefined,
    branch: string,
    beforeHead: string,
    snapshotRef: string
  ): Promise<boolean> {
    if (await detectOperation(this.repoRoot) !== "none") {
      return false;
    }
    await this.switchToBranch(branch);
    await assertCurrentBranchHead(this.repoRoot, branch, beforeHead, "restoring failed branch operation");
    await runGit(["reset", "--hard", snapshotRef], this.repoRoot);
    if (preserved) {
      await this.restorePreservedLocalChanges(
        preserved,
        "Branch rebase merge failed, but local changes could not be restored."
      );
    }
    return true;
  }

  /** 보존해 둔 로컬 변경을 다시 적용하고 stash 목록에서 제거한다. */
  private async restorePreservedLocalChanges(
    preserved: PreservedLocalChanges | undefined,
    failureMessage: string
  ): Promise<void> {
    if (!preserved) {
      return;
    }
    await restorePreservedLocalChangesStash(this.repoRoot, preserved.hash, failureMessage);
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
