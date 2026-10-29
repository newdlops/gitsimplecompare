import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BranchOperationService } from "../src/git/branchOperationService";
import { createBranchSquashWorktree, createReplayWorktree, materializeReplayWorktree } from "../src/git/replayWorktree";
import { listPrOperationWorktrees } from "../src/git/temporaryWorktree";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { commitPreparedIndex } from "../src/git/preparedIndexCommit";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";
import { replayWorktreeFixture } from "./helpers/replayWorktreeFixture";

/** service가 commit할 실제 worktree를 관찰하되 Native merge/commit은 그대로 실행한다. */
function observeCommit(t: TestContext, service: BranchOperationService, inspect: (root: string) => Promise<void>) {
  const runtime = service as unknown as { commitSquash: (...args: [string, string, string, boolean?]) => Promise<void> };
  const commit = runtime.commitSquash.bind(service);
  return t.mock.method(runtime, "commitSquash", async (...args) => { await inspect(args[2]); return commit(...args); });
}

/** 사용자 원본 저장소를 포함하지 않고 branch 전용으로 생성한 worktree만 Native 목록에서 찾는다. */
async function branchWorktrees(root: string): Promise<string[]> {
  return (await git(root, "worktree", "list", "--porcelain")).split("\n")
    .filter(line => line.startsWith("worktree ") && line.includes("gsc-branch-operation-"))
    .map(line => line.slice("worktree ".length));
}

for (const entries of [1000, 5000]) test(`branch squash skips ${entries} unchanged files while Native merge produces the exact tree`, async t => {
  const f = await replayWorktreeFixture(t, false, entries), before = await f.originalState();
  const worktree = await createBranchSquashWorktree(f.root, f.beforeHead, f.source);
  f.ownWorktree(worktree.path);
  assert.equal(worktree.compact, true);
  assert.match(worktree.path, /gsc-branch-operation-/);
  assert.deepEqual(await listPrOperationWorktrees(f.root), []);
  await assert.rejects(access(join(worktree.path, f.paths[0])), { code: "ENOENT" });
  await git(worktree.path, "merge", "--squash", f.source);
  assert.equal(await git(worktree.path, "write-tree"), f.tree);
  await assert.rejects(access(join(worktree.path, f.paths[0])), { code: "ENOENT" });
  assert.deepEqual(await f.originalState(), before);
});

for (const entries of [1000, 5000]) test(`compact squash with ${entries} unchanged files preserves staged additions, unstaged edits and untracked files`, async t => {
  const f = await replayWorktreeFixture(t, false, entries), service = new BranchOperationService(f.root);
  let checked = false;
  observeCommit(t, service, async root => {
    checked = true;
    await assert.rejects(access(join(root, f.paths[0])), { code: "ENOENT" });
    assert.equal(await git(root, "write-tree"), f.tree);
  });
  const result = await service.squashMerge("source");
  assert.equal(checked, true); assert.equal(result.status, "completed");
  assert.equal(await git(f.root, "rev-parse", "HEAD^{tree}"), f.tree);
  assert.equal(await git(f.root, "log", "-1", "--format=%P"), f.beforeHead);
  assert.equal(await git(f.root, "log", "-1", "--format=%B"), "Squash merge 'source'\n\nSquash-merged branch 'source' into 'main'.");
  assert.equal(await git(f.root, "show", ":user.txt"), "staged user work");
  assert.equal(await readFile(join(f.root, "user.txt"), "utf8"), "unstaged user work\n");
  assert.equal(await readFile(join(f.root, "untracked.txt"), "utf8"), "untracked user work\n");
  assert.deepEqual(await branchWorktrees(f.root), []);
  // stage한 사용자 파일을 그대로 둔 상태에서 Undo가 이를 reset하지 않게 기존 보호도 유지한다.
  await assert.rejects(service.undoLastOperation(), /staged changes/);
  await git(f.root, "reset", "-q", "--", "user.txt");
  await service.undoLastOperation();
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.beforeHead);
  assert.equal(await readFile(join(f.root, "user.txt"), "utf8"), "unstaged user work\n");
});

