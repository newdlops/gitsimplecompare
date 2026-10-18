import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { forcePushCurrent, getCurrentPushPlan, pushCurrentWithAutoUpstream } from "../src/git/pushService";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

test("a tracking ref prefix cannot supply a missing exact force-with-lease expectation", async t => {
  const { root, directory, head } = await safetyFixture(t, "push-tracking-prefix");
  const remote = await addOrigin(root, directory);
  await git(root, "update-ref", "-d", "refs/remotes/origin/main");
  await git(root, "update-ref", "refs/remotes/origin/main/child", head);
  await commitText(root, "lease must reject a real update\n", "lease update");
  const plan = await getCurrentPushPlan(root);
  assert.equal(plan.snapshot.remoteHead, "");
  await assert.rejects(() => forcePushCurrent(root, "forceWithLease", plan), /stale info|rejected/);
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), head);
});

test("a custom push destination retains its exact tracking OID and publishes only that branch", async t => {
  const { root, directory, head } = await safetyFixture(t, "push-mapped-tracking");
  const remote = await addOrigin(root, directory);
  await git(root, "push", "origin", "main:destination");
  await git(root, "config", "remote.origin.push", "refs/heads/main:refs/heads/destination");
  const next = await commitText(root, "destination only\n", "destination only");
  const plan = await getCurrentPushPlan(root);
  assert.equal(plan.snapshot.targetRef, "refs/heads/destination");
  assert.equal(plan.snapshot.remoteHead, head);
  await pushCurrentWithAutoUpstream(root, plan);
  assert.equal(await git(remote, "rev-parse", "refs/heads/destination"), next);
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), head);
});

test("reading a tracking OID does not open its possibly missing object", async t => {
  const { root, directory } = await safetyFixture(t, "push-missing-tracking-object");
  await addOrigin(root, directory);
  await git(root, "remote", "add", "other", join(directory, "other.git"));
  await git(root, "config", "branch.main.pushRemote", "other");
  await git(root, "config", "remote.other.push", "refs/heads/main:refs/heads/main");
  const missing = "f".repeat(40), refs = join(root, ".git", "refs", "remotes", "other");
  await mkdir(refs, { recursive: true });
  await writeFile(join(refs, "main"), `${missing}\n`);
  const plan = await getCurrentPushPlan(root);
  assert.equal(plan.remote, "other");
  assert.equal(plan.snapshot.remoteHead, missing);
});

for (const objectType of ["blob", "tag"] as const) {
  test(`a corrupted source branch pointing to a ${objectType} is rejected before push`, async t => {
    const { root, directory, head } = await safetyFixture(t, `push-source-${objectType}`);
    const remote = await addOrigin(root, directory);
    if (objectType === "tag") await git(root, "tag", "-am", "source tag", "source-tag");
    const oid = objectType === "blob" ? await git(root, "hash-object", "-w", "tracked.txt")
      : await git(root, "rev-parse", "refs/tags/source-tag");
    await writeFile(join(root, ".git", "refs", "heads", "main"), `${oid}\n`);
    await assert.rejects(() => getCurrentPushPlan(root), /commit|checkout identity/i);
    assert.equal(await git(remote, "rev-parse", "refs/heads/main"), head);
  });
}

test("tags named HEAD and like the current branch cannot change the selected push source", async t => {
  const { root, directory, head } = await safetyFixture(t, "push-source-ambiguous");
  await addOrigin(root, directory);
  await git(root, "update-ref", "refs/tags/HEAD", head); await git(root, "tag", "main", head);
  const plan = await getCurrentPushPlan(root);
  assert.equal(plan.branch, "main"); assert.equal(plan.snapshot.head, head);
  assert.equal(plan.snapshot.targetRef, "refs/heads/main");
});
