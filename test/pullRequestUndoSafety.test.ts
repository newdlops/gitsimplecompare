import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ConflictService, detectOperation } from "../src/git/conflictService";
import { readConflictOperationEpoch } from "../src/git/conflictOperationEpoch";
import { continuePendingDeferredCommitRebase } from "../src/git/deferredCommitRebase";
import { readPendingDeferredCommitRebase, writePendingDeferredCommitRebase } from "../src/git/deferredCommitRebaseState";
import { runGit } from "../src/git/gitExec";
import { PullRequestOperationService } from "../src/git/pullRequestOperationService";
import { PullRequestOperationSnapshot } from "../src/git/pullRequestOperationSnapshot";
import { readPendingPullRequestRebase, writePendingPullRequestRebase } from "../src/git/pullRequestOperationState";
import { commitText, git } from "./helpers/gitSafetyFixture";
import { prSafetyFixture, safetyPullRequest } from "./helpers/prOperationSafetyFixture";

/** Undo 거부 전후의 사용자 내용·index·작업 세대·ref를 함께 비교한다. */
async function state(root: string) {
  return {
    branch: await git(root, "branch", "--show-current"), head: await git(root, "rev-parse", "HEAD"),
    index: await git(root, "ls-files", "--stage"), content: await readFile(join(root, "tracked.txt"), "utf8"),
    other: await readFile(join(root, "other.txt"), "utf8"), status: await git(root, "status", "--porcelain"),
    epoch: await readConflictOperationEpoch(root), refs: await git(root, "for-each-ref", "--format=%(refname) %(objectname)"),
  };
}

for (const mode of ["squashCherryPick", "rebasePullRequest"] as const) {
  test(`${mode} records completed Undo and preserves unrelated edits`, async (t) => {
    const { root, base, pr, service } = await prSafetyFixture(t);
    const result = await service[mode](pr);
    await writeFile(join(root, "other.txt"), "unrelated edit\n");
    await writeFile(join(root, "new.txt"), "untracked edit\n");
    await new PullRequestOperationService(root).undoLastOperation();
    assert.equal(await git(root, "rev-parse", "HEAD"), base);
    assert.equal(await readFile(join(root, "other.txt"), "utf8"), "unrelated edit\n");
    assert.equal(await readFile(join(root, "new.txt"), "utf8"), "untracked edit\n");
    assert.equal(await service.hasUndoSnapshot(), false);
    await assert.rejects(() => git(root, "rev-parse", "--verify", result.snapshotRef));
  });

  test(`${mode} through a temporary worktree records Undo without claiming the user's staged work`, async (t) => {
    const { root, base, pr, service } = await prSafetyFixture(t);
    await writeFile(join(root, "other.txt"), "user staged work\n");
    await git(root, "add", "other.txt");
    await service[mode](pr);
    await service.undoLastOperation();
    assert.equal(await git(root, "rev-parse", "HEAD"), base);
    assert.equal(await readFile(join(root, "other.txt"), "utf8"), "user staged work\n");
  });
}

test("PR Undo cannot abort an unrelated rebase or erase its manual resolution", async (t) => {
  const { root, base, pr, service } = await prSafetyFixture(t);
  const operation = await service.squashCherryPick(pr);
  await git(root, "switch", "-qc", "unrelated", base);
  await commitText(root, "unrelated branch\n", "unrelated");
  await git(root, "switch", "main");
  await commitText(root, "later commit\n", "later");
  await assert.rejects(() => git(root, "rebase", "unrelated"));
  await writeFile(join(root, "tracked.txt"), "manual resolution of unrelated rebase\n");
  const before = await state(root);
  await assert.rejects(() => service.undoLastOperation("main"), /no longer matches/);
  assert.deepEqual(await state(root), before);
  assert.equal(await detectOperation(root), "rebase");
  assert.equal(await git(root, "rev-parse", operation.snapshotRef), operation.beforeHead);
});

