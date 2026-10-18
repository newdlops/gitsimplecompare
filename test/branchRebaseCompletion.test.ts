import assert from "node:assert/strict";
import fs, { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BranchOperationService } from "../src/git/branchOperationService";
import { finishPendingBranchRebaseMergeAfterContinue } from "../src/git/branchRebaseMerge";
import { OperationUndoStore } from "../src/git/operationUndoStore";
import { ConflictService } from "../src/git/conflictService";
import { listUnmergedFiles, readUnmergedStageMaps, readUnmergedStages } from "../src/git/unmergedFiles";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 성공하는 rebase와 별도 파일의 보존 stash를 만들어 완료 후 오류를 검증한다. */
async function fixture(t: TestContext) {
  const base = await safetyFixture(t, "branch-rebase-completion");
  await writeFile(join(base.root, "other.txt"), "other base\n");
  await git(base.root, "add", ".");
  await git(base.root, "commit", "-qm", "other base");
  const beforeHead = await git(base.root, "rev-parse", "HEAD");
  await git(base.root, "switch", "-qc", "target");
  const targetHead = await commitText(base.root, "target content\n", "target");
  await git(base.root, "switch", "main");
  await writeFile(join(base.root, "other.txt"), "saved local work\n");
  const pendingFile = join(base.root, ".git", "gitsimplecompare", "branch-rebase-merge-state.json");
  return { ...base, beforeHead, targetHead, pendingFile, service: new BranchOperationService(base.root) };
}

/** 완료 기록의 특정 차례만 실패시켜 native rebase의 성공을 후속 조회 실패와 구분한다. */
function failCompletedCapture(t: TestContext, failAt: number) {
  const original = OperationUndoStore.prototype.capture;
  let captures = 0;
  t.mock.method(OperationUndoStore.prototype, "capture", async function (this: OperationUndoStore, ...args: Parameters<typeof original>) {
    if (args[2] === "completed" && ++captures === failAt) {
      throw Object.assign(new Error("Git read exceeded its time limit. See Git Simple Compare Output."), { code: "ETIMEDOUT" });
    }
    return original.apply(this, args);
  });
}

test("a completed native rebase keeps its pending finalization and retries without moving the branch again", async t => {
  const { root, beforeHead, targetHead, pendingFile, service } = await fixture(t);
  failCompletedCapture(t, 1);
  await assert.rejects(service.rebaseMerge("target"), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /rebase command completed, but follow-up processing failed/i);
    assert.match(error.message, /Git read exceeded its time limit/);
    assert.doesNotMatch(error.message, /Automatic recovery was stopped|Ref safety check failed/);
    return true;
  });
  const pending = JSON.parse(await readFile(pendingFile, "utf8"));
  assert.equal(pending.completedHead, targetHead);
  assert.equal(await git(root, "rev-parse", "HEAD"), targetHead);
  assert.equal(await git(root, "rev-parse", pending.snapshotRef), beforeHead);
  assert.equal(await git(root, "rev-parse", "refs/stash"), pending.preservedStashHash);
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "other base\n");
  const headLog = await readFile(join(root, ".git", "logs", "HEAD"), "utf8");
  assert.equal((await finishPendingBranchRebaseMergeAfterContinue(root)).status, "completed");
  assert.equal(await readFile(join(root, ".git", "logs", "HEAD"), "utf8"), headLog);
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "saved local work\n");
  assert.equal(await git(root, "stash", "list"), "");
  assert.equal(await service.hasUndoSnapshot(), true);
  await service.undoLastOperation();
  assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "saved local work\n");
});

test("a later Undo recording failure after stash restoration does not run failed-start recovery or reapply the stash", async t => {
  const { root, targetHead, service } = await fixture(t);
  failCompletedCapture(t, 2);
  await assert.rejects(service.rebaseMerge("target"), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /rebase command completed, but follow-up processing failed/i);
    assert.doesNotMatch(error.message, /Automatic recovery was stopped|Ref safety check failed|preserved in stash/i);
    return true;
  });
  assert.equal(await git(root, "rev-parse", "HEAD"), targetHead);
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "saved local work\n");
  assert.equal(await git(root, "stash", "list"), "");
  assert.equal((await finishPendingBranchRebaseMergeAfterContinue(root)).status, "none");
  assert.equal(await service.hasUndoSnapshot(), true);
});

