import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BranchOperationService } from "../src/git/branchOperationService";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { OperationUndoStore } from "../src/git/operationUndoStore";
import { cleanupFixtureBranchWorktrees, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 테스트 저장소가 소유한 branch worktree만 찾아 원본 fixture보다 먼저 정리한다. */
async function fixture(t: TestContext) {
  const cleanups: Array<() => unknown> = [];
  const f = await safetyFixture({ after: (cleanup: () => unknown) => cleanups.push(cleanup) } as TestContext, "branch-squash-completion");
  t.after(async () => {
    await cleanupFixtureBranchWorktrees(f.root);
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
  await git(f.root, "switch", "-qc", "source");
  await writeFile(join(f.root, "source.txt"), "source content\n");
  await git(f.root, "add", "source.txt"); await git(f.root, "commit", "-qm", "source");
  const sourceTree = await git(f.root, "rev-parse", "HEAD^{tree}");
  await git(f.root, "switch", "main"); await git(f.root, "branch", "other");
  return { ...f, sourceTree, service: new BranchOperationService(f.root) };
}

/** 이미 소유 fixture의 Native 등록에 있는 branch 작업 경로만 반환한다. */
async function worktrees(root: string): Promise<string[]> {
  return (await git(root, "worktree", "list", "--porcelain")).split("\n")
    .filter(line => line.startsWith("worktree ") && line.includes("gsc-branch-operation-"))
    .map(line => line.slice("worktree ".length));
}

/** 실제 Git commit --only로 squash index를 소비하지 않고 외부 사용자의 새 commit을 만든다. */
async function externalCommit(root: string): Promise<string> {
  await writeFile(join(root, "external.txt"), "external work\n");
  await git(root, "add", "external.txt");
  await git(root, "commit", "-qm", "external commit", "--only", "--", "external.txt");
  return git(root, "rev-parse", "HEAD");
}

for (const change of ["switch", "commit"] as const) {
  test(`clean squash stops before automatic commit after a post-merge ${change}`, async t => {
    const f = await fixture(t), runtime = f.service as any, pending = runtime.hasPendingChanges.bind(runtime);
    let expected = "";
    t.mock.method(runtime, "hasPendingChanges", async () => {
      const result = await pending();
      if (change === "switch") { await git(f.root, "switch", "other"); expected = f.head; }
      else expected = await externalCommit(f.root);
      return result;
    });
    const error = await f.service.squashMerge("source").then(() => undefined, error => error);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), expected);
    assert.equal(await git(f.root, "symbolic-ref", "--short", "HEAD"), change === "switch" ? "other" : "main");
    assert.equal(await git(f.root, "diff", "--cached", "--name-only"), "source.txt");
    assert.equal(await readFile(join(f.root, "source.txt"), "utf8"), "source content\n");
    assert.equal(await f.service.hasUndoSnapshot("main"), false);
    assert.match(String(error), /Ref safety/);
  });
}

for (const dirty of [false, true]) {
  test(`squash cannot adopt a later descendant as its own single commit (${dirty ? "isolated" : "current"})`, async t => {
    const f = await fixture(t), runtime = f.service as any, commit = runtime.commitSquash.bind(runtime);
    if (dirty) await writeFile(join(f.root, "local.txt"), "preserve local work\n");
    let own = "", later = "", resultRoot = "";
    t.mock.method(runtime, "commitSquash", async (...args: any[]) => {
      await commit(...args); resultRoot = args[2]; own = await git(resultRoot, "rev-parse", "HEAD");
      later = await externalCommit(resultRoot);
    });
    await assert.rejects(f.service.squashMerge("source"), /squash result|squash commit/);
    assert.ok(own && later && own !== later);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), dirty ? f.head : later);
    assert.equal(await git(resultRoot, "rev-parse", "HEAD^"), own);
    assert.equal(await readFile(join(resultRoot, "external.txt"), "utf8"), "external work\n");
    assert.equal(await f.service.hasUndoSnapshot("main"), false);
    if (dirty) {
      assert.deepEqual(await worktrees(f.root), [await realpath(resultRoot)]);
      assert.equal(await readFile(join(f.root, "local.txt"), "utf8"), "preserve local work\n");
    }
  });
}