for (const entries of [1000, 5000]) test(`compact squash conflicts expose ${entries} unchanged files and leave the original index untouched`, async t => {
  const f = await replayWorktreeFixture(t, true, entries), before = await f.originalState();
  await assert.rejects(new BranchOperationService(f.root).squashMerge("source"), /preserved temporary worktree/);
  const [worktree] = await branchWorktrees(f.root);
  assert.ok(worktree); f.ownWorktree(worktree);
  assert.equal(await readFile(join(worktree, f.paths[0]), "utf8"), "unchanged padding\n");
  assert.equal(await readFile(join(worktree, f.paths.at(-1)!), "utf8"), "unchanged padding\n");
  assert.match(await readFile(join(worktree, "tracked.txt"), "utf8"), /<<<<<<< HEAD/);
  assert.notEqual(await git(worktree, "ls-files", "--unmerged"), "");
  assert.equal((await git(worktree, "ls-files", "-t")).split("\n").some(line => line.startsWith("S ")), false);
  assert.deepEqual(await f.originalState(), before);
});

for (const entries of [995, 996, 997]) test(`branch compact selection validates the committed index at the ${entries}-padding boundary`, async t => {
  // 원본 index에는 staged user.txt가 하나 더 있다. 크기 힌트만으로 새 Native index의 항목 수를 확정하지 않는다.
  const f = await replayWorktreeFixture(t, false, entries), before = await f.originalState();
  const branch = await createBranchSquashWorktree(f.root, f.beforeHead, f.source);
  f.ownWorktree(branch.path);
  assert.equal(branch.compact, entries === 997);
  await git(branch.path, "merge", "--squash", f.source);
  assert.equal(await git(branch.path, "write-tree"), f.tree);
  assert.deepEqual(await f.originalState(), before);
  // PR replay의 기존 5천 항목 기준은 브랜치 squash의 범위 확대와 독립적이다.
  const replay = await createReplayWorktree(f.root, f.beforeHead, [f.source]);
  f.ownWorktree(replay.path);
  assert.equal(replay.compact, false);
  assert.equal(await readFile(join(replay.path, f.paths[0]), "utf8"), "unchanged padding\n");
});

test("small dirty branch squash retains a full checkout without compact Git configuration probes", async t => {
  const f = await safetyFixture(t, "small-branch-squash");
  const commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command));
  let worktree: Awaited<ReturnType<typeof createBranchSquashWorktree>>;
  try { worktree = await createBranchSquashWorktree(f.root, f.head, f.head); } finally { stop(); }
  // t.after는 등록 순서로 실행되므로 별도 worktree는 테스트 본문에서 먼저 제거한다.
  try {
    assert.equal(worktree.compact, false);
    assert.equal(await readFile(join(worktree.path, "tracked.txt"), "utf8"), "base\n");
    assert.equal(commands.includes("config"), false);
    assert.equal(commands.includes("update-index"), false);
  } finally { await git(f.root, "worktree", "remove", "--force", worktree.path); }
});

for (const entries of [1000, 5000]) for (const configuration of ["hook", "filter", "merge-driver", "relative-hooks"] as const) {
  test(`branch squash with ${entries} unchanged files keeps a full checkout for ${configuration}`, async t => {
    const f = await replayWorktreeFixture(t, false, entries), marker = join(f.directory, "hook-read-padding");
    if (configuration === "hook") await writeFile(join(f.directory, "hooks/post-checkout"),
      `#!/bin/sh\ntest -f padding/keep-0000.txt || exit 1\nprintf ran > '${marker}'\n`, { mode: 0o755 });
    if (configuration === "filter") await git(f.root, "config", "filter.fixture.clean", "cat");
    if (configuration === "merge-driver") await git(f.root, "config", "merge.fixture.driver", "true");
    // target의 마지막 patch만 검사해서는 중간 이력의 hook 존재를 판정할 수 없다.
    if (configuration === "relative-hooks") await git(f.root, "config", "core.hooksPath", ".hooks");
    const worktree = await createBranchSquashWorktree(f.root, f.beforeHead, f.source);
    f.ownWorktree(worktree.path);
    assert.equal(worktree.compact, false);
    assert.equal(await readFile(join(worktree.path, f.paths[0]), "utf8"), "unchanged padding\n");
    if (configuration === "hook") assert.equal(await readFile(marker, "utf8"), "ran");
  });
}

