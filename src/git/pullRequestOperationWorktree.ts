// PR 작업 결과를 임시 worktree에서 계산하고 현재 브랜치에 안전하게 반영하는 실행 모듈.
// - dirty working tree를 직접 stash하지 않고 격리된 checkout에서 cherry-pick/revert/rebase를 수행한다.
import { runDeferredCommitRebase } from "./deferredCommitRebase";
import { GitError, runGit } from "./gitExec";
import {
  squashBody,
  squashRevertBody,
  squashRevertTitle,
  squashTitle,
  type PullRequestOperationCommand,
} from "./pullRequestOperationFormat";
import { PullRequestOperationSnapshot } from "./pullRequestOperationSnapshot";
import type { PullRequestInfo } from "./pullRequestInfo";
import type { PullRequestRevertCommit } from "./pullRequestRevertPlan";
import {
  createPrOperationWorktree,
  removeTemporaryWorktree,
} from "./temporaryWorktree";

/** PR 작업 실행 결과와 undo에 필요한 snapshot 정보 */
export interface PullRequestOperationResult {
  status: "completed" | "conflicts";
  branch: string;
  beforeHead: string;
  afterHead: string;
  snapshotRef: string;
  sourceBranch?: string;
  preservedStashHash?: string;
}

/** 여러 commit을 임시 worktree에서 재생하는 공통 입력 */
interface ReplayWithLocalChangesInput {
  pr: PullRequestInfo;
  commits: string[];
  branch: string;
  beforeHead: string;
  command: PullRequestOperationCommand;
  operation: "cherry-pick" | "revert";
  kind: "pr-rebase" | "pr-revert";
  actionLabel: string;
  failureLabel: string;
}

/**
 * 로컬 변경이 있는 PR 작업을 임시 worktree에서 계산한다.
 * 브랜치/snapshot 상태 변경은 PullRequestOperationSnapshot에 위임해 실행과 안전 규칙을 분리한다.
 */
export class PullRequestOperationWorktree {
  constructor(
    public readonly repoRoot: string,
    private readonly state: PullRequestOperationSnapshot
  ) {}

