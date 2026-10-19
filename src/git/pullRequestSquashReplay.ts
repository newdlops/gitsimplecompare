// squash patch를 하나씩 적용해 충돌 후에도 남은 patch를 정확히 이어갈 수 있게 한다.
import { GitError, runGit } from "./gitExec";
import type { PullRequestRecoveryCommit } from "./pullRequestWorktreeRecoveryState";

/** 실패한 patch는 index에 남겨 두고 이후에 적용할 목록만 전달한다. */
export class PullRequestSquashReplayConflict extends Error {
  constructor(public readonly remaining: PullRequestRecoveryCommit[], public readonly failure: unknown) {
    super(failure instanceof Error ? failure.message : String(failure));
  }
}

/**
 * 검증된 squash patch들을 commit 없이 순서대로 적용한다.
 * 한 번에 한 patch만 Git에 넘기므로 resolved index를 보존한 채 다음 patch를 재개할 수 있다.
 * @param root 전용 detached 임시 worktree
 * @param commits 순서가 확정된 patch와 선택적 revert mainline
 * @param operation patch 적용 방향
 * @param checkpoint 재개 도중 각 Git 쓰기 전에 미완료 상태를 영속화하는 선택적 콜백
 */
export async function replayPullRequestSquash(
  root: string, commits: PullRequestRecoveryCommit[], operation: "cherry-pick" | "revert",
  checkpoint?: (remaining: PullRequestRecoveryCommit[]) => Promise<void>
): Promise<void> {
  for (let index = 0; index < commits.length; index++) {
    await checkpoint?.(commits.slice(index));
    const commit = commits[index];
    const args = [operation, "--no-commit", ...(commit.mainline ? ["-m", String(commit.mainline)] : []), commit.hash];
    try {
      await runGit(args, root, { env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", HUSKY: "0" } });
    } catch (error) {
      const unmerged = await runGit(["ls-files", "--unmerged", "-z"], root);
      if (unmerged) throw new PullRequestSquashReplayConflict(commits.slice(index + 1), error);
      // --no-commit에서 이미 반영된 역방향 patch만 빈 적용으로 허용한다. 다른 오류는 보존한다.
      if (operation !== "revert" || !isEmptyPatch(error)) throw error;
      await runGit([operation, "--quit"], root);
    }
  }
}

/** Git의 두 출력에서 실제 빈 patch 안내만 확인하며 잠금·hook 등 일반 오류를 삼키지 않는다. */
function isEmptyPatch(error: unknown): boolean {
  const message = error instanceof GitError ? `${error.stderr}\n${error.stdout}` : String(error);
  return /nothing to commit|nothing added to commit|patch contents already upstream|previous cherry-pick is now empty/i.test(message);
}
