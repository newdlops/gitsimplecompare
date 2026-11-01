import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { RemoteBranchService } from "../src/git/remoteBranchService";
import { runGitWithInput } from "../src/git/gitExec";
import { addOrigin, git, safetyFixture } from "./helpers/gitSafetyFixture";

test("remote setup reads two thousand branches in three Git calls without calculating divergence", async t => {
  const f = await safetyFixture(t, "remote-state-efficiency"); await addOrigin(f.root, f.directory);
  await runGitWithInput(["update-ref", "--stdin"], f.root,
    Array.from({ length: 2117 }, (_, n) => `create refs/remotes/origin/extra-${n} ${f.head}\n`).join(""));
  await writeFile(join(f.root, "tracked.txt"), "keep unstaged\n");
  const before = { index: await readFile(join(f.root, ".git/index")), config: await readFile(join(f.root, ".git/config")) };
  const calls: string[] = [], stop = setGitExecutionObserver(row => { if (row.repoRoot === f.root) calls.push(row.command); });
  let state;
  try { state = await new RemoteBranchService(f.root).getCurrentBranchRemoteState(); } finally { stop(); }
  assert.equal(state.branch, "main"); assert.equal(state.upstream, "origin/main"); assert.equal(state.upstreamGone, false);
  assert.equal(state.remoteBranches.length, 2118); assert.deepEqual(state.remotes, ["origin"]);
  assert.equal(calls.length, 3, JSON.stringify(calls));
  assert.deepEqual(await readFile(join(f.root, ".git/index")), before.index);
  assert.deepEqual(await readFile(join(f.root, ".git/config")), before.config);
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "keep unstaged\n");
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
});

test("gone upstream identity remains available for removal, without matching a child ref", async t => {
  const f = await safetyFixture(t, "remote-state-gone"); await addOrigin(f.root, f.directory);
  await git(f.root, "update-ref", "-d", "refs/remotes/origin/main");
  await git(f.root, "update-ref", "refs/remotes/origin/main/child", f.head);
  const service = new RemoteBranchService(f.root), state = await service.getCurrentBranchRemoteState();
  assert.equal(state.upstream, "origin/main"); assert.equal(state.upstreamGone, true);
  assert.deepEqual(state.remoteBranches.map(row => row.name), ["origin/main/child"]);
  assert.equal((await service.unsetCurrentBranchUpstream()).upstream, "origin/main");
  assert.equal(await git(f.root, "config", "--local", "--get-regexp", "^user\\."), "user.name Git Safety Test\nuser.email git-safety@example.test");
});

test("canonical remote names survive a colliding local branch and only symbolic aliases are excluded", async t => {
  const f = await safetyFixture(t, "remote-state-names"); await addOrigin(f.root, f.directory);
  await git(f.root, "branch", "origin/main");
  await git(f.root, "update-ref", "refs/remotes/origin/HEAD", f.head);
  await git(f.root, "symbolic-ref", "refs/remotes/origin/alias", "refs/remotes/origin/main");
  const state = await new RemoteBranchService(f.root).getCurrentBranchRemoteState();
  assert.equal(state.upstream, "origin/main");
  assert.deepEqual(state.remoteBranches.map(row => row.name), ["origin/HEAD", "origin/main"]);
  const service = new RemoteBranchService(f.root);
  await service.setCurrentBranchUpstream("origin/main");
  assert.equal(await git(f.root, "config", "branch.main.remote"), "origin");
  await git(f.root, "remote", "set-url", "origin", "https://github.com/fixture/repo.git");
  assert.deepEqual(await service.getCurrentBranchLink(), { kind: "linked", upstream: "origin/main", url: "https://github.com/fixture/repo/tree/main" });
});

for (const mode of ["detached", "unborn", "local-dot", "custom-fetch", "linked"] as const) {
  test(`remote setup retains ${mode} checkout/upstream semantics`, async t => {
    const f = await safetyFixture(t, `remote-state-${mode}`); await addOrigin(f.root, f.directory);
    let root = f.root;
    if (mode === "detached") await git(root, "switch", "--detach", "-q");
    if (mode === "unborn") { root = join(f.directory, "unborn"); await mkdir(root); await git(root, "init", "-q", "-b", "new"); }
    if (mode === "local-dot") { await git(root, "branch", "base"); await git(root, "branch", "--set-upstream-to=base", "main"); }
    if (mode === "custom-fetch") {
      await git(root, "config", "remote.origin.fetch", "+refs/heads/*:refs/custom/origin/*");
      await git(root, "update-ref", "refs/custom/origin/main", f.head);
    }
    if (mode === "linked") { root = join(f.directory, "linked"); await git(f.root, "worktree", "add", "-qb", "linked", root); }
    const state = await new RemoteBranchService(root).getCurrentBranchRemoteState();
    assert.equal(state.branch, mode === "detached" ? undefined : mode === "unborn" ? "new" : mode === "linked" ? "linked" : "main");
    assert.equal(state.upstream, mode === "local-dot" ? "base" : mode === "custom-fetch" ? "custom/origin/main" : undefined);
    assert.equal(state.upstreamGone, false);
  });
}

test("invalid repositories and corrupt config never become successful empty remote states", async t => {
  const f = await safetyFixture(t, "remote-state-failure"), invalid = join(f.directory, "invalid"); await mkdir(invalid);
  await assert.rejects(new RemoteBranchService(invalid).getCurrentBranchRemoteState(), /not a git repository/i);
  await assert.rejects(new RemoteBranchService(invalid).getCurrentBranchLink(), /not a git repository/i);
  await writeFile(join(f.root, ".git/config"), "[broken\n");
  await assert.rejects(new RemoteBranchService(f.root).getCurrentBranchRemoteState(), /bad config|invalid config/i);
  await assert.rejects(new RemoteBranchService(f.root).getCurrentBranchLink(), /bad config|invalid config/i);
});