test("resuming completed processing rejects a later external commit and preserves its stash and snapshot", async t => {
  const { root, pendingFile, service } = await fixture(t);
  failCompletedCapture(t, 1);
  await assert.rejects(service.rebaseMerge("target"));
  const pending = JSON.parse(await readFile(pendingFile, "utf8"));
  const laterHead = await commitText(root, "external work\n", "external commit");
  const index = await git(root, "ls-files", "--stage", "-z");
  await assert.rejects(finishPendingBranchRebaseMergeAfterContinue(root), /Ref safety check failed/);
  assert.equal(await git(root, "rev-parse", "HEAD"), laterHead);
  assert.equal(await git(root, "ls-files", "--stage", "-z"), index);
  assert.equal(await git(root, "rev-parse", "refs/stash"), pending.preservedStashHash);
  assert.equal(await readFile(pendingFile, "utf8"), `${JSON.stringify(pending, null, 2)}\n`);
});

test("a commit made while Undo is recorded prevents restoring the saved stash onto the changed branch", async t => {
  const { root, pendingFile, service } = await fixture(t);
  const original = OperationUndoStore.prototype.capture;
  let laterHead = "";
  t.mock.method(OperationUndoStore.prototype, "capture", async function (this: OperationUndoStore, ...args: Parameters<typeof original>) {
    await original.apply(this, args);
    if (!laterHead && args[2] === "completed") laterHead = await commitText(root, "external commit\n", "external commit");
  });
  await assert.rejects(service.rebaseMerge("target"), /Ref safety check failed/);
  const pending = JSON.parse(await readFile(pendingFile, "utf8"));
  assert.equal(await git(root, "rev-parse", "HEAD"), laterHead);
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "other base\n");
  assert.equal(await git(root, "rev-parse", "refs/stash"), pending.preservedStashHash);
  assert.equal(pending.restoreHead, undefined);
});

test("a failed stash restoration is not automatically applied again when completed processing resumes", async t => {
  const { root, pendingFile, targetHead, service } = await fixture(t);
  const original = OperationUndoStore.prototype.capture;
  let inserted = false;
  t.mock.method(OperationUndoStore.prototype, "capture", async function (this: OperationUndoStore, ...args: Parameters<typeof original>) {
    await original.apply(this, args);
    if (!inserted && args[2] === "completed") {
      inserted = true;
      await writeFile(join(root, "other.txt"), "new external edit\n");
    }
  });
  await assert.rejects(service.rebaseMerge("target"), /rebase command completed, but follow-up processing failed/i);
  const pending = JSON.parse(await readFile(pendingFile, "utf8"));
  assert.equal(pending.completedHead, targetHead);
  assert.equal(pending.restoreHead, targetHead);
  assert.notEqual(pending.localChangesRestored, true);
  const status = await git(root, "status", "--porcelain=v2", "-z");
  await assert.rejects(finishPendingBranchRebaseMergeAfterContinue(root), /restoration was already attempted/);
  assert.equal(await git(root, "status", "--porcelain=v2", "-z"), status);
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "new external edit\n");
  assert.equal(await git(root, "rev-parse", "refs/stash"), pending.preservedStashHash);
});

test("Undo preserves the completed HEAD after stash apply restored tracked work but failed on an untracked collision", async t => {
  const { root, pendingFile, targetHead, service } = await fixture(t);
  await writeFile(join(root, "saved.txt"), "original untracked work\n");
  const original = OperationUndoStore.prototype.capture;
  let inserted = false;
  t.mock.method(OperationUndoStore.prototype, "capture", async function (this: OperationUndoStore, ...args: Parameters<typeof original>) {
    await original.apply(this, args);
    if (!inserted && args[2] === "completed") {
      inserted = true;
      await writeFile(join(root, "saved.txt"), "new external untracked work\n");
    }
  });
  await assert.rejects(service.rebaseMerge("target"), /rebase command completed, but follow-up processing failed/i);
  const pending = JSON.parse(await readFile(pendingFile, "utf8"));
  assert.equal(pending.restoreHead, targetHead);
  assert.notEqual(pending.localChangesRestored, true);
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "saved local work\n");
  assert.equal(await git(root, "diff", "--name-only", "--diff-filter=U"), "");
  const index = await readFile(join(root, ".git", "index"));
  await assert.rejects(service.undoLastOperation(), /restoration was already attempted/);
  assert.equal(await git(root, "rev-parse", "HEAD"), targetHead);
  assert.deepEqual(await readFile(join(root, ".git", "index")), index);
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "saved local work\n");
  assert.equal(await readFile(join(root, "saved.txt"), "utf8"), "new external untracked work\n");
  assert.equal(await git(root, "rev-parse", "refs/stash"), pending.preservedStashHash);
});

