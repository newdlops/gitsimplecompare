import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runGit } from "../src/git/gitExec";
import { RepositoryIndexPathReader } from "../src/git/repositoryIndexPath";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

test("index path reuse still observes metadata identity after commits and new index content", async t => {
  const f = await safetyFixture(t, "index-path-reuse"); let calls = 0;
  const reader = new RepositoryIndexPathReader(f.root, (...args) => { calls++; return runGit(...args); });
  const initial = await reader.read(new AbortController().signal);
  await commitText(f.root, "changed index\n", "changed index");
  const next = await reader.read(new AbortController().signal);
  assert.equal(next.file, path.join(f.root, ".git/index")); assert.equal(next.file, initial.file);
  assert.equal(await reader.unchanged(initial, new AbortController().signal), true);
  assert.equal(calls, 1);
  reader.clear(); await reader.read(new AbortController().signal); assert.equal(calls, 2);
});

test("a linked worktree uses Git's private index location across repeated reads", async t => {
  const f = await safetyFixture(t, "linked-index-path"), root = path.join(f.directory, "linked");
  await git(f.root, "worktree", "add", "-q", "-b", "linked", root);
  let calls = 0;
  const reader = new RepositoryIndexPathReader(root, (...args) => { calls++; return runGit(...args); });
  const first = await reader.read(new AbortController().signal), next = await reader.read(new AbortController().signal);
  assert.equal(first.file, path.resolve(root, await git(root, "rev-parse", "--git-path", "index")));
  assert.deepEqual(next, first); assert.equal(calls, 1);
});

test("repointing a gitfile invalidates the old result and resolves the new repository", async t => {
  const f = await safetyFixture(t, "index-path-old"), other = await safetyFixture(t, "index-path-new");
  let calls = 0;
  const reader = new RepositoryIndexPathReader(f.root, (...args) => { calls++; return runGit(...args); });
  const initial = await reader.read(new AbortController().signal);
  await rename(path.join(f.root, ".git"), path.join(f.directory, "saved.git"));
  await writeFile(path.join(f.root, ".git"), `gitdir: ${path.join(other.root, ".git")}\n`);
  assert.equal(await reader.unchanged(initial, new AbortController().signal), false);
  const next = await reader.read(new AbortController().signal);
  assert.equal(next.file, path.resolve(f.root, await git(f.root, "rev-parse", "--git-path", "index"))); assert.equal(calls, 2);
});

test("a locator changed during native resolution cannot establish a reusable path", async t => {
  const f = await safetyFixture(t, "index-path-changing"), other = await safetyFixture(t, "index-path-replacement");
  let calls = 0;
  const reader = new RepositoryIndexPathReader(f.root, async (...args) => {
    const result = await runGit(...args);
    if (++calls === 1) {
      await rename(path.join(f.root, ".git"), path.join(f.directory, "saved.git"));
      await writeFile(path.join(f.root, ".git"), `gitdir: ${path.join(other.root, ".git")}\n`);
    }
    return result;
  });
  await assert.rejects(reader.read(new AbortController().signal), /metadata changed while resolving/);
  const next = await reader.read(new AbortController().signal);
  assert.equal(next.file, path.resolve(f.root, await git(f.root, "rev-parse", "--git-path", "index"))); assert.equal(calls, 2);
});

test("Git environment changes force fresh path resolution", async t => {
  const f = await safetyFixture(t, "index-path-environment"); let calls = 0;
  const previous = process.env.GIT_NAMESPACE;
  t.after(() => { if (previous === undefined) delete process.env.GIT_NAMESPACE; else process.env.GIT_NAMESPACE = previous; });
  const reader = new RepositoryIndexPathReader(f.root, (...args) => { calls++; return runGit(...args); });
  const first = await reader.read(new AbortController().signal);
  process.env.GIT_NAMESPACE = "index-path-fixture";
  assert.equal(await reader.unchanged(first, new AbortController().signal), false);
  await reader.read(new AbortController().signal); assert.equal(calls, 2);
});

test("unavailable metadata never caches a guessed path or proves a previous result current", async () => {
  let calls = 0;
  const reader = new RepositoryIndexPathReader("/gsc-index-path-fixture-missing", async () => { calls++; return "/fixture/index\n"; });
  const first = await reader.read(new AbortController().signal);
  await reader.read(new AbortController().signal); assert.equal(calls, 2);
  assert.equal(await reader.unchanged(first, new AbortController().signal), false); assert.equal(calls, 2);
});

test("failed resolution and cancelled reads never become cached successes", async t => {
  const f = await safetyFixture(t, "index-path-failure"); let calls = 0;
  const failure = new Error("index path failed");
  const reader = new RepositoryIndexPathReader(f.root, (...args) => { if (++calls === 1) throw failure; return runGit(...args); });
  await assert.rejects(reader.read(new AbortController().signal), value => value === failure);
  await reader.read(new AbortController().signal); assert.equal(calls, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reader.read(controller.signal), /abort/i); assert.equal(calls, 2);
});