for (const command of ["cherry-pick", "revert"] as const) {
  test(`completed PR Undo preserves a later unrelated ${command} conflict`, async (t) => {
    const { root, base, pr, service } = await prSafetyFixture(t);
    const operation = await service.squashCherryPick(pr);
    await git(root, "switch", "-qc", "unrelated", base);
    const external = await commitText(root, "unrelated branch\n", "unrelated");
    await git(root, "switch", "main");
    if (command === "revert") await commitText(root, "later edit\n", "later");
    await assert.rejects(() => git(root, command, command === "revert" ? operation.afterHead : external));
    await writeFile(join(root, "tracked.txt"), `manual ${command} resolution\n`);
    const before = await state(root);
    await assert.rejects(() => service.undoLastOperation(), /no longer matches/);
    assert.deepEqual(await state(root), before);
  });
}

test("completed PR Undo preserves a same-HEAD stash conflict and manual edits", async (t) => {
  const { root, pr, service } = await prSafetyFixture(t);
  await writeFile(join(root, "tracked.txt"), "unrelated stash work\n");
  await git(root, "stash", "push", "-qm", "unrelated");
  const result = await service.squashCherryPick(pr);
  await assert.rejects(() => git(root, "stash", "apply"));
  await writeFile(join(root, "tracked.txt"), "manual stash resolution\n");
  const before = await state(root);
  assert.equal(before.head, result.afterHead);
  await assert.rejects(() => service.undoLastOperation(), /no longer matches/);
  assert.deepEqual(await state(root), before);
});

test("later commits invalidate completed PR Undo without removing its snapshot", async (t) => {
  const { root, pr, service } = await prSafetyFixture(t);
  const operation = await service.squashCherryPick(pr);
  await commitText(root, "later user commit\n", "later");
  const before = await state(root);
  await assert.rejects(() => service.undoLastOperation(), /no longer matches/);
  assert.deepEqual(await state(root), before);
  assert.equal(await git(root, "rev-parse", operation.snapshotRef), operation.beforeHead);
});

test("PR Undo cannot substitute an operation created after confirmation started", async (t) => {
  const { root, pr, service } = await prSafetyFixture(t);
  const first = await service.squashCherryPick(pr);
  const plan = await service.prepareUndo();
  await git(root, "switch", "-qc", "second-source");
  const secondSource = await commitText(root, "second PR\n", "second");
  await git(root, "switch", "main");
  const second = await service.squashCherryPick(safetyPullRequest(secondSource));
  const before = await state(root);
  await assert.rejects(() => service.undoLastOperation("main", plan), /no longer matches/);
  assert.deepEqual(await state(root), before);
  assert.notEqual(first.snapshotRef, second.snapshotRef);
  await service.undoLastOperation();
  assert.equal(await git(root, "rev-parse", "HEAD"), first.afterHead);
});

test("PR Undo rejects metadata from another worktree and keeps shared refs", async (t) => {
  const { root, directory, pr, service } = await prSafetyFixture(t);
  const result = await service.squashCherryPick(pr);
  await git(root, "switch", "-qc", "other");
  const linked = join(directory, "linked");
  await git(root, "worktree", "add", "-q", linked, "main");
  await assert.rejects(() => new PullRequestOperationService(linked).undoLastOperation(), /no longer matches/);
  assert.equal(await git(linked, "rev-parse", "HEAD"), result.afterHead);
  assert.equal(await git(linked, "status", "--porcelain"), "");
});

test("a legacy PR snapshot without ownership cannot become automatic Undo", async (t) => {
  const { root, pr, service } = await prSafetyFixture(t);
  const result = await service.squashCherryPick(pr);
  const gitDir = await git(root, "rev-parse", "--absolute-git-dir");
  await rm(join(gitDir, "gitsimplecompare/pull-request-operation-undo/6d61696e.json"));
  const before = await state(root);
  assert.equal(await service.hasUndoSnapshot(), false);
  await assert.rejects(() => service.undoLastOperation(), /no longer matches/);
  assert.deepEqual(await state(root), before);
  assert.equal(await git(root, "rev-parse", result.snapshotRef), result.beforeHead);
});

