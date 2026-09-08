import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { ConflictService } from "../src/git/conflictService";
import { GitLogService } from "../src/git/gitLogService";
import { runGit } from "../src/git/gitExec";
import { readRebaseCommits } from "../src/git/rebaseCommitReader";
import { readRebaseContinueDiagnostics } from "../src/git/rebaseContinueDiagnostics";
import { RebaseService } from "../src/git/rebaseService";
import { readRebaseTodoProgress } from "../src/git/rebaseTodoProgress";
import { readRebaseControlState } from "../src/webview/graphRebaseControlState";
import { focusRebaseConflicts } from "../src/webview/graphRebaseConflictFocus";
import { refreshAfterRebaseControl } from "../src/webview/graphRebaseUtils";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";
import { commands } from "./helpers/vscodeMock";

/** 실제 Git 프로세스는 그대로 실행하면서 조회 개수와 명령 종류만 기록한다. */
function recordGitCalls(t: TestContext): string[][] {
  const calls: string[][] = [];
  const original = childProcess.execFile;
  t.mock.method(childProcess, "execFile", (...args: any[]) => {
    if (args[0] === "git") calls.push(args[1]);
    return (original as Function)(...args);
  });
  return calls;
}

/** 명시적으로 해제하기 전까지 완료되지 않는 조회를 만들어 완료 순서를 검증한다. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

test("rebase reads all commit files in two processes with root, empty, rename and unusual paths", async t => {
  const { root, head } = await safetyFixture(t, "rebase-batch");
  const strange = ` 한글\tline\n${head} => literal `;
  await writeFile(join(root, strange), "one\ntwo\n");
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "add files\n\nbody\x1fwith separator");
  const added = await git(root, "rev-parse", "HEAD");
  const renamed = `${strange} renamed `;
  await rename(join(root, strange), join(root, renamed));
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "rename");
  const renameHash = await git(root, "rev-parse", "HEAD");
  await git(root, "commit", "--allow-empty", "-qm", "empty");
  const empty = await git(root, "rev-parse", "HEAD");
  for (let index = 0; index < 12; index++) await commitText(root, `change ${index}\n`, `change ${index}`);
  const calls = recordGitCalls(t);
  const commits = await new RebaseService(root).getCommits("", true);
  assert.equal(calls.length, 2);
  assert.equal(commits.length, 16);
  assert.deepEqual(commits[0].files, [{ status: "A", path: "tracked.txt", oldPath: undefined, additions: 1, deletions: 0 }]);
  assert.equal(commits.find(commit => commit.hash === added)?.body, "body\x1fwith separator");
  assert.deepEqual(commits.find(commit => commit.hash === added)?.files.find(file => file.path === strange), {
    status: "A", path: strange, oldPath: undefined, additions: 2, deletions: 0,
  });
  assert.deepEqual(commits.find(commit => commit.hash === renameHash)?.files, [{
    status: "R", path: renamed, oldPath: strange, additions: 0, deletions: 0,
  }]);
  assert.deepEqual(commits.find(commit => commit.hash === empty)?.files, []);
  assert.equal(commits.find(commit => commit.hash === added)?.files.find(file => file.path === "binary")?.additions, 0);
});

test("rebase batch preserves first-parent merge diffs and handles SHA-256 root commits", async t => {
  const { root, directory, head } = await safetyFixture(t, "rebase-batch-merge");
  await git(root, "switch", "-qc", "side");
  await writeFile(join(root, "side.txt"), "side\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "side");
  await git(root, "switch", "main");
  await commitText(root, "main change\n", "main change");
  await git(root, "merge", "--no-ff", "-qm", "merge", "side");
  const commits = await new RebaseService(root).getCommits(head);
  assert.deepEqual(commits.at(-1)?.files, [{ status: "A", path: "side.txt", oldPath: undefined, additions: 1, deletions: 0 }]);
  const shaRoot = join(directory, "sha256");
  await mkdir(shaRoot);
  await git(shaRoot, "init", "-q", "--object-format=sha256");
  for (const [key, value] of Object.entries({ "user.name": "Test", "user.email": "test@example.test", "commit.gpgsign": "false", "core.hooksPath": join(directory, "hooks") })) {
    await git(shaRoot, "config", key, value);
  }
  const shaHead = await commitText(shaRoot, "sha256\n", "sha256");
  const shaCommits = await new RebaseService(shaRoot).getCommits("", true);
  assert.equal(shaHead.length, 64);
  assert.equal(shaCommits[0].hash, shaHead);
  assert.equal(shaCommits[0].files[0].additions, 1);
});

test("rebase coverage validation reloads current commits without reading file diffs", async t => {
  const { root, head } = await safetyFixture(t, "rebase-coverage-fast");
  const first = await commitText(root, "first\n", "first");
  const second = await commitText(root, "second\n", "second");
  const calls = recordGitCalls(t);
  const result = await new RebaseService(root).start(head, false, [{ hash: first, action: "pick" }], resolve("media/rebase/rebaseEditor.js"));
  assert.equal(result.status, "failed");
  assert.match(result.message ?? "", /Missing:/);
  assert.equal(calls.some(args => args[0] === "diff" || args[0] === "diff-tree"), false);
  calls.length = 0;
  const commits = await readRebaseCommits(root, head, false, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(commits.map(commit => commit.hash), [first, second]);
  assert.equal(await git(root, "rev-parse", "HEAD"), second);
});

test("conflict listing reads index only and diagnostics exclude untracked scans without hiding tracked edits", async t => {
  const { root, head } = await safetyFixture(t, "conflict-index-fast");
  await commitText(root, "main\n", "main");
  await git(root, "switch", "-qc", "side", head);
  await commitText(root, "side\n", "side");
  await assert.rejects(git(root, "rebase", "main"));
  await writeFile(join(root, "untracked.txt"), "untracked\n");
  const calls = recordGitCalls(t);
  assert.deepEqual(await new ConflictService(root).listConflicts(), ["tracked.txt"]);
  assert.deepEqual(calls, [["ls-files", "--unmerged", "-z"]]);
  const diagnostics = await readRebaseContinueDiagnostics(root);
  assert.deepEqual(diagnostics.unmergedFiles, ["tracked.txt"]);
  assert.deepEqual(diagnostics.markerFiles, ["tracked.txt"]);
  assert.equal(diagnostics.operation, "rebase");
  assert.ok(calls.find(args => args[0] === "status")?.includes("--untracked-files=no"));
  assert.equal(calls.some(args => args[0] === "diff"), false);
  await writeFile(join(root, "tracked.txt"), "resolved\n");
  await git(root, "add", "tracked.txt");
  await writeFile(join(root, "tracked.txt"), "unstaged afterwards\n");
  const resolved = await readRebaseContinueDiagnostics(root);
  assert.deepEqual(resolved.unmergedFiles, []);
  assert.deepEqual(resolved.stagedFiles, ["tracked.txt"]);
  assert.deepEqual(resolved.unstagedFiles, ["tracked.txt"]);
  assert.equal((await runGit(["status", "--porcelain"], root)).includes("?? untracked.txt"), true);
});

test("completed rebase state and Changes refresh do not wait for the graph read", { timeout: 10_000 }, async t => {
  const { root } = await safetyFixture(t, "rebase-result-fast");
  const graph = deferred();
  t.after(graph.resolve);
  let graphStarted = false;
  const calls = recordGitCalls(t);
  const result = await readRebaseControlState({ logService: new GitLogService(root), refreshGraph: () => {
    graphStarted = true; return graph.promise;
  } }, "");
  assert.equal(result.status, "completed");
  assert.equal(graphStarted, true);
  assert.equal(calls.some(args => args[0] === "status"), false);
});

test("conflict focus avoids full diagnostics and graph refresh failures stay separate from Git results", async t => {
  const { root } = await safetyFixture(t, "conflict-focus-fast");
  const calls = recordGitCalls(t);
  const commandsSeen: string[] = [];
  t.mock.method(commands, "executeCommand", async (id: string) => { commandsSeen.push(id); });
  await focusRebaseConflicts(root, { files: ["tracked.txt"] });
  assert.deepEqual(calls, []);
  assert.deepEqual(commandsSeen.slice(0, 2), ["gitSimpleCompare.refreshConflicts", "gitSimpleCompare.conflicts.focus"]);
  refreshAfterRebaseControl({ refreshGraph: async () => { throw new Error("graph unavailable"); } }, "testRebase");
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(commandsSeen.includes("gitSimpleCompare.refreshChanges"));
});

test("todo and diagnostics read the linked worktree metadata and immediately observe Continue", async t => {
  const { root, directory, head } = await safetyFixture(t, "rebase-worktree-progress");
  await commitText(root, "main\n", "main");
  const linked = join(directory, "linked");
  await git(root, "worktree", "add", "-qb", "linked", linked, head);
  await commitText(linked, "linked\n", "linked");
  await assert.rejects(git(linked, "rebase", "main"));
  const calls = recordGitCalls(t);
  const progress = await readRebaseTodoProgress(linked);
  assert.equal(progress?.total, 1);
  assert.equal(calls.length, 2);
  assert.equal(await readRebaseTodoProgress(root), undefined);
  const diagnostics = await readRebaseContinueDiagnostics(linked);
  assert.deepEqual(diagnostics.rebaseMessageConflicts, ["tracked.txt"]);
  await git(linked, "rebase", "--skip");
  calls.length = 0;
  assert.equal(await readRebaseTodoProgress(linked), undefined);
  assert.equal(calls.length, 1);
});
