import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GitLogService } from "../src/git/gitLogService";
import { PullService } from "../src/git/pullService";
import { BranchOperationService } from "../src/git/branchOperationService";
import { assertCurrentBranchHead } from "../src/git/refSafety";
import { checkoutBranch } from "../src/webview/graphBranchActions";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

test("a targeted checkout never mistakes a child ref for its parent and ignores unrelated broken metadata", async t => {
  const { root, head } = await safetyFixture(t, "targeted-checkout-safety");
  await git(root, "branch", "parent/child"); await git(root, "branch", "target");
  await writeFile(join(root, ".git", "refs", "heads", "broken"), `${"0".repeat(head.length)}\n`);
  const service = new GitLogService(root);
  assert.equal(await service.getLocalBranchCheckoutState("parent"), undefined);
  assert.deepEqual(await service.getLocalBranchCheckoutState("main"), { name: "main", current: true });
  assert.equal(await checkoutBranch({ logService: service, refreshCheckout: async () => {}, refreshGraph: async () => {} }, "target"), true);
  assert.equal(await git(root, "symbolic-ref", "--short", "HEAD"), "target");
});

test("one-query ref validation still rejects another checked-out branch at the identical commit", async t => {
  const { root, head } = await safetyFixture(t, "ref-identity-safety");
  await assertCurrentBranchHead(root, "main", head, "checking the expected branch");
  await git(root, "switch", "-qc", "other");
  await assert.rejects(assertCurrentBranchHead(root, "main", head, "checking the expected branch"), /Ref safety check failed/);
  assert.equal(await git(root, "branch", "--show-current"), "other");
});

test("a missing pull target is detected by the transfer without stashing or changing dirty files and index", async t => {
  const { root, directory, head } = await safetyFixture(t, "missing-pull-target-safety");
  await addOrigin(root, directory);
  await git(root, "config", "branch.main.merge", "refs/heads/missing");
  await writeFile(join(root, "tracked.txt"), "staged content\n"); await git(root, "add", "tracked.txt");
  await writeFile(join(root, "tracked.txt"), "unstaged content\n");
  await writeFile(join(root, "untracked.txt"), "untracked content\n");
  const index = await git(root, "ls-files", "--stage", "-z");
  await assert.rejects(new PullService(root).pullCurrent(), /Configured upstream 'origin\/missing' was not found/);
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.equal(await git(root, "ls-files", "--stage", "-z"), index);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "unstaged content\n");
  assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "untracked content\n");
  assert.equal(await git(root, "stash", "list"), "");
});

for (const change of ["switch", "commit"] as const) {
  test(`squash stops before merging if the initial checkout changes during preparation (${change})`, async t => {
    const { root } = await safetyFixture(t, `squash-preparation-${change}`);
    await git(root, "switch", "-qc", "target"); await commitText(root, "target content\n", "target");
    await git(root, "switch", "main");
    const service = new BranchOperationService(root);
    const source = (service as any).assertSourceBranch.bind(service);
    let expectedHead = "";
    t.mock.method(service as any, "assertSourceBranch", async (...args: any[]) => {
      await source(...args);
      if (change === "switch") await git(root, "switch", "-qc", "other");
      else await commitText(root, "new user commit\n", "new user commit");
      expectedHead = await git(root, "rev-parse", "HEAD");
    });
    await assert.rejects(service.squashMerge("target"), /Ref safety check failed/);
    assert.equal(await git(root, "rev-parse", "HEAD"), expectedHead);
    assert.equal(await git(root, "branch", "--show-current"), change === "switch" ? "other" : "main");
    assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), change === "switch" ? "base\n" : "new user commit\n");
    assert.equal(await git(root, "status", "--porcelain"), "");
  });
}
