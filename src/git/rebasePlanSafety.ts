// UI가 준비한 interactive rebase를 원래 worktree/브랜치/HEAD에 고정한다.
import { realpath } from "node:fs/promises";
import { runGit } from "./gitExec";

/** 동일 HEAD의 다른 브랜치도 구분하는 rebase 계획의 checkout 기준이다. */
export interface RebaseCheckoutIdentity { gitDir: string; branch: string; head: string; }

/** 계획을 만들기 전 현재 checkout을 읽고 detached HEAD는 거부한다. */
export async function captureRebaseCheckout(repoRoot: string): Promise<RebaseCheckoutIdentity> {
  const [directory, branch, head] = await Promise.all([
    runGit(["rev-parse", "--absolute-git-dir"], repoRoot),
    runGit(["symbolic-ref", "HEAD"], repoRoot),
    runGit(["rev-parse", "--verify", "HEAD"], repoRoot),
  ]);
  return { gitDir: await realpath(directory.trim()), branch: branch.trim(), head: head.trim() };
}

/** 실행 직전에 계획을 준비한 checkout과 같은지 검증하고 변경 시 Git을 시작하지 않는다. */
export async function assertRebaseCheckout(repoRoot: string, expected: RebaseCheckoutIdentity): Promise<void> {
  const current = await captureRebaseCheckout(repoRoot);
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
