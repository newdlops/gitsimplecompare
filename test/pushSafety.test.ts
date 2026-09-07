import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { forcePushCurrent, getCurrentPushPlan, pushCurrentWithAutoUpstream } from "../src/git/pushService";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

test("first push publishes the approved commit and sets upstream on its local branch", async (t) => {
  const { root, directory, head } = await safetyFixture(t, "first-push");
  const remote = await addOrigin(root, directory, false);
  const plan = await getCurrentPushPlan(root);
  assert.equal(plan.mode, "setUpstream");
  await pushCurrentWithAutoUpstream(root, plan);
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), head);
  assert.equal(await git(root, "rev-parse", "--abbrev-ref", "@{u}"), "origin/main");
});

test("plain push publishes the current commit to its configured destination", async (t) => {
  const { root, directory } = await safetyFixture(t, "plain-push");
  const remote = await addOrigin(root, directory);
  const head = await commitText(root, "new commit\n", "new commit");
  const plan = await getCurrentPushPlan(root);
  assert.equal(plan.mode, "plain");
  await pushCurrentWithAutoUpstream(root, plan);
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), head);
});

for (const mode of ["normal", "force", "forceWithLease"] as const) {
  test(`${mode} push rejects a branch switch after its plan was created`, async (t) => {
    const { root, directory } = await safetyFixture(t, `push-branch-${mode}`);
    const remote = await addOrigin(root, directory, false);
    const plan = await getCurrentPushPlan(root);
    await git(root, "switch", "-qc", "other");
    const otherHead = await commitText(root, "unapproved work\n", "other commit");
    await assert.rejects(() => mode === "normal"
      ? pushCurrentWithAutoUpstream(root, plan) : forcePushCurrent(root, mode, plan), /changed after confirmation/);
    assert.equal(await git(remote, "for-each-ref", "--format=%(refname)", "refs/heads"), "");
    assert.equal(await git(root, "rev-parse", "HEAD"), otherHead);
    await assert.rejects(() => git(root, "config", "--get", "branch.other.remote"));
  });
}

test("a new commit on the same branch invalidates a previously approved push", async (t) => {
  const { root, directory, head } = await safetyFixture(t, "push-new-head");
  const remote = await addOrigin(root, directory);
  const plan = await getCurrentPushPlan(root);
  await commitText(root, "unapproved commit\n", "new commit");
  await assert.rejects(() => pushCurrentWithAutoUpstream(root, plan), /changed after confirmation/);
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), head);
});

test("remote URL and refspec changes invalidate a previously approved push", async (t) => {
  const { root, directory, head } = await safetyFixture(t, "push-config");
  const remote = await addOrigin(root, directory);
  const plan = await getCurrentPushPlan(root);
  const otherRemote = join(directory, "other-origin.git");
  await git(directory, "init", "--bare", "-q", otherRemote);
  await git(root, "remote", "set-url", "origin", otherRemote);
  await assert.rejects(() => pushCurrentWithAutoUpstream(root, plan), /changed after confirmation/);
  assert.equal(await git(otherRemote, "for-each-ref", "--format=%(refname)"), "");
  await git(root, "remote", "set-url", "origin", remote);
  await git(root, "config", "remote.origin.push", "refs/heads/main:refs/heads/destination");
  await assert.rejects(() => pushCurrentWithAutoUpstream(root, plan), /changed after confirmation/);
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), head);
});

test("a configured push refspec keeps its destination when the plan is current", async (t) => {
  const { root, directory, head } = await safetyFixture(t, "push-custom-target");
  const remote = await addOrigin(root, directory);
  await git(root, "config", "remote.origin.push", "refs/heads/main:refs/heads/destination");
  await pushCurrentWithAutoUpstream(root, await getCurrentPushPlan(root));
  assert.equal(await git(remote, "rev-parse", "refs/heads/destination"), head);
});

test("switching branches inside pre-push cannot change the source commit or another branch upstream", async (t) => {
  const { root, directory, head } = await safetyFixture(t, "push-fixed-source");
  const remote = await addOrigin(root, directory, false);
  await git(root, "switch", "-qc", "other");
  const otherHead = await commitText(root, "other work\n", "other commit");
  await git(root, "switch", "-q", "main");
  const plan = await getCurrentPushPlan(root);
  await writeFile(join(directory, "hooks/pre-push"), "#!/bin/sh\ngit switch --quiet other\n", { mode: 0o755 });
  await pushCurrentWithAutoUpstream(root, plan);
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), head);
  assert.equal(await git(root, "rev-parse", "HEAD"), otherHead);
  assert.equal(await git(root, "config", "--get", "branch.main.remote"), "origin");
  await assert.rejects(() => git(root, "config", "--get", "branch.other.remote"));
});

test("force-with-lease keeps the approved remote OID even after a background fetch", async (t) => {
  const { root, directory } = await safetyFixture(t, "push-lease");
  const remote = await addOrigin(root, directory);
  const plan = await getCurrentPushPlan(root);
  await git(root, "switch", "-qc", "other");
  const remoteHead = await commitText(root, "remote advanced\n", "remote update");
  await git(root, "push", "origin", "HEAD:main");
  await git(root, "switch", "-q", "main");
  await git(root, "fetch", "origin");
  await assert.rejects(() => forcePushCurrent(root, "forceWithLease", plan), /stale info|rejected/);
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), remoteHead);
});

test("an approved force push can still replace a diverged remote branch", async (t) => {
  const { root, directory, head } = await safetyFixture(t, "push-force");
  const remote = await addOrigin(root, directory);
  await git(root, "switch", "-qc", "other");
  await commitText(root, "remote update\n", "remote update");
  await git(root, "push", "origin", "HEAD:main");
  await git(root, "switch", "-q", "main");
  await forcePushCurrent(root, "force", await getCurrentPushPlan(root));
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), head);
});