  /**
   * PR commit 목록을 임시 worktree에서 하나의 squash cherry-pick commit으로 만든다.
   * 충돌한 worktree는 진단·수동 해결을 위해 보존하고 현재 작업트리는 변경하지 않는다.
   * @param pr commit 메시지와 사용자 안내에 사용할 PR 정보
   * @param commits cherry-pick 순서의 commit hash
   * @param branch 현재 대상 브랜치
   * @param beforeHead 작업 시작 HEAD
   */
  async squashCherryPick(
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
      } catch (error) {
        if (await this.state.hasUnmergedChangesIn(worktreePath)) {
          keepWorktree = true;
          throw new Error(
            `PR #${pr.number} has cherry-pick conflicts. ` +
              "The current working tree was not changed. " +
              `Resolve the conflict in the preserved temporary worktree: ${worktreePath}. ` +
              gitErrorText(error)
          );
        }
        throw error;
      }
      if (!await this.state.hasPendingChangesIn(worktreePath)) {
        throw new Error(`PR #${pr.number} did not produce changes to commit.`);
      }
      await runGit(["add", "-A"], worktreePath);
      await this.commitSquash(pr, worktreePath);
      const afterHead = await this.state.currentHeadIn(worktreePath);
      snapshotRef = await this.state.createSnapshot(branch, beforeHead, "squash");
      await this.state.assertStillOnBranch(branch, beforeHead, afterHead);
      await this.state.resetCurrentBranchPreservingLocalChanges(
        afterHead,
        `PR #${pr.number} squash cherry-pick would overwrite local changes, so it was stopped. ` +
          `The undo snapshot was kept at ${snapshotRef}.`
      );
      return { status: "completed", branch, beforeHead, afterHead, snapshotRef };
    } catch (error) {
      if (snapshotRef) {
        await this.state.deleteSnapshotRef(branch, snapshotRef);
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      if (!keepWorktree) {
        await this.removeTemporaryWorktree(worktreePath);
      }
    }
  }

  /**
   * 선택된 revert commit을 임시 worktree에서 하나의 squash revert commit으로 만든다.
   * merge 결과 계획은 mainline 정보를 유지해 실제 GitHub merge commit도 정확히 되돌린다.
   * @param pr commit 메시지와 사용자 안내에 사용할 PR 정보
   * @param commits 적용 순서와 선택적인 mainline을 가진 revert 대상
   * @param branch 현재 대상 브랜치
   * @param beforeHead 작업 시작 HEAD
   */
  async squashRevert(
    pr: PullRequestInfo,
    commits: PullRequestRevertCommit[],
    branch: string,
    beforeHead: string
  ): Promise<PullRequestOperationResult> {
    const worktreePath = await this.createTemporaryWorktree(beforeHead);
    let keepWorktree = false;
    let snapshotRef = "";
    try {
      try {
        await this.applySquashRevert(commits, worktreePath);
      } catch (error) {
        if (await this.state.hasUnmergedChangesIn(worktreePath)) {
          keepWorktree = true;
          throw new Error(
            `PR #${pr.number} has squash revert conflicts. ` +
              "The current working tree was not changed. " +
              `Resolve the conflict in the preserved temporary worktree: ${worktreePath}. ` +
              gitErrorText(error)
          );
        }
        throw error;
      }
      if (!await this.state.hasPendingChangesIn(worktreePath)) {
        throw new Error(`PR #${pr.number} did not produce changes to commit.`);
      }
      await runGit(["add", "-A"], worktreePath);
      await this.commitSquashRevert(pr, worktreePath);
      const afterHead = await this.state.currentHeadIn(worktreePath);
      snapshotRef = await this.state.createSnapshot(
        branch,
        beforeHead,
        "squashRevert"
      );
      await this.state.assertStillOnBranch(branch, beforeHead, afterHead);
      await this.state.resetCurrentBranchPreservingLocalChanges(
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
    } catch (error) {
      if (snapshotRef) {
        await this.state.deleteSnapshotRef(branch, snapshotRef);
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      if (!keepWorktree) {
        await this.removeTemporaryWorktree(worktreePath);
      }
    }
  }

  /**
   * PR commit들을 임시 worktree에서 현재 브랜치 위로 재생한다.
   * @param pr 작업 대상 PR
   * @param commits cherry-pick 순서의 원본 commit
   * @param branch 대상 브랜치
   * @param beforeHead 작업 시작 HEAD
   */
  async rebasePullRequest(
    pr: PullRequestInfo,
    commits: string[],
    branch: string,
    beforeHead: string
  ): Promise<PullRequestOperationResult> {
    return this.replay({
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

  /**
   * PR commit들을 임시 worktree에서 역순으로 각각 revert한다.
   * @param pr 작업 대상 PR
   * @param commits revert 순서의 원본 commit
   * @param branch 대상 브랜치
   * @param beforeHead 작업 시작 HEAD
   */
  async rebaseRevertPullRequest(
    pr: PullRequestInfo,
    commits: string[],
    branch: string,
    beforeHead: string
  ): Promise<PullRequestOperationResult> {
    return this.replay({
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

  /**
   * commit 목록을 현재 index/working tree에 squash revert 형태로 적용한다.
   * empty revert는 건너뛰고, 실제 충돌은 Git 상태를 보존한 채 호출자에게 전달한다.
   * @param commits 순서와 mainline이 정규화된 revert 대상
   * @param cwd 실제 저장소 또는 임시 worktree
   */
  async applySquashRevert(
    commits: PullRequestRevertCommit[],
    cwd: string
  ): Promise<void> {
    const env = {
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      HUSKY: "0",
    };
    for (const commit of commits) {
      const args = ["revert", "--no-commit"];
      if (commit.mainline) {
        args.push("-m", String(commit.mainline));
      }
      args.push(commit.hash);
      try {
        await runGit(args, cwd, { env });
      } catch (error) {
        if (await this.state.hasUnmergedChangesIn(cwd)) {
          throw error;
        }
        if (isEmptyRevertError(error)) {
          await runGit(["revert", "--skip"], cwd, { env }).catch(() => undefined);
          await runGit(["revert", "--abort"], cwd, { env }).catch(() => undefined);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * 현재 index를 GitHub 스타일의 PR squash cherry-pick commit으로 기록한다.
   * 자동 작업이므로 pre-commit hook과 편집기를 실행하지 않는다.
   * @param pr commit 제목·본문 원본
   * @param cwd commit할 저장소/worktree
   */
  async commitSquash(pr: PullRequestInfo, cwd: string): Promise<void> {
    await runGit(
      ["commit", "--no-verify", "-m", squashTitle(pr), "-m", squashBody(pr)],
      cwd,
      { env: { GIT_EDITOR: "true", HUSKY: "0" } }
    );
  }

  /**
   * 현재 index를 PR squash revert commit 하나로 기록한다.
   * 자동 작업이므로 pre-commit hook과 편집기를 실행하지 않는다.
   * @param pr commit 제목·본문 원본
   * @param cwd commit할 저장소/worktree
   */
  async commitSquashRevert(pr: PullRequestInfo, cwd: string): Promise<void> {
    await runGit(
      [
        "commit",
        "--no-verify",
        "-m",
        squashRevertTitle(pr),
        "-m",
        squashRevertBody(pr),
      ],
      cwd,
      { env: { GIT_EDITOR: "true", HUSKY: "0" } }
    );
  }

  /**
   * 로컬 변경을 stash하지 않고 임시 worktree에서 commit 재생 결과를 만든다.
   * 충돌하면 임시 worktree를 보존하고, 성공하면 현재 브랜치를 reset --keep으로 이동한다.
   * @param input 재생 종류와 snapshot metadata
   */
  private async replay(
    input: ReplayWithLocalChangesInput
  ): Promise<PullRequestOperationResult> {
    const worktreePath = await this.createTemporaryWorktree(input.beforeHead);
    let keepWorktree = false;
    let snapshotRef = "";
    try {
      const result = await runDeferredCommitRebase({
        kind: input.kind,
        operation: input.operation === "revert" ? "revert" : undefined,
        label:
          `PR #${input.pr.number}` +
          (input.operation === "revert" ? " revert" : ""),
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
      const afterHead =
        result.afterHead || await this.state.currentHeadIn(worktreePath);
      snapshotRef = await this.state.createSnapshot(
        input.branch,
        input.beforeHead,
        input.command
      );
      await this.state.assertStillOnBranch(
        input.branch,
        input.beforeHead,
        afterHead
      );
      try {
        await this.state.resetCurrentBranchPreservingLocalChanges(
          afterHead,
          `PR #${input.pr.number} ${input.failureLabel} result could not be applied ` +
            "to the current working tree. The replayed result was preserved in a " +
            `temporary worktree. Temporary worktree: ${worktreePath}. ` +
            `The undo snapshot was kept at ${snapshotRef}.`
        );
      } catch (error) {
        keepWorktree = true;
        throw error;
      }
      return {
        status: "completed",
        branch: input.branch,
        beforeHead: input.beforeHead,
        afterHead,
        snapshotRef,
        sourceBranch: input.pr.headRefName || input.pr.headHash,
      };
    } catch (error) {
      if (snapshotRef && !keepWorktree) {
        await this.state.deleteSnapshotRef(input.branch, snapshotRef);
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      if (!keepWorktree) {
        await this.removeTemporaryWorktree(worktreePath);
      }
    }
  }

  /**
   * detached 임시 worktree를 작업 시작 commit에서 만든다.
   * @param startPoint 작업 시작 HEAD
   */
  private async createTemporaryWorktree(startPoint: string): Promise<string> {
    return createPrOperationWorktree(this.repoRoot, startPoint);
  }

  /**
   * Git worktree metadata와 임시 디렉터리를 함께 정리한다.
   * @param worktreePath createTemporaryWorktree가 반환한 경로
   */
  private async removeTemporaryWorktree(worktreePath: string): Promise<void> {
    await removeTemporaryWorktree(this.repoRoot, worktreePath);
  }
}

/** GitError의 두 출력 스트림을 보존해 임시 worktree 복구 안내에 포함한다. */
function gitErrorText(error: unknown): string {
  if (error instanceof GitError) {
    return [error.stderr.trim(), error.stdout.trim(), error.message]
      .filter(Boolean)
      .join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

/** git revert가 적용할 변화가 없어 실패했는지 stderr/stdout 전체에서 판정한다. */
function isEmptyRevertError(error: unknown): boolean {
  const text =
    error instanceof GitError
      ? `${error.message}\n${error.stderr}\n${error.stdout}`
      : error instanceof Error
        ? error.message
        : String(error);
  return /nothing to commit|nothing added to commit|empty|patch contents already upstream/i.test(
    text
  );
}
