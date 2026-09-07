import assert from "node:assert/strict";
import test from "node:test";
import cp from "node:child_process";
import * as fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PullRequestStackRestackService } from "../src/git/pullRequestStackRestack";
import { PullRequestStackMetadataService } from "../src/git/pullRequestStackMetadata";
import { ConflictService } from "../src/git/conflictService";
import { git, commitText } from "./helpers/gitSafetyFixture";
import { prSafetyFixture } from "./helpers/prOperationSafetyFixture";

test("off-branch Undo rejects a ref update between validation and the final write", async t => {
  const { root, pr, service } = await prSafetyFixture(t);
  const result = await service.squashCherryPick(pr);
  const external = await git(root, "commit-tree", await git(root, "rev-parse", "HEAD^{tree}"), "-p", result.afterHead, "-m", "external commit");
  await git(root, "switch", "source");
  const plan = await service.prepareUndo("main");
  const execute = cp.execFile;
  let injected = false;
  t.mock.method(cp, "execFile", ((file: string, args: string[], ...rest: any[]) => {
    if (!injected && file === "git" && args[0] === "update-ref" && args.includes("refs/heads/main")) {
      injected = true;
      cp.execFileSync("git", ["update-ref", "refs/heads/main", external, result.afterHead], { cwd: root });
    }
    return (execute as any)(file, args, ...rest);
  }) as any);
  await assert.rejects(service.undoLastOperation("main", plan), /cannot lock ref|expected/);
  assert.equal(injected, true);
  assert.equal(await git(root, "rev-parse", "main"), external);
  assert.equal(await git(root, "rev-parse", result.snapshotRef), result.beforeHead);
});

test("off-branch Undo still protects a branch checked out in another worktree", async t => {
  const { root, directory, pr, service } = await prSafetyFixture(t);
  const result = await service.squashCherryPick(pr);
  await git(root, "switch", "source");
  await git(root, "worktree", "add", join(directory, "linked"), "main");
  await assert.rejects(service.undoLastOperation("main"), /checked out/);
  assert.equal(await git(root, "rev-parse", "main"), result.afterHead);
});

for (const owner of [false, true]) {
  test(`stack rollback resumes after ref restoration checkpoint fails (${owner ? "owned worktree" : "unoccupied branch"})`, async t => {
    const { root, base, directory } = await prSafetyFixture(t);
    const metadata = new PullRequestStackMetadataService(root);
    await metadata.createLayer({ branch: "stack/one", parentBranch: "main", parentRef: base });
    await git(root, "switch", "stack/one");
    await writeFile(join(root, "one.txt"), "one\n"); await git(root, "add", "."); await git(root, "commit", "-qm", "one");
    const before = await git(root, "rev-parse", "HEAD");
    await metadata.createLayer({ branch: "stack/two", parentBranch: "stack/one", parentRef: before });
    await git(root, "switch", "stack/two"); await commitText(root, "two conflict\n", "two");
    await git(root, "switch", "main"); await commitText(root, "main conflict\n", "advanced main");
    await git(root, "switch", "stack/two");
    if (owner) await git(root, "worktree", "add", join(directory, "owner"), "stack/one");
    const service = new PullRequestStackRestackService(root);
    assert.equal((await service.execute(await service.createPlan("stack/one"))).status, "conflicts");
    await new ConflictService(root).abortOperation("rebase");
    const rename = fs.promises.rename;
    let injected = false;
    const mock = t.mock.method(fs.promises, "rename", async (from, to) => {
      if (!injected && String(to).endsWith("/stack-restack-state.json")) {
        const state = JSON.parse(await readFile(from, "utf8"));
        if (state.steps[0].afterHead === before) { injected = true; throw Object.assign(new Error("checkpoint disk full"), { code: "ENOSPC" }); }
      }
      return rename(from, to);
    });
    await assert.rejects(service.restoreAfterAbort(), /checkpoint disk full/);
    assert.equal(injected, true);
    assert.equal(await git(root, "rev-parse", "stack/one"), before);
    mock.mock.restore();
    assert.equal(await service.restoreAfterAbort(), root);
    assert.equal(await service.hasPendingRestack(), false);
    assert.equal(await git(root, "rev-parse", "stack/one"), before);
  });
}