test("a verified legacy Continue keeps its missing-Undo allowance across a later finalization retry", async t => {
  const { root, service, pendingFile } = await fixture(t);
  await commitText(root, "local conflicting content\n", "local");
  assert.equal((await service.rebaseMerge("target")).status, "conflicts");
  await rm(join(root, ".git", "gitsimplecompare", "branch-operation-undo", `${Buffer.from("main").toString("hex")}.json`));
  await writeFile(join(root, "tracked.txt"), "resolved content\n");
  await git(root, "add", "tracked.txt");
  await new ConflictService(root).continueOperation("rebase");
  failCompletedCapture(t, 1);
  await assert.rejects(finishPendingBranchRebaseMergeAfterContinue(root), /Git read exceeded its time limit/);
  assert.equal(JSON.parse(await readFile(pendingFile, "utf8")).allowMissingUndo, true);
  assert.equal((await finishPendingBranchRebaseMergeAfterContinue(root)).status, "completed");
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "saved local work\n");
  assert.equal(await git(root, "stash", "list"), "");
  assert.equal(await service.hasUndoSnapshot(), false);
});

for (const resume of ["finish", "undo"] as const) {
  test(`a pending cleanup failure after stash restoration permits ${resume} without applying the stash twice`, async t => {
    const { root, pendingFile, beforeHead, targetHead, service } = await fixture(t);
    const remove = fs.rm;
    let fail = true;
    t.mock.method(fs, "rm", async (...args) => {
      if (String(args[0]) === pendingFile && fail) {
        // 새 작업 시작 전의 오래된 pending 정리는 통과하고 복원이 끝난 pending 삭제만 실패시킨다.
        const pending = JSON.parse(await readFile(pendingFile, "utf8").catch(() => "{}"));
        if (pending.localChangesRestored) {
          fail = false;
          throw new Error("pending cleanup failed");
        }
      }
      return remove(...args);
    });
    await assert.rejects(service.rebaseMerge("target"), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /rebase command completed, but follow-up processing failed/i);
      assert.doesNotMatch(error.message, /preserved in stash/i);
      return true;
    });
    const pending = JSON.parse(await readFile(pendingFile, "utf8"));
    assert.equal(pending.completedHead, targetHead);
    assert.equal(pending.localChangesRestored, true);
    assert.equal(await git(root, "stash", "list"), "");
    if (resume === "finish") {
      assert.equal((await finishPendingBranchRebaseMergeAfterContinue(root)).status, "completed");
      assert.equal(await git(root, "rev-parse", "HEAD"), targetHead);
    } else {
      await service.undoLastOperation();
      assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
    }
    assert.equal(await readFile(join(root, "other.txt"), "utf8"), "saved local work\n");
    await assert.rejects(readFile(pendingFile), { code: "ENOENT" });
  });
}

test("index-only conflict and Undo reads bypass fsmonitor without changing the index or configured hook", async t => {
  const { root, directory, head } = await safetyFixture(t, "index-only-fsmonitor");
  const hook = join(directory, "fsmonitor-hook");
  const called = join(directory, "fsmonitor-called");
  await writeFile(hook, `#!/bin/sh\nprintf 'called\\n' >> '${called}'\nprintf 'token\\0'\n`, { mode: 0o755 });
  await git(root, "config", "core.fsmonitor", hook);
  const before = await readFile(join(root, ".git", "index"));
  assert.deepEqual(await listUnmergedFiles(root), []);
  assert.equal((await readUnmergedStages(root, "tracked.txt")).size, 0);
  assert.equal((await readUnmergedStageMaps(root, ["tracked.txt"])).get("tracked.txt")?.size, 0);
  const snapshotRef = "refs/gitsimplecompare/branch-operation-snapshots/test";
  await git(root, "update-ref", snapshotRef, head);
  const undo = new OperationUndoStore(root);
  await undo.start("main", head, snapshotRef);
  await undo.capture("main", snapshotRef, "completed");
  await assert.rejects(readFile(called), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(root, ".git", "index")), before);
  assert.equal(await git(root, "config", "core.fsmonitor"), hook);
  assert.equal((await undo.prepare()).expectedHead, head);
});