test("Undo can remove its own PR squash conflict while preserving another file's edit", async (t) => {
  const { root, pr, service } = await prSafetyFixture(t, true);
  const beforeHead = await git(root, "rev-parse", "HEAD");
  await assert.rejects(() => service.squashCherryPick(pr));
  assert.notEqual(await git(root, "diff", "--name-only", "--diff-filter=U"), "");
  await writeFile(join(root, "other.txt"), "unrelated edit after conflict\n");
  await service.undoLastOperation();
  assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "local content\n");
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "unrelated edit after conflict\n");
});

test("failed PR squash commit keeps an Undo snapshot for its own staged result", async (t) => {
  const { root, directory, base, pr, service } = await prSafetyFixture(t);
  await writeFile(join(directory, "hooks/prepare-commit-msg"), "#!/bin/sh\nprintf 'fixture commit rejected\\n' >&2\nexit 1\n", { mode: 0o755 });
  await assert.rejects(() => service.squashCherryPick(pr), /fixture commit rejected/);
  assert.equal(await service.hasUndoSnapshot(), true);
  await service.undoLastOperation();
  assert.equal(await git(root, "rev-parse", "HEAD"), base);
  assert.equal(await git(root, "status", "--porcelain"), "");
});

test("new staged work invalidates partial PR squash Undo", async (t) => {
  const { root, pr, service } = await prSafetyFixture(t, true);
  await assert.rejects(() => service.squashCherryPick(pr));
  await writeFile(join(root, "other.txt"), "new staged work\n");
  await git(root, "add", "other.txt");
  const before = await state(root);
  await assert.rejects(() => service.undoLastOperation(), /no longer matches/);
  assert.deepEqual(await state(root), before);
});

for (const revert of [false, true]) {
  test(`Undo aborts its own deferred PR ${revert ? "revert" : "cherry-pick"} conflict`, async (t) => {
    const { root, pr, service } = await prSafetyFixture(t, !revert);
    if (revert) {
      await git(root, "merge", "--ff-only", "source");
      await commitText(root, "later change\n", "later");
    }
    const beforeHead = await git(root, "rev-parse", "HEAD");
    const result = await (revert ? service.rebaseRevertPullRequest(pr) : service.rebasePullRequest(pr));
    assert.equal(result.status, "conflicts");
    assert.equal(await detectOperation(root), revert ? "revert" : "cherry-pick");
    await writeFile(join(root, "other.txt"), "unrelated edit\n");
    await service.undoLastOperation();
    assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
    assert.equal(await readFile(join(root, "other.txt"), "utf8"), "unrelated edit\n");
    assert.equal(await detectOperation(root), "none");
    assert.equal(await readPendingDeferredCommitRebase(root), undefined);
  });
}

test("an identical cherry-pick restarted externally cannot reuse the old PR Undo", async (t) => {
  const { root, source, pr, service } = await prSafetyFixture(t, true);
  await service.rebasePullRequest(pr);
  const stages = await git(root, "ls-files", "--unmerged");
  await git(root, "cherry-pick", "--abort");
  await assert.rejects(() => git(root, "cherry-pick", source));
  assert.equal(await git(root, "ls-files", "--unmerged"), stages);
  await writeFile(join(root, "tracked.txt"), "new operation's manual resolution\n");
  const before = await state(root);
  await assert.rejects(() => service.undoLastOperation(), /no longer matches/);
  assert.deepEqual(await state(root), before);
});

test("new staged work invalidates Undo of an owned PR cherry-pick conflict", async (t) => {
  const { root, pr, service } = await prSafetyFixture(t, true);
  await service.rebasePullRequest(pr);
  await writeFile(join(root, "other.txt"), "new staged work\n");
  await git(root, "add", "other.txt");
  const before = await state(root);
  await assert.rejects(() => service.undoLastOperation(), /no longer matches/);
  assert.deepEqual(await state(root), before);
});

