import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BranchOperationService } from "../src/git/branchOperationService";
import { finishPendingBranchRebaseMergeAfterContinue } from "../src/git/branchRebaseMerge";
import { PullRequestOperationSnapshot } from "../src/git/pullRequestOperationSnapshot";
import { runGit } from "../src/git/gitExec";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 분기/커밋으로 squash 또는 rebase의 정상·충돌 경로를 만든다. */
async function branchFixture(t: TestContext, conflict = false) {
  const fixture = await safetyFixture(t, "branch-undo");
  const { root } = fixture;
  await writeFile(join(root, "other.txt"), "other base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "other base");
  await git(root, "switch", "-qc", "source");
  await commitText(root, "source content\n", "source");
  await git(root, "switch", "-q", "main");
  if (conflict) await commitText(root, "local content\n", "local");
  return { ...fixture, before: await git(root, "rev-parse", "HEAD"), service: new BranchOperationService(root) };
}

/** 사용자 내용과 index stage를 함께 비교해 중단한 Undo가 무엇도 바꾸지 않았는지 확인한다. */
async function currentState(root: string) {
  return {
    head: await git(root, "rev-parse", "HEAD"),
    index: await git(root, "ls-files", "--stage"),
    content: await readFile(join(root, "tracked.txt"), "utf8"),
    status: await git(root, "status", "--porcelain"),
  };
}

test("completed branch Undo preserves a later stash conflict even when HEAD did not move", async (t) => {
  const { root, service } = await branchFixture(t);
  await writeFile(join(root, "tracked.txt"), "saved unrelated edit\n");
  await git(root, "stash", "push", "-qm", "unrelated");
  const result = await service.squashMerge("source");
  assert.equal(result.status, "completed");
  await assert.rejects(() => git(root, "stash", "apply"));
  await writeFile(join(root, "tracked.txt"), "unique manual resolution\n");
  const before = await currentState(root);
  assert.equal(before.head, result.afterHead);
  assert.notEqual(await git(root, "diff", "--name-only", "--diff-filter=U"), "");
  await assert.rejects(() => service.undoLastOperation(), /no longer matches/);
  assert.deepEqual(await currentState(root), before);
  assert.equal(await git(root, "rev-parse", result.snapshotRef), result.beforeHead);
});

test("completed squash Undo preserves unrelated local changes", async (t) => {
  const { root, before, service } = await branchFixture(t);
  await writeFile(join(root, "other.txt"), "local work kept through squash\n");
  await writeFile(join(root, "untracked.txt"), "untracked work\n");
  assert.equal((await service.squashMerge("source")).status, "completed");
  await service.undoLastOperation();
  assert.equal(await git(root, "rev-parse", "HEAD"), before);
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "local work kept through squash\n");
  assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "untracked work\n");
  assert.equal(await service.hasUndoSnapshot(), false);
});

test("the current squash conflict can be undone without deleting another file's edits", async (t) => {
  const { root, before, service } = await branchFixture(t, true);
  assert.equal((await service.squashMerge("source")).status, "conflicts");
  await writeFile(join(root, "tracked.txt"), "manual resolution of this squash\n");
  await writeFile(join(root, "other.txt"), "keep this unrelated edit\n");
  await service.undoLastOperation();
  assert.equal(await git(root, "rev-parse", "HEAD"), before);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "local content\n");
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "keep this unrelated edit\n");
});

test("a newly staged change invalidates partial squash Undo", async (t) => {
  const { root, service } = await branchFixture(t, true);
  await service.squashMerge("source");
  await writeFile(join(root, "other.txt"), "new staged work\n");
  await git(root, "add", "other.txt");
  const before = await currentState(root);
  await assert.rejects(() => service.undoLastOperation(), /no longer matches/);
  assert.deepEqual(await currentState(root), before);
  assert.equal(await git(root, "show", ":other.txt"), "new staged work");
});

test("an externally restarted squash with identical conflicted blobs cannot reuse the old Undo", async (t) => {
  const { root, service } = await branchFixture(t, true);
  await service.squashMerge("source");
  const stages = await git(root, "ls-files", "--unmerged");
  await git(root, "reset", "--hard", "HEAD");
  await assert.rejects(() => git(root, "merge", "--squash", "source"));
  assert.equal(await git(root, "ls-files", "--unmerged"), stages);
  await writeFile(join(root, "tracked.txt"), "new operation manual resolution\n");
  const before = await currentState(root);
  await assert.rejects(() => service.undoLastOperation(), /no longer matches/);
  assert.deepEqual(await currentState(root), before);
});

test("a failed squash commit keeps staged changes and a working recovery snapshot", async (t) => {
  const { root, directory, before, service } = await branchFixture(t);
  await writeFile(join(directory, "hooks/prepare-commit-msg"),
    "#!/bin/sh\nprintf 'message hook rejected commit\\n' >&2\nexit 1\n", { mode: 0o755 });
  await assert.rejects(() => service.squashMerge("source"), /message hook rejected/);
  assert.equal(await git(root, "rev-parse", "HEAD"), before);
  assert.equal(await git(root, "diff", "--cached", "--name-only"), "tracked.txt");
  assert.equal(await service.hasUndoSnapshot(), true);
  await writeFile(join(root, "other.txt"), "edit after failed commit\n");
  await service.undoLastOperation();
  assert.equal(await git(root, "diff", "--cached", "--name-only"), "");
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "base\n");
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "edit after failed commit\n");
});

