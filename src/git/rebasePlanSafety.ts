// UI가 준비한 interactive rebase를 원래 worktree/브랜치/HEAD에 고정한다.
import { runGit } from "./gitExec";
import { readGitCheckoutIdentity } from "./repositoryIdentity";

/** 동일 HEAD의 다른 브랜치도 구분하는 rebase 계획의 checkout 기준이다. */
export interface RebaseCheckoutIdentity { gitDir: string; branch: string; head: string; }

/** 계획을 만들기 전 checkout을 한 번 새로 읽고 detached HEAD는 거부한다. */
export async function captureRebaseCheckout(repoRoot: string): Promise<RebaseCheckoutIdentity> {
  const { gitDir, branchRef: branch, head } = await readGitCheckoutIdentity(repoRoot);
  if (!branch) throw new Error("Interactive rebase requires a checked-out local branch.");
  return { gitDir, branch, head };
}

/** 실행 직전에 계획을 준비한 checkout과 같은지 검증하고 변경 시 Git을 시작하지 않는다. */
export async function assertRebaseCheckout(repoRoot: string, expected: RebaseCheckoutIdentity): Promise<void> {
  const current = await captureRebaseCheckout(repoRoot);
  assertRebaseCheckoutMatches(current, expected);
}

/**
 * 같은 실행 경계에서 방금 읽은 checkout을 계획과 비교한다. 이 함수 자체는 Git 조회나 캐시를 만들지 않는다.
 * @param current 호출자가 이번 경계에서 새로 읽은 실제 worktree/branch/HEAD
 * @param expected UI 또는 첫 조회가 고정한 계획 기준 @returns 같으면 반환하며 다르면 쓰기 전에 오류를 던진다.
 */
export function assertRebaseCheckoutMatches(current: RebaseCheckoutIdentity, expected: RebaseCheckoutIdentity): void {
  if (current.gitDir !== expected.gitDir || current.branch !== expected.branch || current.head !== expected.head) {
    throw new Error("The checked-out branch or HEAD changed after the rebase plan was prepared. Prepare a new plan before starting.");
  }
}

/** merge DAG를 표현하지 못하는 plain pick todo는 Git 작업을 만들기 전에 거부한다. */
export async function assertLinearRebasePlan(repoRoot: string, base: string, root: boolean): Promise<void> {
  const merge = (await runGit(["rev-list", "--min-parents=2", "--max-count=1", root ? "HEAD" : `${base}..HEAD`], repoRoot)).trim();
  if (merge) throw new Error("This interactive rebase plan contains merge commits. Choose a linear commit range; merge history is not supported by this editor.");
}

/** rebase 종료 후 autostash 복원 충돌을 완료와 구분하는 사용자 안내다. */
export const REBASE_RESTORE_CONFLICT_MESSAGE = "Rebase finished, but restoring local changes caused conflicts. Resolve them in the Conflicts view. Git kept the autostash for recovery.";
