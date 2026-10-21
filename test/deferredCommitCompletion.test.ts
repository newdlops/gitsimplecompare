import assert from "node:assert/strict";
import fs, { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runDeferredCommitRebase, type DeferredCommitRebaseInput } from "../src/git/deferredCommitRebase";
import { readPendingDeferredCommitRebase } from "../src/git/deferredCommitRebaseState";
import { OperationUndoStore } from "../src/git/operationUndoStore";
import { setGitProcessPreparation } from "../src/git/gitProcessRunner";
import { prSafetyFixture } from "./helpers/prOperationSafetyFixture";
import { git } from "./helpers/gitSafetyFixture";

/** 실제 PR commit·불변 snapshot·Undo를 준비한다. 사용자 저장소나 모의 Git 결과를 사용하지 않는다. */
async function fixture(t: TestContext, local?: "other" | "conflicting") {
  const f = await prSafetyFixture(t), snapshotRef = "refs/gitsimplecompare/completion-test";
  let preservedStashHash: string | undefined;
  if (local) {
    await writeFile(join(f.root, local === "other" ? "other.txt" : "tracked.txt"), "preserved local edit\n");
    await git(f.root, "stash", "push", "-u", "-m", "completion test local work");
    preservedStashHash = await git(f.root, "rev-parse", "refs/stash");
  }
  await git(f.root, "update-ref", snapshotRef, f.base);
  await new OperationUndoStore(f.root, "pull-request").start("main", f.base, snapshotRef);
  const input: DeferredCommitRebaseInput = { kind: "pr-rebase", label: "completion test PR", repoRoot: f.root,
    commits: [f.source], destinationBranch: "main", beforeHead: f.base, snapshotRef,
    sourceRef: "source", guardCurrentBranch: true, preservedStashHash };
  return { ...f, input, snapshotRef, preservedStashHash };
}

test("clean replay finishes without entering an unused stash-restoration failure boundary", async t => {
  const f = await fixture(t), original = fs.writeFile;
  t.mock.method(fs, "writeFile", async (...args) => {
    if (String(args[0]).endsWith("deferred-commit-rebase-state.json") && String(args[1]).includes('"restoreHead"')) {
      throw new Error("Stash restoration state must be written only when there is a stash to restore");
    }
    return original(...args);
  });
  const result = await runDeferredCommitRebase(f.input);
  assert.equal(result.status, "completed"); assert.equal(result.restoredLocalChanges, false);
  assert.equal(result.afterHead, await git(f.root, "rev-parse", "HEAD"));
  assert.equal(await git(f.root, "rev-parse", "HEAD^{tree}"), await git(f.root, "rev-parse", `${f.source}^{tree}`));
  assert.equal(await git(f.root, "rev-parse", "HEAD^"), f.base);
  assert.equal(await git(f.root, "status", "--porcelain=v2", "-z"), "");
  assert.equal(await git(f.root, "rev-parse", f.snapshotRef), f.base);
  assert.equal(await readPendingDeferredCommitRebase(f.root), undefined);
});

test("a real stash still records the current restore HEAD before Native apply and restores local bytes", async t => {
  const f = await fixture(t, "other"); let checked = false;
  const release = setGitProcessPreparation(async (args, root, options) => {
    if (root === f.root && args.includes("stash") && args.includes("apply")) {
      const pending = await readPendingDeferredCommitRebase(root);
      assert.equal(pending?.preservedStashHash, f.preservedStashHash);
      assert.equal(pending?.restoreHead, await git(root, "rev-parse", "HEAD")); checked = true;
    }
    return { options };
  });
  try {
    const result = await runDeferredCommitRebase(f.input);
    assert.equal(result.status, "completed"); assert.equal(result.restoredLocalChanges, true); assert.equal(checked, true);
    assert.equal(result.afterHead, await git(f.root, "rev-parse", "HEAD"));
    assert.equal(await readFile(join(f.root, "other.txt"), "utf8"), "preserved local edit\n");
    assert.equal(await git(f.root, "show", "HEAD:tracked.txt"), "PR content");
    assert.equal(await git(f.root, "stash", "list"), "");
    assert.equal(await readPendingDeferredCommitRebase(f.root), undefined);
  } finally { release(); }
});

