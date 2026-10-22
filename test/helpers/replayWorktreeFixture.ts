import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { runGitWithInput } from "../../src/git/gitExec";
import { git, safetyFixture } from "./gitSafetyFixture";
import { safetyPullRequest } from "./prOperationSafetyFixture";
import { removeTemporaryWorktree } from "../../src/git/temporaryWorktree";

/**
 * 실제 5천 파일 tree를 만들되 원래 저장소의 동일 padding은 Native S-bit로만 두어 테스트 I/O를 제한한다.
 * 원래 index 바이트 보존을 검사하므로 제품의 새 worktree에 이 최적화 상태를 넘기지는 않는다.
 * @param t 소유 fixture 정리 문맥 @param conflict 대상·원본 내용 충돌 여부
 */
export async function replayWorktreeFixture(t: TestContext, conflict = false) {
  const cleanups: Array<() => unknown> = [];
  const f = await safetyFixture({ after: (cleanup: () => unknown) => cleanups.push(cleanup) } as TestContext, "compact-pr-replay");
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  /** 공용 fixture 루트가 지워지기 전에 Native 등록부터 해제할 소유 worktree를 기록한다. */
  const ownWorktree = (worktree: string) => cleanups.push(() => removeTemporaryWorktree(f.root, worktree));
  const blob = (await runGitWithInput(["hash-object", "-w", "--stdin"], f.root, "unchanged padding\n")).trim();
  const paths = Array.from({ length: 5000 }, (_, index) => `padding/keep-${String(index).padStart(4, "0")}.txt`);
  await runGitWithInput(["update-index", "-z", "--index-info"], f.root, paths.map(file => `100644 ${blob}\t${file}\0`).join(""));
  await runGitWithInput(["update-index", "--skip-worktree", "-z", "--stdin"], f.root, paths.join("\0") + "\0");
  await writeFile(join(f.root, "delete-me.txt"), "delete this\n");
  await writeFile(join(f.root, "rename-me.txt"), "rename this\n");
  await git(f.root, "add", "delete-me.txt", "rename-me.txt"); await git(f.root, "commit", "-qm", "base files");
  const base = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "switch", "-qc", "source");
  await writeFile(join(f.root, "tracked.txt"), "PR content\n");
  await git(f.root, "rm", "delete-me.txt"); await git(f.root, "mv", "rename-me.txt", "renamed.txt");
  await writeFile(join(f.root, "binary.dat"), Buffer.from([0,1,255,42,0]));
  await git(f.root, "add", "."); await git(f.root, "commit", "-qm", "PR subject\n\nPR body", "--author", "Original Author <original@example.test>");
  const source = await git(f.root, "rev-parse", "HEAD"), tree = await git(f.root, "rev-parse", "HEAD^{tree}");
  await git(f.root, "switch", "main");
  if (conflict) {
    await writeFile(join(f.root, "tracked.txt"), "destination content\n");
    await git(f.root, "add", "tracked.txt"); await git(f.root, "commit", "-qm", "destination");
  }
  const beforeHead = await git(f.root, "rev-parse", "HEAD");
  await writeFile(join(f.root, "user.txt"), "staged user work\n"); await git(f.root, "add", "user.txt");
  await writeFile(join(f.root, "user.txt"), "unstaged user work\n");
  await writeFile(join(f.root, "untracked.txt"), "untracked user work\n");
  /** 원래 HEAD·index·config·작업 파일을 바이트로 비교한다. */
  const originalState = async () => ({ head: await git(f.root, "rev-parse", "HEAD"),
    index: await readFile(join(f.root, ".git/index")), config: await readFile(join(f.root, ".git/config")),
    user: await readFile(join(f.root, "user.txt")), untracked: await readFile(join(f.root, "untracked.txt")) });
  return { ...f, base, beforeHead, source, tree, paths, originalState, ownWorktree, pr: safetyPullRequest(source) };
}
