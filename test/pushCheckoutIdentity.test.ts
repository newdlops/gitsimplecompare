import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rename } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readPushCheckoutIdentity } from "../src/git/pushCheckoutIdentity";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

test("push checkout reads current and upstream commits in one process without changing the index", async t => {
  const f = await safetyFixture(t, "push-combined-checkout");
  await addOrigin(f.root, f.directory);
  const current = await commitText(f.root, "current\n", "current"), index = path.join(f.root, ".git/index");
  const bytes = await readFile(index), commands: string[] = [];
  const stop = setGitExecutionObserver(value => commands.push(value.command)); t.after(stop);
  const result = await readPushCheckoutIdentity(f.root); stop();
  assert.deepEqual(commands, ["rev-parse"]);
  assert.equal(result.checkout.head, current); assert.equal(result.upstreamCommit, f.head);
  assert.equal(result.checkout.branchRef, "refs/heads/main"); assert.equal(result.checkout.branch, "main");
  assert.equal(result.checkout.gitDir, await realpath(path.join(f.root, ".git")));
  assert.deepEqual(await readFile(index), bytes);
});

test("a missing upstream keeps the current checkout and uses only the original two reads", async t => {
  const f = await safetyFixture(t, "push-combined-no-upstream"), commands: string[] = [];
  const stop = setGitExecutionObserver(value => commands.push(value.command)); t.after(stop);
  const result = await readPushCheckoutIdentity(f.root); stop();
  assert.deepEqual(commands, ["rev-parse", "rev-parse"]);
  assert.equal(result.checkout.head, f.head); assert.equal(result.checkout.branch, "main");
  assert.equal(result.upstreamCommit, undefined);
});

test("combined checkout preserves newline and trailing spaces in the Git directory", async t => {
  const f = await safetyFixture(t, "push-combined-directory");
  await addOrigin(f.root, f.directory);
  const root = path.join(f.directory, `worktree\n${f.head}\ntrailing  `); await rename(f.root, root);
  const result = await readPushCheckoutIdentity(root);
  assert.equal(result.checkout.gitDir, await realpath(path.join(root, ".git")));
  assert.equal(result.checkout.head, f.head); assert.equal(result.upstreamCommit, f.head);
  assert.equal(result.checkout.branch, "main");
});

test("ambiguous HEAD tags retain the real current branch and original upstream", async t => {
  const f = await safetyFixture(t, "push-combined-ambiguous");
  await addOrigin(f.root, f.directory);
  await git(f.root, "update-ref", "refs/tags/HEAD", f.head);
  const result = await readPushCheckoutIdentity(f.root);
  assert.equal(result.checkout.branch, "main"); assert.equal(result.checkout.head, f.head);
  assert.equal(result.upstreamCommit, f.head);
});

test("a detached checkout is never reported as a current local branch", async t => {
  const f = await safetyFixture(t, "push-combined-detached");
  await addOrigin(f.root, f.directory); await git(f.root, "switch", "--detach", f.head);
  const result = await readPushCheckoutIdentity(f.root);
  assert.equal(result.checkout.head, f.head); assert.equal(result.checkout.branchRef, "");
  assert.equal(result.checkout.branch, ""); assert.equal(result.upstreamCommit, undefined);
});

test("a linked worktree retains its private metadata directory and tracking commit", async t => {
  const f = await safetyFixture(t, "push-combined-linked"), root = path.join(f.directory, "linked");
  await addOrigin(f.root, f.directory);
  await git(f.root, "worktree", "add", "-q", "--track", "-b", "linked", root, "origin/main");
  const result = await readPushCheckoutIdentity(root);
  assert.equal(result.checkout.head, f.head); assert.equal(result.upstreamCommit, f.head);
  assert.equal(result.checkout.branch, "linked");
  assert.equal(result.checkout.gitDir, await realpath(path.resolve(root, await git(root, "rev-parse", "--absolute-git-dir"))));
  assert.notEqual(result.checkout.gitDir, path.join(f.root, ".git"));
});

test("SHA-256 checkout and upstream commits remain complete native object IDs", async t => {
  const f = await safetyFixture(t, "push-combined-sha256"), root = path.join(f.directory, "sha256"); await mkdir(root);
  await git(root, "init", "-q", "--object-format=sha256", "-b", "main");
  await git(root, "config", "user.name", "SHA-256 Fixture"); await git(root, "config", "user.email", "sha256@example.invalid");
  await git(root, "config", "core.hooksPath", path.join(f.directory, "hooks"));
  await git(root, "config", "commit.gpgsign", "false");
  const base = await commitText(root, "base\n", "base"); await git(root, "branch", "base");
  await git(root, "config", "branch.main.remote", "."); await git(root, "config", "branch.main.merge", "refs/heads/base");
  const head = await commitText(root, "next\n", "next"), result = await readPushCheckoutIdentity(root);
  assert.equal(head.length, 64); assert.equal(result.checkout.head, head); assert.equal(result.upstreamCommit, base);
  assert.equal(result.checkout.branchRef, "refs/heads/main");
});