test("stash apply conflicts retain their stash, snapshot, restore HEAD and conflict result", async t => {
  const f = await fixture(t, "conflicting"), result = await runDeferredCommitRebase(f.input);
  assert.equal(result.status, "conflicts"); assert.equal(result.conflictKind, "stash");
  const head = await git(f.root, "rev-parse", "HEAD"), pending = await readPendingDeferredCommitRebase(f.root);
  assert.equal(result.afterHead, head); assert.equal(result.preservedStashHash, f.preservedStashHash);
  assert.equal(pending?.restoreHead, head); assert.equal(pending?.preservedStashHash, f.preservedStashHash);
  assert.equal(await git(f.root, "rev-parse", f.snapshotRef), f.base);
  assert.equal(await git(f.root, "rev-parse", "refs/stash"), f.preservedStashHash);
  assert.equal(await git(f.root, "diff", "--name-only", "--diff-filter=U"), "tracked.txt");
  assert.match(await readFile(join(f.root, "tracked.txt"), "utf8"), /preserved local edit/);
});

test("an external commit before completed Undo capture cannot be claimed by the replay", async t => {
  const f = await fixture(t), original = fs.writeFile; let laterHead = "", operationHead = "";
  t.mock.method(fs, "writeFile", async (...args) => {
    if (String(args[0]).endsWith("deferred-commit-rebase-state.json") && !laterHead) {
      const pending = JSON.parse(String(args[1])); operationHead = pending.operationHead;
      await writeFile(join(f.root, "external.txt"), "new external commit\n"); await git(f.root, "add", "external.txt");
      await git(f.root, "commit", "-qm", "external commit before capture"); laterHead = await git(f.root, "rev-parse", "HEAD");
    }
    return original(...args);
  });
  await assert.rejects(runDeferredCommitRebase(f.input), /Ref safety|safely undone|saved operation/i);
  assert.ok(laterHead && operationHead && laterHead !== operationHead);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), laterHead);
  assert.equal(await git(f.root, "rev-parse", "HEAD^"), operationHead);
  assert.equal(await readFile(join(f.root, "external.txt"), "utf8"), "new external commit\n");
  assert.equal((await readPendingDeferredCommitRebase(f.root))?.operationHead, operationHead);
  assert.equal(await git(f.root, "rev-parse", f.snapshotRef), f.base);
  await assert.rejects(new OperationUndoStore(f.root, "pull-request").prepare("main"));
});

test("an external commit after capture stops stash restoration onto the changed checkout", async t => {
  const f = await fixture(t, "other"), original = OperationUndoStore.prototype.capture; let laterHead = "";
  t.mock.method(OperationUndoStore.prototype, "capture", async function (this: OperationUndoStore, ...args: Parameters<typeof original>) {
    await original.apply(this, args);
    if (args[2] === "completed" && !laterHead) {
      await writeFile(join(f.root, "external.txt"), "external work before restore\n"); await git(f.root, "add", "external.txt");
      await git(f.root, "commit", "-qm", "external commit before restore"); laterHead = await git(f.root, "rev-parse", "HEAD");
    }
  });
  await assert.rejects(runDeferredCommitRebase(f.input), /Ref safety/i);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), laterHead);
  assert.equal(await readFile(join(f.root, "other.txt"), "utf8"), "other base\n");
  assert.equal(await readFile(join(f.root, "external.txt"), "utf8"), "external work before restore\n");
  assert.equal(await git(f.root, "rev-parse", "refs/stash"), f.preservedStashHash);
  const pending = await readPendingDeferredCommitRebase(f.root);
  assert.equal(pending?.preservedStashHash, f.preservedStashHash); assert.equal(pending?.restoreHead, undefined);
  assert.equal(await git(f.root, "rev-parse", f.snapshotRef), f.base);
});

test("a changed clean checkout keeps its pending result instead of clearing recovery before final verification", async t => {
  const f = await fixture(t), original = OperationUndoStore.prototype.capture; let operationHead = "", laterHead = "";
  t.mock.method(OperationUndoStore.prototype, "capture", async function (this: OperationUndoStore, ...args: Parameters<typeof original>) {
    await original.apply(this, args);
    if (args[2] === "completed" && !laterHead) {
      operationHead = await git(f.root, "rev-parse", "HEAD");
      await writeFile(join(f.root, "external.txt"), "new external work\n"); await git(f.root, "add", "external.txt");
      await git(f.root, "commit", "-qm", "external commit after capture"); laterHead = await git(f.root, "rev-parse", "HEAD");
    }
  });
  await assert.rejects(runDeferredCommitRebase(f.input), /Ref safety/i);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), laterHead);
  assert.equal((await readPendingDeferredCommitRebase(f.root))?.operationHead, operationHead);
  assert.equal(await readFile(join(f.root, "external.txt"), "utf8"), "new external work\n");
  assert.equal(await git(f.root, "rev-parse", f.snapshotRef), f.base);
});