test("the detached branch worktree rechecks conditional hooks before skipping checkout", async t => {
  const f = await replayWorktreeFixture(t, false, 1000), shared = join(f.directory, "shared-hooks"), marker = join(f.directory, "hook-ran");
  await mkdir(shared);
  await writeFile(join(shared, "prepare-commit-msg"),
    `#!/bin/sh\ntest -f padding/keep-0000.txt || exit 1\nprintf ran > '${marker}'\n`, { mode: 0o755 });
  await git(f.root, "config", "core.hooksPath", shared);
  const include = join(f.directory, "main.config");
  await writeFile(include, `[core]\n hooksPath = ${join(f.directory, "hooks")}\n`);
  await git(f.root, "config", "--add", "includeIf.onbranch:main.path", include);
  const worktree = await createBranchSquashWorktree(f.root, f.beforeHead, f.source);
  f.ownWorktree(worktree.path);
  assert.equal(worktree.compact, false);
  await git(worktree.path, "merge", "--squash", f.source);
  await commitPreparedIndex(worktree.path, { title: "conditional hook", body: "full checkout required" });
  assert.equal(await readFile(marker, "utf8"), "ran");
});

for (const dirty of [false, true]) {
  test(`branch squash uses its resolved local OID despite a colliding tag or moved source (${dirty ? "dirty" : "clean"})`, async t => {
    const f = await safetyFixture(t, "branch-squash-source");
    await git(f.root, "switch", "-qc", "source");
    await writeFile(join(f.root, "source.txt"), "selected branch\n");
    await git(f.root, "add", "source.txt"); await git(f.root, "commit", "-qm", "source");
    const source = await git(f.root, "rev-parse", "HEAD"), tree = await git(f.root, "rev-parse", "HEAD^{tree}");
    await git(f.root, "switch", "main"); await git(f.root, "tag", "source", f.head);
    if (dirty) await writeFile(join(f.root, "user.txt"), "local work\n");
    const service = new BranchOperationService(f.root);
    const runtime = service as unknown as { assertSourceBranch: (name: string) => Promise<string> };
    const resolve = runtime.assertSourceBranch.bind(service);
    t.mock.method(runtime, "assertSourceBranch", async name => {
      const oid = await resolve(name);
      await git(f.root, "update-ref", "refs/heads/source", f.head, source);
      return oid;
    });
    assert.equal((await service.squashMerge("source")).status, "completed");
    assert.equal(await git(f.root, "rev-parse", "HEAD^{tree}"), tree);
    if (dirty) assert.equal(await readFile(join(f.root, "user.txt"), "utf8"), "local work\n");
  });
}

test("a locked preserved branch worktree cannot be deleted by a failed Native cleanup", async t => {
  const f = await replayWorktreeFixture(t), service = new BranchOperationService(f.root);
  // 이 검증은 staged-addition 반영과 무관하게 성공한 결과의 cleanup 정책만 확인한다.
  await git(f.root, "reset", "-q", "--", "user.txt");
  let owned = "";
  observeCommit(t, service, async root => { owned = root; await git(f.root, "worktree", "lock", root); });
  try {
    await assert.rejects(service.squashMerge("source"), /locked/);
    assert.ok(owned); await access(join(owned, ".git"));
    assert.equal(await git(f.root, "rev-parse", "HEAD^{tree}"), f.tree);
  } finally {
    if (owned) { await git(f.root, "worktree", "unlock", owned); f.ownWorktree(owned); }
  }
});

