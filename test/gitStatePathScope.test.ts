import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { resolveGitStatePath, withGitStatePathScope } from "../src/git/gitStatePathScope";
import { assertCurrentBranchHead } from "../src/git/refSafety";
import { readGitCheckoutIdentity, readGitDirectory } from "../src/git/repositoryIdentity";
import { git, safetyFixture, commitText } from "./helpers/gitSafetyFixture";

const STATE = "gitsimplecompare/deferred-commit-rebase-state.json";

/** 실제 Git 자식 실행은 유지하면서 상태 경로 조회 수만 집계한다. */
function recordStatePaths(t: TestContext, option = "--git-path") {
  const calls: string[][] = [], original = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof original>) => {
    if (Array.isArray(args[1]) && args[1].includes(option)) calls.push([...args[1]]);
    return (original as Function)(...args);
  });
  return calls;
}

test("one operation shares concurrent private path reads and the next operation reads again", async t => {
  const { root } = await safetyFixture(t, "state-path-scoped"), calls = recordStatePaths(t);
  const values = await withGitStatePathScope(root, () => Promise.all(Array.from({ length: 6 }, () => resolveGitStatePath(root, STATE))));
  assert.equal(new Set(values).size, 1); assert.equal(calls.length, 1);
  await withGitStatePathScope(root, () => resolveGitStatePath(root, STATE));
  assert.equal(calls.length, 2);
  await resolveGitStatePath(root, STATE); await resolveGitStatePath(root, STATE);
  assert.equal(calls.length, 4, "unscoped recovery calls must not inherit a stale path cache");
});

test("metadata directory reads share only inside an operation and cancellable consumers keep their own lifetime", async t => {
  const { root } = await safetyFixture(t, "state-directory-scoped"), calls = recordStatePaths(t, "--absolute-git-dir");
  await withGitStatePathScope(root, async () => {
    const values = await Promise.all([readGitDirectory(root), readGitDirectory(root), readGitDirectory(root)]);
    assert.equal(new Set(values).size, 1); assert.equal(calls.length, 1);
    await assert.rejects(readGitDirectory(root, AbortSignal.abort()), /cancelled|abort/i);
    await readGitDirectory(root, new AbortController().signal);
    assert.equal(calls.length, 2, "a cancellable UI read must not borrow the mutation scope's promise");
  });
  await readGitDirectory(root); assert.equal(calls.length, 3);
});

test("a fresh checkout safety read supplies only the immutable directory and later HEAD reads stay fresh", async t => {
  const { root } = await safetyFixture(t, "state-directory-from-identity"), calls = recordStatePaths(t, "--absolute-git-dir");
  await withGitStatePathScope(root, async () => {
    const before = await readGitCheckoutIdentity(root);
    assert.equal(await readGitDirectory(root), before.gitDir);
    assert.equal(calls.length, 1, "directory must come from the actual fresh checkout read");
    await commitText(root, "next\n", "next");
    const after = await readGitCheckoutIdentity(root);
    assert.notEqual(after.head, before.head); assert.equal(calls.length, 2, "each HEAD guard still invokes Git");
    assert.equal(await readGitDirectory(root), after.gitDir); assert.equal(calls.length, 2);
  });
});

test("scoped path reuse never caches HEAD or skips current branch safety checks", async t => {
  const { root, head } = await safetyFixture(t, "state-path-head");
  await withGitStatePathScope(root, async () => {
    await resolveGitStatePath(root, STATE);
    await commitText(root, "external commit\n", "external");
    await resolveGitStatePath(root, STATE);
    await assert.rejects(assertCurrentBranchHead(root, "main", head, "test"), /safety check failed/i);
  });
});

test("parallel repositories and linked worktrees retain distinct private paths", async t => {
  const first = await safetyFixture(t, "state-path-first"), second = await safetyFixture(t, "state-path-second");
  const linked = join(first.directory, "linked"); await git(first.root, "worktree", "add", "-qb", "linked", linked);
  const results = await Promise.all([first.root, second.root, linked].map(root => withGitStatePathScope(root, () => resolveGitStatePath(root, STATE))));
  assert.equal(new Set(results).size, 3);
  assert.match(results[2], /worktrees\/linked\/gitsimplecompare\//);
});

test("replacing a linked gitfile stops cached state access before another repository can be written", async t => {
  const first = await safetyFixture(t, "state-path-gitfile"), second = await safetyFixture(t, "state-path-other");
  const linked = join(first.directory, "linked"); await git(first.root, "worktree", "add", "-qb", "linked", linked);
  const locator = join(linked, ".git"), original = await readFile(locator);
  try {
    await withGitStatePathScope(linked, async () => {
      await resolveGitStatePath(linked, STATE);
      await writeFile(locator, `gitdir: ${join(second.root, ".git")}\n`);
      await assert.rejects(resolveGitStatePath(linked, STATE), /metadata changed/);
    });
  } finally { await writeFile(locator, original); }
});

test("replacing the metadata directory or inherited Git environment prevents stale path reuse", async t => {
  const { root } = await safetyFixture(t, "state-path-replaced"), source = join(root, ".git"), saved = join(root, ".git-saved");
  await withGitStatePathScope(root, async () => {
    await resolveGitStatePath(root, STATE); await rename(source, saved);
    try { await assert.rejects(resolveGitStatePath(root, STATE), /metadata changed/); }
    finally { await rename(saved, source); }
  });
  const previous = process.env.GIT_CONFIG_COUNT;
  try {
    await withGitStatePathScope(root, async () => {
      await resolveGitStatePath(root, STATE); process.env.GIT_CONFIG_COUNT = previous === "0" ? "1" : "0";
      await assert.rejects(resolveGitStatePath(root, STATE), /metadata changed/);
    });
  } finally { if (previous === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = previous; }
});

test("a detached continuation cannot keep a completed operation's path cache alive", async t => {
  const { root } = await safetyFixture(t, "state-path-detached"), calls = recordStatePaths(t);
  let release!: () => void, delayed!: Promise<string>;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await withGitStatePathScope(root, async () => {
    await resolveGitStatePath(root, STATE);
    delayed = gate.then(() => resolveGitStatePath(root, STATE));
  });
  release(); await delayed;
  assert.equal(calls.length, 2);
  await assert.rejects(resolveGitStatePath(root, "HEAD"), /Only private/);
});