test("continuing a PR conflict records its completed HEAD for later Undo", async (t) => {
  const { root, pr, service } = await prSafetyFixture(t, true);
  const beforeHead = await git(root, "rev-parse", "HEAD");
  await service.rebasePullRequest(pr);
  await writeFile(join(root, "tracked.txt"), "resolved\n");
  await git(root, "add", "tracked.txt");
  await new ConflictService(root).continueOperation("cherry-pick");
  assert.equal((await continuePendingDeferredCommitRebase(root)).status, "completed");
  await service.undoLastOperation();
  assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
});

for (const legacy of [false, true]) {
  test(`PR Undo never restores a ${legacy ? "legacy" : "deferred"} stash from a different snapshot`, async (t) => {
    const { root, pr, service } = await prSafetyFixture(t);
    await writeFile(join(root, "other.txt"), "old preserved work\n");
    await git(root, "stash", "push", "-qm", "old operation");
    const stash = await git(root, "rev-parse", "refs/stash");
    const result = await service.squashCherryPick(pr);
    const pending = {
      destinationBranch: "main", beforeHead: result.beforeHead, snapshotRef: "refs/gitsimplecompare/old-operation",
      preservedStashHash: stash, createdAt: Date.now(),
    };
    if (legacy) await writePendingPullRequestRebase(root, { ...pending, kind: "rebase", number: 42, sourceBranch: "source" });
    else await writePendingDeferredCommitRebase(root, { ...pending, kind: "pr-rebase", operation: "cherry-pick", label: "old", remainingCommits: [] });
    await service.undoLastOperation();
    assert.equal(await readFile(join(root, "other.txt"), "utf8"), "other base\n");
    assert.equal(await git(root, "rev-parse", "refs/stash"), stash);
    assert.ok(legacy ? await readPendingPullRequestRebase(root) : await readPendingDeferredCommitRebase(root));
  });
}

test("PR Undo restores its matching pending stash after returning to the snapshot", async (t) => {
  const { root, pr, service } = await prSafetyFixture(t, true);
  await writeFile(join(root, "other.txt"), "own preserved work\n");
  await git(root, "stash", "push", "-qm", "own operation");
  const stash = await git(root, "rev-parse", "refs/stash");
  await service.rebasePullRequest(pr);
  const pending = await readPendingDeferredCommitRebase(root);
  assert.ok(pending);
  await writePendingDeferredCommitRebase(root, { ...pending, preservedStashHash: stash });
  await service.undoLastOperation();
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "own preserved work\n");
  assert.equal(await git(root, "stash", "list"), "");
});

test("a prepared PR snapshot alone is never considered a completed operation", async (t) => {
  const { root, base, service } = await prSafetyFixture(t);
  await new PullRequestOperationSnapshot(root).createSnapshot("main", base, "squash");
  assert.equal(await service.hasUndoSnapshot(), false);
});

for (const mode of ["squashRevertPullRequest", "rebaseRevertPullRequest"] as const) {
  for (const dirty of [false, true]) {
    test(`${mode} ${dirty ? "using a temporary worktree" : "on a clean worktree"} records completed Undo`, async (t) => {
      const { root, source, pr, service } = await prSafetyFixture(t);
      await git(root, "merge", "--ff-only", "source");
      if (dirty) await writeFile(join(root, "other.txt"), "user local work\n");
      assert.equal((await service[mode](pr)).status, "completed");
      await service.undoLastOperation();
      assert.equal(await git(root, "rev-parse", "HEAD"), source);
      assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "PR content\n");
      assert.equal(await readFile(join(root, "other.txt"), "utf8"), dirty ? "user local work\n" : "other base\n");
    });
  }
}

test("squash revert can undo its own conflict", async (t) => {
  const { root, pr, service } = await prSafetyFixture(t);
  await git(root, "merge", "--ff-only", "source");
  const beforeHead = await commitText(root, "later change\n", "later");
  assert.equal((await service.squashRevertPullRequest(pr)).status, "conflicts");
  await service.undoLastOperation();
  assert.equal(await git(root, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "later change\n");
  assert.equal(await detectOperation(root), "none");
});
