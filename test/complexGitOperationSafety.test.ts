import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { BranchOperationService } from "../src/git/branchOperationService";
import { ConflictService, detectOperation } from "../src/git/conflictService";
import { captureGitOperation } from "../src/git/operationControl";
import { continuePendingDeferredCommitRebase, restorePendingDeferredCommitRebaseAfterAbort } from "../src/git/deferredCommitRebase";
import { readPendingDeferredCommitRebase } from "../src/git/deferredCommitRebaseState";
import { RebaseService } from "../src/git/rebaseService";
import { createRebaseEditTempFile } from "../src/git/rebaseEditSession";
import { abortOperation, continueOperation, skipOperation } from "../src/commands/conflicts";
import type { ConflictsController } from "../src/providers/conflictsController";
import { PullRequestStackMetadataService } from "../src/git/pullRequestStackMetadata";
import { PullRequestStackRestackService } from "../src/git/pullRequestStackRestack";
import { graphRebaseResultProgress } from "../src/webview/graphRebaseProgress";
import { commitText, git } from "./helpers/gitSafetyFixture";
import { prSafetyFixture } from "./helpers/prOperationSafetyFixture";
import { window, __errorMessages } from "./helpers/vscodeMock";

const editor = resolve("media/rebase/rebaseEditor.js");

/** 실제 Git 서비스를 쓰는 최소 Conflicts 컨트롤러로 native 명령 조립을 검증한다. */
function controller(root: string, operation: "rebase" | "cherry-pick"): ConflictsController {
  return { current: new ConflictService(root), currentOperation: operation, refresh: async () => {} } as unknown as ConflictsController;
}

test("branch rebase Undo leaves unrelated new worktree edits and recovery state intact", async t => {
  const { root } = await prSafetyFixture(t, true);
  const service = new BranchOperationService(root);
  assert.equal((await service.rebaseMerge("source")).status, "conflicts");
  const head = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "other.txt"), "new user edit\n");
  await assert.rejects(service.undoLastOperation(), /new unstaged edits/);
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "new user edit\n");
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.equal(await detectOperation(root), "rebase");
  assert.equal(await service.hasUndoSnapshot(), true);
});

test("deferred abort restores earlier replay commits without deleting unrelated edits", async t => {
  const { root, pr, service } = await prSafetyFixture(t, true);
  const before = await git(root, "rev-parse", "HEAD");
  assert.equal((await service.rebasePullRequest(pr)).status, "conflicts");
  await writeFile(join(root, "other.txt"), "new user edit\n");
  await new ConflictService(root).abortOperation("cherry-pick");
  assert.equal((await restorePendingDeferredCommitRebaseAfterAbort(root)).status, "restored");
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "new user edit\n");
  assert.equal(await git(root, "rev-parse", "HEAD"), before);
});

for (const action of ["abort", "skip"] as const) {
  test(`old ${action} confirmation cannot control a replacement rebase`, async t => {
    const { root } = await prSafetyFixture(t, true);
    await assert.rejects(git(root, "rebase", "source"));
    const original = await captureGitOperation(root);
    t.mock.method(window, "showWarningMessage", async (...args: unknown[]) => {
      await git(root, "rebase", "--abort");
      await assert.rejects(git(root, "rebase", "source"));
      await writeFile(join(root, "tracked.txt"), "replacement resolution\n");
      return args[2];
    });
    await (action === "abort" ? abortOperation : skipOperation)(controller(root, "rebase"));
    assert.notEqual((await captureGitOperation(root)).generation, original.generation);
    assert.equal(await detectOperation(root), "rebase");
    assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "replacement resolution\n");
    assert.match(__errorMessages.at(-1) || "", /operation changed/);
  });
}

test("stale deferred pending cannot claim an unrelated native Continue result", async t => {
  const { root, base, pr, service } = await prSafetyFixture(t, true);
  await service.rebasePullRequest(pr);
  const pending = await readPendingDeferredCommitRebase(root);
  await git(root, "cherry-pick", "--abort");
  await git(root, "switch", "-qc", "external", base);
  const unrelated = await commitText(root, "external content\n", "external");
  await git(root, "switch", "main");
  await assert.rejects(git(root, "cherry-pick", unrelated));
  await writeFile(join(root, "tracked.txt"), "external resolution\n");
  await git(root, "add", "tracked.txt");
  await continueOperation(controller(root, "cherry-pick"));
  assert.equal(await detectOperation(root), "none");
  assert.equal(await git(root, "show", "HEAD:tracked.txt"), "external resolution");
  assert.equal(await service.hasUndoSnapshot(), false);
  assert.deepEqual(await readPendingDeferredCommitRebase(root), pending);
  await assert.rejects(continuePendingDeferredCommitRebase(root), /operation changed/);
});

