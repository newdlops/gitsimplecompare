import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runGit, runGitWithInput } from "../src/git/gitExec";
import { readGraphRefreshSnapshot, type GraphFingerprintRunner } from "../src/git/graphRefreshFingerprint";
import { readGraphLocalBranchSnapshot } from "../src/git/graphLocalBranches";
import { canIncludeGraphBranchMetadata } from "../src/git/graphRefSnapshot";
import { readGraphLocalBranchData } from "../src/webview/graphBranchLoading";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

test("a small direct fingerprint shares exact fresh branch metadata without another branch read", async t => {
  const f = await safetyFixture(t, "graph-branch-fingerprint"); await addOrigin(f.root, f.directory);
  await git(f.root, "branch", "topic"); await commitText(f.root, "ahead\n", "ahead");
  const calls: string[][] = [];
  const runner: GraphFingerprintRunner = (args, root, options) => { calls.push(args); return runGit(args, root, options); };
  const snapshot = await readGraphRefreshSnapshot(f.root, runner, undefined, true);
  assert.equal(calls.length, 2); assert.equal(calls.filter(args => args[0] === "for-each-ref").length, 1);
  const actual = await readGraphLocalBranchSnapshot(f.root);
  assert.deepEqual(snapshot.localBranches, actual.branches);
  assert.equal(snapshot.fingerprint, (await readGraphRefreshSnapshot(f.root)).fingerprint);
  const data = await readGraphLocalBranchData({ repoRoot: f.root, getLocalBranchSnapshot: async () => { throw new Error("metadata was already read"); } },
    snapshot.worktrees, new AbortController().signal, snapshot.localBranches);
  assert.deepEqual(data.branches, actual.branches);
  data.branches[0].subject = "consumer changed its copy";
  assert.notEqual(snapshot.localBranches![0].subject, data.branches[0].subject);
});

test("count caps object metadata and falls back to all ref names without truncating a large fetch", async t => {
  const { root, head } = await safetyFixture(t, "graph-branch-fingerprint-limit");
  const refs = Array.from({ length: 300 }, (_, index) => `update refs/remotes/origin/remote-${String(index).padStart(3, "0")} ${head}`);
  await runGitWithInput(["update-ref", "--stdin"], root, `${refs.join("\n")}\n`);
  await mkdir(join(root, ".git", "refs", "remotes", "zzzz"), { recursive: true });
  await writeFile(join(root, ".git", "refs", "remotes", "zzzz", "broken"), `${"b".repeat(40)}\n`);
  const calls: string[][] = []; let cappedReadSucceeded = false;
  const runner: GraphFingerprintRunner = async (args, cwd, options) => {
    calls.push(args); const output = await runGit(args, cwd, options);
    if (args.some(arg => arg.startsWith("--count="))) cappedReadSucceeded = true;
    return output;
  };
  const snapshot = await readGraphRefreshSnapshot(root, runner, undefined, true);
  assert.equal(cappedReadSucceeded, true, "objects beyond the cap must not be read for sorting/formatting");
  assert.equal(calls.filter(args => args[0] === "for-each-ref").length, 2);
  assert.equal(snapshot.localBranches, undefined); assert.equal(snapshot.remoteTips?.length, 301);
  assert.equal(snapshot.fingerprint, (await readGraphRefreshSnapshot(root)).fingerprint);
});

test("corrupt local metadata keeps the original ref health fallback available", async t => {
  const { root } = await safetyFixture(t, "graph-branch-fingerprint-corrupt");
  await writeFile(join(root, ".git", "refs", "heads", "bad"), `${"b".repeat(40)}\n`);
  const snapshot = await readGraphRefreshSnapshot(root, undefined, undefined, true);
  assert.equal(snapshot.localBranches, undefined);
  const original = await readGraphLocalBranchSnapshot(root);
  assert.equal(original.branches.length, 1); assert.equal(original.invalidRefs.length, 1);
});

test("metadata from another HEAD observation is not reused for the current checkout", async t => {
  const { root } = await safetyFixture(t, "graph-branch-fingerprint-race");
  const runner: GraphFingerprintRunner = async (args, cwd, options) => {
    const output = await runGit(args, cwd, options);
    return args[0] === "worktree" ? output.replace("branch refs/heads/main", "branch refs/heads/other") : output;
  };
  assert.equal((await readGraphRefreshSnapshot(root, runner, undefined, true)).localBranches, undefined);
});

test("large or distant tracking sets retain the existing batch strategy and cancelled snapshots never retry", async t => {
  const { root } = await safetyFixture(t, "graph-branch-fingerprint-policy");
  const branch = (await readGraphLocalBranchSnapshot(root)).branches[0];
  assert.equal(canIncludeGraphBranchMetadata([branch], 1), true);
  assert.equal(canIncludeGraphBranchMetadata([branch], 257), false);
  assert.equal(canIncludeGraphBranchMetadata([branch], 200), false);
  assert.equal(canIncludeGraphBranchMetadata([{ ...branch, ahead: 10000 }], 1), false);
  assert.equal(canIncludeGraphBranchMetadata(Array.from({ length: 128 }, () => ({ ...branch, upstream: "origin/main" })), 128), false);
  const controller = new AbortController(); let refReads = 0;
  const runner: GraphFingerprintRunner = async args => {
    if (args[0] === "for-each-ref") { refReads++; controller.abort(); throw new Error("cancelled fixture"); }
    return "";
  };
  await assert.rejects(readGraphRefreshSnapshot(root, runner, controller.signal, true));
  assert.equal(refReads, 1);
});
