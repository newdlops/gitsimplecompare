import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runGitWithInput } from "../src/git/gitExec";
import { PullRequestOperationSnapshot } from "../src/git/pullRequestOperationSnapshot";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

test("unmerged index entries without native operation markers still block PR application", async t => {
  const { root, head } = await safetyFixture(t, "pr-unmerged-index");
  const base = await git(root, "rev-parse", "HEAD:tracked.txt");
  const current = (await runGitWithInput(["hash-object", "-w", "--stdin"], root, "current\n")).trim();
  const incoming = (await runGitWithInput(["hash-object", "-w", "--stdin"], root, "incoming\n")).trim();
  await runGitWithInput(["update-index", "--index-info"], root,
    `0 ${"0".repeat(40)}\ttracked.txt\n100644 ${base} 1\ttracked.txt\n100644 ${current} 2\ttracked.txt\n100644 ${incoming} 3\ttracked.txt\n`);
  const index = await git(root, "ls-files", "--stage", "-z");
  const state = new PullRequestOperationSnapshot(root);
  assert.equal(await state.hasUnmergedChanges(), true);
  assert.equal(await state.hasUnmergedChangesIn(root), true);
  await assert.rejects(state.prepareForPrOperation(), /Resolve unmerged/);
  assert.equal(await git(root, "rev-parse", "HEAD"), head);
  assert.equal(await git(root, "ls-files", "--stage", "-z"), index);
});

test("unstaged deletions and staged additions are not mistaken for conflicts", async t => {
  const { root, head } = await safetyFixture(t, "pr-index-without-scan");
  await rm(join(root, "tracked.txt"));
  await writeFile(join(root, "staged.txt"), "user addition\n");
  await git(root, "add", "staged.txt");
  const state = new PullRequestOperationSnapshot(root);
  assert.equal(await state.hasUnmergedChanges(), false);
  assert.deepEqual(await state.prepareForPrOperation(), { branch: "main", beforeHead: head });
  assert.equal(await git(root, "show", ":staged.txt"), "user addition");
  await assert.rejects(git(root, "show", "HEAD:staged.txt"));
});
