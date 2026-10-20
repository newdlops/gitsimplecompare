import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { getCurrentPushPlan, pushCurrentWithAutoUpstream } from "../src/git/pushService";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";

test("changing the push URL after full approval still prevents every actual remote update", async t => {
  const f = await safetyFixture(t, "push-validated-url"), remote = await addOrigin(f.root, f.directory);
  const other = `${remote}-other`; await git(f.directory, "clone", "--bare", "-q", remote, other);
  await commitText(f.root, "outgoing\n", "outgoing");
  const plan = await getCurrentPushPlan(f.root);
  await assert.rejects(pushCurrentWithAutoUpstream(f.root, plan, { onProgress: progress => {
    if (progress.phase === "planning") execFileSync("git", ["config", "--local", "remote.origin.url", other], { cwd: f.root });
  } }), /changed after confirmation/);
  assert.equal(await git(remote, "rev-parse", "main"), f.head);
  assert.equal(await git(other, "rev-parse", "main"), f.head);
});

test("a new local commit during planning is caught by the fresh pre-transfer check", async t => {
  const f = await safetyFixture(t, "push-validated-head"), remote = await addOrigin(f.root, f.directory);
  await commitText(f.root, "outgoing\n", "outgoing");
  const plan = await getCurrentPushPlan(f.root);
  await assert.rejects(pushCurrentWithAutoUpstream(f.root, plan, { onProgress: progress => {
    if (progress.phase === "ready") execFileSync("git", ["commit", "--allow-empty", "-qm", "external new commit"], { cwd: f.root });
  } }), /changed after confirmation/);
  assert.equal(await git(remote, "rev-parse", "main"), f.head);
});

test("an additional beforePush condition is checked before any remote planning read", async t => {
  const f = await safetyFixture(t, "push-validated-condition"); await addOrigin(f.root, f.directory);
  await commitText(f.root, "outgoing\n", "outgoing"); const plan = await getCurrentPushPlan(f.root);
  const commands: string[] = [], stop = setGitExecutionObserver(timing => { commands.push(timing.command); });
  let checks = 0;
  try { await assert.rejects(pushCurrentWithAutoUpstream(f.root, plan, { beforePush: async () => { checks++; throw new Error("additional condition failed"); } }), /additional condition failed/); }
  finally { stop(); }
  assert.equal(checks, 1); assert.equal(commands.includes("ls-remote"), false);
});
