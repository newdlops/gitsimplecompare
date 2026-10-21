import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { BranchOperationService } from "../src/git/branchOperationService";
import { OperationUndoStore } from "../src/git/operationUndoStore";
import { PullRequestOperationSnapshot } from "../src/git/pullRequestOperationSnapshot";
import { prSafetyFixture } from "./helpers/prOperationSafetyFixture";
import { git } from "./helpers/gitSafetyFixture";

/** 적용 결과 위에 외부 작업자의 별도 commit을 만든다. 원래 로컬 편집은 stage하지 않는다. */
async function externalCommit(root: string): Promise<string> {
  await writeFile(join(root, "external.txt"), "external committed work\n");
  await git(root, "add", "external.txt"); await git(root, "commit", "-qm", "external commit before completion capture");
  return git(root, "rev-parse", "HEAD");
}

for (const mode of ["squashCherryPick", "rebasePullRequest", "squashRevertPullRequest", "rebaseRevertPullRequest"] as const) {
  test(`${mode} binds the published worktree result and preserves an external commit before recording`, async t => {
    const f = await prSafetyFixture(t);
    if (mode.includes("Revert")) await git(f.root, "merge", "--ff-only", "source");
    const before = await git(f.root, "rev-parse", "HEAD"), original = PullRequestOperationSnapshot.prototype.recordCompleted;
    let expected = "", later = "", snapshot = "";
    t.mock.method(PullRequestOperationSnapshot.prototype, "recordCompleted", async function (this: PullRequestOperationSnapshot, ...args: Parameters<typeof original>) {
      snapshot = args[1]; expected = args[2]; assert.equal(expected, await git(f.root, "rev-parse", "HEAD"));
      later = await externalCommit(f.root); return original.apply(this, args);
    });
    await assert.rejects(f.service[mode](f.pr, { strategy: "worktree" }), /Ref safety/);
    assert.ok(expected && later && expected !== later);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), later); assert.equal(await git(f.root, "rev-parse", "HEAD^"), expected);
    assert.equal(await readFile(join(f.root, "external.txt"), "utf8"), "external committed work\n");
    assert.equal(await git(f.root, "rev-parse", snapshot), before);
    await assert.rejects(new OperationUndoStore(f.root, "pull-request").prepare("main"));
  });
}

for (const dirty of [false, true]) {
  test(`branch squash ${dirty ? "with local work" : "on a clean tree"} cannot capture a later external commit`, async t => {
    const f = await prSafetyFixture(t), service = new BranchOperationService(f.root), original = OperationUndoStore.prototype.capture;
    if (dirty) await writeFile(join(f.root, "other.txt"), "preserved local work\n");
    let expected = "", later = "", snapshot = "";
    t.mock.method(OperationUndoStore.prototype, "capture", async function (this: OperationUndoStore, ...args: Parameters<typeof original>) {
      if (args[2] === "completed" && !later) {
        snapshot = args[1]; expected = args[4]!; assert.equal(expected, await git(f.root, "rev-parse", "HEAD"));
        later = await externalCommit(f.root);
      }
      return original.apply(this, args);
    });
    await assert.rejects(service.squashMerge("source"), /Ref safety/);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), later); assert.equal(await git(f.root, "rev-parse", "HEAD^"), expected);
    assert.equal(await readFile(join(f.root, "other.txt"), "utf8"), dirty ? "preserved local work\n" : "other base\n");
    assert.equal(await git(f.root, "rev-parse", snapshot), f.base); assert.equal(await service.hasUndoSnapshot(), false);
  });
}

test("native branch rebase completion rejects an external commit before Undo ownership is recorded", async t => {
  const f = await prSafetyFixture(t), service = new BranchOperationService(f.root), original = OperationUndoStore.prototype.capture;
  let later = "", expected = "", snapshot = "";
  t.mock.method(OperationUndoStore.prototype, "capture", async function (this: OperationUndoStore, ...args: Parameters<typeof original>) {
    if (args[2] === "completed" && !later) {
      snapshot = args[1]; expected = args[4]!; assert.equal(expected, await git(f.root, "rev-parse", "HEAD"));
      later = await externalCommit(f.root);
    }
    return original.apply(this, args);
  });
  await assert.rejects(service.rebaseMerge("source"), /Ref safety|follow-up processing failed/);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), later); assert.equal(await git(f.root, "rev-parse", "HEAD^"), expected);
  assert.equal(await git(f.root, "rev-parse", snapshot), f.base); assert.equal(await service.hasUndoSnapshot(), false);
});