test("paused edit rejects unrelated staged data before modifying the worktree or index", async t => {
  const { root, base } = await prSafetyFixture(t);
  const head = await commitText(root, "edit target\n", "edit target");
  const service = new RebaseService(root);
  const result = await service.start(base, false, [{ hash: head, action: "edit" }], editor);
  assert.equal(result.status, "paused");
  await writeFile(join(root, "tracked.txt"), "intended edit\n");
  await writeFile(join(root, "other.txt"), "unrelated staged\n");
  await git(root, "add", "other.txt");
  const index = await git(root, "ls-files", "--stage");
  await assert.rejects(service.amendPausedEditChanges(result.paused), /Unrelated staged changes/);
  await continueOperation(controller(root, "rebase"));
  assert.match(__errorMessages.at(-1) || "", /Unrelated staged changes/);
  assert.equal(await git(root, "ls-files", "--stage"), index);
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "intended edit\n");
});

for (const changed of ["worktree", "index"] as const) {
  test(`temporary rebase edit preserves a newer ${changed} version`, async t => {
    const { root, base } = await prSafetyFixture(t);
    const head = await commitText(root, "edit target\n", "edit target");
    const service = new RebaseService(root);
    const result = await service.start(base, false, [{ hash: head, action: "edit" }], editor);
    assert.ok(result.paused);
    const temporary = await createRebaseEditTempFile(root, result.paused, result.paused.files[0]);
    await writeFile(temporary.tempPath, "temporary edit\n");
    await writeFile(join(root, "tracked.txt"), "newer edit\n");
    if (changed === "index") {
      await git(root, "add", "tracked.txt");
      await writeFile(join(root, "tracked.txt"), "edit target\n");
    }
    const working = await readFile(join(root, "tracked.txt"));
    const index = await git(root, "ls-files", "--stage");
    await assert.rejects(service.amendPausedEditChanges(result.paused), /Both versions were kept/);
    assert.deepEqual(await readFile(join(root, "tracked.txt")), working);
    assert.equal(await git(root, "ls-files", "--stage"), index);
    assert.equal(await readFile(temporary.tempPath, "utf8"), "temporary edit\n");
  });
}

test("unchanged edit session still applies the temporary edit and amends successfully", async t => {
  const { root, base } = await prSafetyFixture(t);
  const head = await commitText(root, "edit target\n", "edit target");
  const service = new RebaseService(root);
  const result = await service.start(base, false, [{ hash: head, action: "edit" }], editor);
  assert.ok(result.paused);
  const temporary = await createRebaseEditTempFile(root, result.paused, result.paused.files[0]);
  await writeFile(temporary.tempPath, "temporary edit\n");
  assert.equal(await service.amendPausedEditChanges(result.paused), true);
  await new ConflictService(root).continueOperation("rebase");
  assert.equal(await git(root, "show", "HEAD:tracked.txt"), "temporary edit");
  assert.equal(await git(root, "status", "--porcelain"), "");
});

test("autostash restore conflicts remain visible and are not reported as completed", async t => {
  const { root, base } = await prSafetyFixture(t);
  const head = await commitText(root, "drop target\n", "drop target");
  await writeFile(join(root, "tracked.txt"), "user changes to dropped content\n");
  const result = await new RebaseService(root).start(base, false, [{ hash: head, action: "drop" }], editor);
  assert.equal(result.status, "conflicts");
  assert.equal(result.restoringLocalChanges, true);
  assert.equal(await detectOperation(root), "none");
  assert.equal(await git(root, "diff", "--name-only", "--diff-filter=U"), "tracked.txt");
  assert.match(await git(root, "stash", "list"), /autostash/);
  const progress = graphRebaseResultProgress("run", result);
  assert.equal(progress.type, "graphRebaseProgress");
  if (progress.type === "graphRebaseProgress") {
    assert.equal(progress.progress.phase, "conflicts");
    assert.equal(progress.progress.active, false);
    assert.match(progress.progress.detail, /autostash/);
  }
});

