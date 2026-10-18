import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readRebaseCommitDetails } from "../src/git/rebaseCommitReader";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/**
 * 첫 부모와 파일 조회가 기존 log/diff-tree 두 번만으로 완료되는지 실제 Git 실행을 기록한다.
 * @param t 테스트 종료 시 spawn mock을 복구하는 문맥 @returns 이후 실행된 Git 인수 목록
 */
function observeGit(t: TestContext): string[][] {
  const calls: string[][] = [], spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => { if (args[0] === "git") calls.push(args[1]); return (spawn as Function)(...args); });
  return calls;
}

test("root and empty commit details share their metadata while retaining exact parent and file semantics", async t => {
  const { root, head } = await safetyFixture(t, "rebase-commit-details-root");
  await git(root, "commit", "-q", "--allow-empty", "-m", "empty");
  const empty = await git(root, "rev-parse", "HEAD");
  const calls = observeGit(t);
  const initial = await readRebaseCommitDetails(root, head);
  assert.equal(initial.parent, undefined);
  assert.equal(initial.files.length, 1);
  assert.equal(initial.files[0].path, "tracked.txt"); assert.equal(initial.files[0].status, "A");
  assert.equal(initial.files[0].additions, 1); assert.equal(initial.files[0].deletions, 0);
  const child = await readRebaseCommitDetails(root, empty);
  assert.equal(child.parent, head); assert.deepEqual(child.files, []);
  assert.deepEqual(calls.map(args => args[0]), ["log", "diff-tree", "log", "diff-tree"]);
});

test("merge details retain the first parent and only that parent's file delta", async t => {
  const { root, head } = await safetyFixture(t, "rebase-commit-details-merge");
  const main = await commitText(root, "main\n", "main");
  await git(root, "switch", "-qc", "side", head);
  await writeFile(join(root, "side.txt"), "side content\n");
  await git(root, "add", "side.txt"); await git(root, "commit", "-qm", "side");
  await git(root, "switch", "-q", "main"); await git(root, "merge", "--no-ff", "--no-edit", "side");
  const merge = await git(root, "rev-parse", "HEAD");
  const calls = observeGit(t);
  const details = await readRebaseCommitDetails(root, merge);
  assert.equal(details.parent, main);
  assert.deepEqual(details.files.map(file => [file.status, file.path, file.additions, file.deletions]), [["A", "side.txt", 1, 0]]);
  assert.deepEqual(calls.map(args => args[0]), ["log", "diff-tree"]);
});