test("an isolated squash commit rejection preserves its staged result for manual recovery", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "local.txt"), "preserve local work\n");
  await writeFile(join(f.directory, "hooks/prepare-commit-msg"), "#!/bin/sh\necho 'controlled message rejection' >&2\nexit 1\n", { mode: 0o755 });
  const originalIndex = await readFile(join(f.root, ".git/index"));
  await assert.rejects(f.service.squashMerge("source"), /preserved temporary worktree/);
  const [owned] = await worktrees(f.root); assert.ok(owned);
  assert.equal(await git(owned, "write-tree"), f.sourceTree);
  assert.equal(await git(owned, "rev-parse", "HEAD"), f.head);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
  assert.deepEqual(await readFile(join(f.root, ".git/index")), originalIndex);
  assert.equal(await readFile(join(f.root, "local.txt"), "utf8"), "preserve local work\n");
  assert.equal(await f.service.hasUndoSnapshot("main"), false);
});

for (const dirty of [false, true]) for (const source of ["same-tip", "source", "ancestor"]) {
  test(`a no-change ${source} squash preserves previous Undo (${dirty ? "dirty" : "clean"})`, async t => {
    const f = await fixture(t), first = await f.service.squashMerge("source"), plan = await f.service.prepareUndo();
    await git(f.root, "branch", "same-tip");
    await git(f.root, "branch", "ancestor", f.head);
    if (dirty) await writeFile(join(f.root, "local.txt"), "keep local work\n");
    const originalIndex = await readFile(join(f.root, ".git/index"));
    const refs = await git(f.root, "for-each-ref", "--format=%(refname)%00%(objectname)");
    const calls: string[] = [], stop = setGitExecutionObserver(row => calls.push(row.command));
    try { await assert.rejects(f.service.squashMerge(source), /did not produce changes/); } finally { stop(); }
    assert.equal(await git(f.root, "rev-parse", "HEAD"), first.afterHead);
    assert.deepEqual(await f.service.prepareUndo(), plan);
    assert.equal(await git(f.root, "for-each-ref", "--format=%(refname)%00%(objectname)"), refs);
    assert.deepEqual(await readFile(join(f.root, ".git/index")), originalIndex);
    if (source === "same-tip") {
      assert.equal(calls.length, 3);
      assert.equal(calls.some(command => ["worktree", "update-ref", "merge", "status"].includes(command)), false);
    }
    if (dirty) assert.equal(await readFile(join(f.root, "local.txt"), "utf8"), "keep local work\n");
  });
}

test("rebase rejects a changed checkout before stashing that branch's staged and unstaged work", async t => {
  const f = await fixture(t), runtime = f.service as any, resolve = runtime.resolveCommit.bind(runtime);
  let originalIndex: Buffer | undefined;
  t.mock.method(runtime, "resolveCommit", async (target: string) => {
    const oid = await resolve(target);
    await git(f.root, "switch", "other");
    await writeFile(join(f.root, "tracked.txt"), "other staged work\n"); await git(f.root, "add", "tracked.txt");
    await writeFile(join(f.root, "tracked.txt"), "other unstaged work\n");
    await writeFile(join(f.root, "local.txt"), "other untracked work\n");
    originalIndex = await readFile(join(f.root, ".git/index"));
    return oid;
  });
  await assert.rejects(f.service.rebaseMerge("source"), /Ref safety/);
  assert.equal(await git(f.root, "symbolic-ref", "--short", "HEAD"), "other");
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
  assert.deepEqual(await readFile(join(f.root, ".git/index")), originalIndex);
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "other unstaged work\n");
  assert.equal(await readFile(join(f.root, "local.txt"), "utf8"), "other untracked work\n");
  assert.equal(await git(f.root, "stash", "list"), "");
});