test("prepared interactive plan cannot rewrite a different branch at the same HEAD", async t => {
  const { root } = await prSafetyFixture(t);
  const head = await commitText(root, "target\n", "original message");
  const service = new RebaseService(root);
  const plan = await service.prepareCurrentBranchPlan(head);
  await git(root, "switch", "-qc", "other-branch");
  await assert.rejects(service.start(plan.base, false, [{ hash: head, action: "reword", message: "wrong branch" }], editor), /branch or HEAD changed/);
  assert.equal(await git(root, "rev-parse", "main"), head);
  assert.equal(await git(root, "rev-parse", "other-branch"), head);
  assert.equal(await detectOperation(root), "none");
});

test("merge-containing interactive plan fails before starting rebase or autostash", async t => {
  const { root, base } = await prSafetyFixture(t);
  await writeFile(join(root, "main.txt"), "main\n");
  await git(root, "add", "main.txt");
  await git(root, "commit", "-qm", "main");
  await git(root, "merge", "--no-ff", "-qm", "merge", "source");
  const head = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "other.txt"), "keep local edit\n");
  const service = new RebaseService(root);
  const commits = await service.getCommits(base);
  await assert.rejects(service.start(base, false, commits.map(commit => ({ hash: commit.hash, action: "pick" })), editor), /contains merge commits/);
  assert.equal(await detectOperation(root), "none");
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.equal(await git(root, "stash", "list"), "");
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "keep local edit\n");
});

test("stack rollback preserves a new user commit on a previously completed layer", async t => {
  const { root, base } = await prSafetyFixture(t);
  const metadata = new PullRequestStackMetadataService(root);
  await metadata.createLayer({ branch: "stack/one", parentBranch: "main", parentRef: base });
  await git(root, "switch", "stack/one");
  await writeFile(join(root, "one.txt"), "one\n");
  await git(root, "add", "one.txt");
  await git(root, "commit", "-qm", "one");
  const oldOne = await git(root, "rev-parse", "HEAD");
  await metadata.createLayer({ branch: "stack/two", parentBranch: "stack/one", parentRef: oldOne });
  await git(root, "switch", "stack/two");
  await commitText(root, "two\n", "two");
  await git(root, "switch", "main");
  await commitText(root, "new main\n", "main moved");
  const stack = new PullRequestStackRestackService(root);
  const result = await stack.execute(await stack.createPlan("stack/one"));
  assert.equal(result.status, "conflicts");
  if (result.status !== "conflicts") return;
  t.after(async () => { await git(root, "worktree", "remove", "--force", result.worktreePath).catch(() => undefined); });
  assert.notEqual(await git(root, "rev-parse", "stack/one"), oldOne);
  await git(root, "switch", "stack/one");
  await writeFile(join(root, "user.txt"), "new user work\n");
  await git(root, "add", "user.txt");
  await git(root, "commit", "-qm", "new user commit");
  const userHead = await git(root, "rev-parse", "HEAD");
  await new ConflictService(result.worktreePath).abortOperation("rebase");
  await assert.rejects(new PullRequestStackRestackService(result.worktreePath).restoreAfterAbort(), /branch changed after restack/);
  assert.equal(await git(root, "rev-parse", "stack/one"), userHead);
  assert.equal(await readFile(join(root, "user.txt"), "utf8"), "new user work\n");
  assert.equal(await stack.hasPendingRestack(), true);
});

test("native rebase abort preserves conflict resolution bytes in a recovery manifest", async t => {
  const { root } = await prSafetyFixture(t, true);
  await assert.rejects(git(root, "rebase", "source"));
  await writeFile(join(root, "tracked.txt"), "saved resolution\n");
  await new ConflictService(root).abortOperation("rebase");
  const directory = join(root, ".git/gitsimplecompare/operation-recovery");
  const [backup] = await readdir(directory);
  const manifest = JSON.parse(await readFile(join(directory, backup, "manifest.json"), "utf8"));
  const file = manifest.files.find((entry: { path: string }) => entry.path === "tracked.txt");
  assert.equal(await readFile(join(directory, backup, file.dataFile), "utf8"), "saved resolution\n");
  assert.equal(await detectOperation(root), "none");
});