for (const failure of ["inspection", "materialization"] as const) {
  test(`branch squash keeps its conflicted worktree when ${failure} fails`, async t => {
    const f = await replayWorktreeFixture(t, true), before = await f.originalState();
    const service = new BranchOperationService(f.root);
    const runtime = service as unknown as { hasUnmergedChangesIn: (root: string) => Promise<boolean> };
    const inspect = runtime.hasUnmergedChangesIn.bind(service);
    t.mock.method(runtime, "hasUnmergedChangesIn", async root => {
      const unmerged = await inspect(root);
      assert.equal(unmerged, true);
      if (failure === "inspection") throw new Error("Controlled Native index inspection error");
      await mkdir(join(root, f.paths[0]), { recursive: true });
      return unmerged;
    });
    await assert.rejects(service.squashMerge("source"), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Conflict recovery could not be prepared/);
      assert.match(error.message, /preserved temporary worktree:/);
      return true;
    });
    const [worktree] = await branchWorktrees(f.root);
    assert.ok(worktree); f.ownWorktree(worktree);
    assert.notEqual(await git(worktree, "ls-files", "--unmerged"), "");
    assert.deepEqual(await f.originalState(), before);
    if (failure === "materialization") await rm(join(worktree, f.paths[0]), { recursive: true });
    await materializeReplayWorktree(worktree, "branch squash");
    assert.equal(await readFile(join(worktree, f.paths[0]), "utf8"), "unchanged padding\n");
  });
}

for (const failure of ["commit", "snapshot", "materialization", "index inspection"] as const) {
  test(`compact squash preserves and materializes its result after a ${failure} failure`, async t => {
    const f = await replayWorktreeFixture(t, false, 1000), before = await f.originalState();
    const service = new BranchOperationService(f.root), runtime = service as any;
    if (failure === "snapshot") t.mock.method(runtime, "createSnapshot", async () => { throw new Error("Controlled snapshot failure"); });
    else if (failure === "index inspection") t.mock.method(runtime, "hasPendingChangesIn", async () => { throw new Error("Controlled index failure"); });
    else observeCommit(t, service, async root => {
      if (failure === "materialization") await mkdir(join(root, f.paths[0]), { recursive: true });
      throw new Error("Controlled commit failure");
    });
    await assert.rejects(service.squashMerge("source"), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /Controlled/);
      assert.match(error.message, /preserved temporary worktree/);
      if (failure === "materialization") assert.match(error.message, /could not be fully materialized/);
      return true;
    });
    const [worktree] = await branchWorktrees(f.root); assert.ok(worktree); f.ownWorktree(worktree);
    assert.deepEqual(await f.originalState(), before);
    assert.equal(await git(worktree, "write-tree"), f.tree);
    if (failure === "materialization") {
      assert.match(await git(worktree, "ls-files", "-t"), /^S /m);
      await rm(join(worktree, f.paths[0]), { recursive: true });
      await materializeReplayWorktree(worktree, "branch squash");
    }
    assert.equal(await readFile(join(worktree, f.paths[0]), "utf8"), "unchanged padding\n");
    assert.equal(await readFile(join(worktree, f.paths.at(-1)!), "utf8"), "unchanged padding\n");
    assert.equal((await git(worktree, "ls-files", "-t")).split("\n").some(line => line.startsWith("S ")), false);
    if (failure !== "snapshot") await commitPreparedIndex(worktree, { title: "Recovered squash", body: "Preserved index" });
    assert.equal(await git(worktree, "rev-parse", "HEAD^{tree}"), f.tree);
    assert.equal(await git(worktree, "rev-parse", "HEAD^"), f.beforeHead);
  });
}