for (const change of ["switch", "commit"] as const) test(`isolated squash revalidates the original checkout inside its index lock (${change})`, async t => {
  const f = await fixture(t), runtime = f.service as any, commit = runtime.commitSquash.bind(runtime);
  await writeFile(join(f.root, "local.txt"), "keep local work\n");
  let expected = "", resultRoot = "";
  t.mock.method(runtime, "commitSquash", async (...args: any[]) => {
    await commit(...args); resultRoot = args[2];
    if (change === "switch") { await git(f.root, "switch", "other"); expected = f.head; }
    else expected = await externalCommit(f.root);
  });
  await assert.rejects(f.service.squashMerge("source"), /Ref safety/);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), expected);
  assert.equal(await git(f.root, "symbolic-ref", "--short", "HEAD"), change === "switch" ? "other" : "main");
  assert.equal(await git(f.root, "diff", "--cached", "--name-only"), "");
  assert.equal(await readFile(join(f.root, "local.txt"), "utf8"), "keep local work\n");
  assert.equal(await git(resultRoot, "rev-parse", "HEAD^{tree}"), f.sourceTree);
  assert.deepEqual(await worktrees(f.root), [await realpath(resultRoot)]);
});

test("a squash conflict without verified recovery ownership remains an error with its files intact", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "source.txt"), "conflicting destination\n");
  await git(f.root, "add", "source.txt"); await git(f.root, "commit", "-qm", "destination");
  const head = await git(f.root, "rev-parse", "HEAD");
  t.mock.method(OperationUndoStore.prototype, "capture", async () => { throw new Error("controlled recovery failure"); });
  await assert.rejects(f.service.squashMerge("source"), /git merge failed/);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), head);
  assert.notEqual(await git(f.root, "ls-files", "--unmerged"), "");
  assert.match(await readFile(join(f.root, "source.txt"), "utf8"), /<<<<<<< HEAD/);
  assert.equal(await f.service.hasUndoSnapshot(), false);
});

test("single-result validation supports SHA-256 and non-default log display configuration", async t => {
  const f = await fixture(t), root = join(f.directory, "sha256");
  await mkdir(root); await git(root, "init", "-qb", "main", "--object-format=sha256");
  for (const [key, value] of Object.entries({ "user.name": "Test", "user.email": "test@example.test", "commit.gpgsign": "false",
    "core.hooksPath": join(f.directory, "hooks"), "core.fsmonitor": "false", "log.showSignature": "true", "log.decorate": "full" }))
    await git(root, "config", key, value);
  await writeFile(join(root, "base.txt"), "base\n"); await git(root, "add", "."); await git(root, "commit", "-qm", "base");
  const base = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "-qc", "source");
  await writeFile(join(root, "source.txt"), "source\n"); await git(root, "add", "."); await git(root, "commit", "-qm", "source");
  const tree = await git(root, "rev-parse", "HEAD^{tree}"); await git(root, "switch", "main");
  const service = new BranchOperationService(root), result = await service.squashMerge("source");
  assert.equal(result.afterHead.length, 64); assert.equal(await git(root, "rev-parse", "HEAD^"), base);
  assert.equal(await git(root, "rev-parse", "HEAD^{tree}"), tree);
  await service.undoLastOperation(); assert.equal(await git(root, "rev-parse", "HEAD"), base);
});

test("a merge result with the expected first parent is still not a single squash commit", async t => {
  const f = await fixture(t), runtime = f.service as any, commit = runtime.commitSquash.bind(runtime);
  let foreign = "";
  t.mock.method(runtime, "commitSquash", async (...args: any[]) => {
    await commit(...args);
    foreign = await git(f.root, "commit-tree", f.sourceTree, "-p", f.head, "-p", "source", "-m", "external merge");
    const own = await git(f.root, "rev-parse", "HEAD");
    await git(f.root, "update-ref", "HEAD", foreign, own);
  });
  await assert.rejects(f.service.squashMerge("source"), /squash result/);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), foreign);
  assert.equal(await git(f.root, "rev-parse", "HEAD^1"), f.head);
  assert.equal(await f.service.hasUndoSnapshot(), false);
});