test("an Undo plan cannot target a new operation created while confirmation was open", async (t) => {
  const { root, service } = await branchFixture(t);
  const first = await service.squashMerge("source");
  const plan = await service.prepareUndo();
  await git(root, "switch", "-qc", "second-source");
  await commitText(root, "second operation\n", "second source");
  await git(root, "switch", "main");
  const second = await service.squashMerge("second-source");
  const before = await currentState(root);
  await assert.rejects(() => service.undoLastOperation(plan.branch, plan), /no longer matches/);
  assert.deepEqual(await currentState(root), before);
  assert.notEqual(first.snapshotRef, second.snapshotRef);
  await service.undoLastOperation();
  assert.equal(await git(root, "rev-parse", "HEAD"), first.afterHead);
});

test("a failed temporary squash never classifies the user's original staged work as squash output", async (t) => {
  const { root, service } = await branchFixture(t);
  await writeFile(join(root, "tracked.txt"), "original staged work\n");
  await git(root, "add", "tracked.txt");
  const before = await currentState(root);
  await assert.rejects(() => service.squashMerge("source"));
  assert.equal(await service.hasUndoSnapshot(), false);
  await assert.rejects(() => service.undoLastOperation(), /no longer matches/);
  assert.deepEqual(await currentState(root), before);
});

test("a later commit invalidates completed Undo and preserves its snapshot", async (t) => {
  const { root, service } = await branchFixture(t);
  const operation = await service.squashMerge("source");
  const head = await commitText(root, "later committed work\n", "later");
  await assert.rejects(() => service.undoLastOperation(), /no longer matches/);
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.equal(await git(root, "rev-parse", operation.snapshotRef), operation.beforeHead);
});

test("Undo aborts its own rebase and restores the preserved local stash", async (t) => {
  const { root, before, service } = await branchFixture(t, true);
  await writeFile(join(root, "other.txt"), "local work before rebase\n");
  const operation = await service.rebaseMerge("source");
  assert.equal(operation.status, "conflicts");
  assert.ok(operation.preservedStashHash);
  await service.undoLastOperation();
  assert.equal(await git(root, "rev-parse", "HEAD"), before);
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "local work before rebase\n");
  assert.equal(await git(root, "stash", "list"), "");
});

test("an identical rebase restarted externally cannot be aborted by an old Undo", async (t) => {
  const { root, service } = await branchFixture(t, true);
  await service.rebaseMerge("source");
  await git(root, "rebase", "--abort");
  await assert.rejects(() => git(root, "rebase", "source"));
  await writeFile(join(root, "tracked.txt"), "resolution of unrelated rebase\n");
  const before = await currentState(root);
  await assert.rejects(() => service.undoLastOperation("main"), /no longer matches/);
  assert.deepEqual(await currentState(root), before);
});

test("a continued branch rebase records its completed HEAD for later Undo", async (t) => {
  const { root, before, service } = await branchFixture(t, true);
  await service.rebaseMerge("source");
  await writeFile(join(root, "tracked.txt"), "resolved\n");
  await git(root, "add", "tracked.txt");
  await runGit(["rebase", "--continue"], root, { env: { GIT_EDITOR: "true" } });
  assert.equal((await finishPendingBranchRebaseMergeAfterContinue(root)).status, "completed");
  await service.undoLastOperation();
  assert.equal(await git(root, "rev-parse", "HEAD"), before);
});

test("Undo never applies a pending stash owned by an earlier externally aborted rebase", async (t) => {
  const { root, service } = await branchFixture(t, true);
  await writeFile(join(root, "other.txt"), "old operation's preserved work\n");
  const rebase = await service.rebaseMerge("source");
  assert.ok(rebase.preservedStashHash);
  await git(root, "rebase", "--abort");
  assert.equal((await service.squashMerge("source")).status, "conflicts");
  await service.undoLastOperation();
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "other base\n");
  assert.equal(await git(root, "rev-parse", "refs/stash"), rebase.preservedStashHash);
});

test("another worktree cannot infer ownership from a shared branch snapshot", async (t) => {
  const { root, directory, service } = await branchFixture(t);
  const operation = await service.squashMerge("source");
  await git(root, "switch", "-qc", "other");
  const linked = join(directory, "linked worktree");
  await git(root, "worktree", "add", "-q", linked, "main");
  await assert.rejects(() => new BranchOperationService(linked).undoLastOperation(), /no longer matches/);
  assert.equal(await git(linked, "rev-parse", "HEAD"), operation.afterHead);
  assert.equal(await git(linked, "status", "--porcelain"), "");
});

test("PR Undo refuses to move a branch checked out in another worktree", async (t) => {
  const { root, directory, head } = await safetyFixture(t, "pr-undo-worktree");
  const service = new PullRequestOperationSnapshot(root);
  const snapshot = await service.createSnapshot("main", head, "squash");
  await commitText(root, "completed PR result\n", "PR result");
  await service.recordCompleted("main", snapshot);
  await git(root, "switch", "-qc", "other");
  const linked = join(directory, "linked worktree");
  await git(root, "worktree", "add", "-q", linked, "main");
  const before = await currentState(linked);
  await assert.rejects(() => service.undoLastOperation("main"), /worktree|checked out|in use/i);
  assert.deepEqual(await currentState(linked), before);
});

test("PR Undo can still restore an off-branch snapshot when no worktree uses it", async (t) => {
  const { root, head } = await safetyFixture(t, "pr-undo-off-branch");
  const service = new PullRequestOperationSnapshot(root);
  const snapshot = await service.createSnapshot("main", head, "squash");
  const after = await commitText(root, "completed PR result\n", "PR result");
  await service.recordCompleted("main", snapshot);
  await git(root, "switch", "-qc", "other");
  await service.undoLastOperation("main");
  assert.equal(await git(root, "rev-parse", "main"), head);
  assert.equal(await git(root, "rev-parse", "HEAD"), after);
  assert.equal(await git(root, "status", "--porcelain"), "");
});
