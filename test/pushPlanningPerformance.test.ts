import assert from "node:assert/strict";
import childProcess from "node:child_process";
import test, { type TestContext } from "node:test";
import { getCurrentPushPlan, pushCurrentWithAutoUpstream } from "../src/git/pushService";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** @param t spawn 복구를 소유할 테스트 문맥 @returns 이후 Git 실행의 인수 목록 */
function observe(t: TestContext): string[][] {
  const calls: string[][] = [], spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push([...args[1]]);
    return (spawn as Function)(...args);
  });
  return calls;
}

test("push planning reads the selected branch and its exact tracking tip together", async t => {
  const { root, directory, head } = await safetyFixture(t, "push-planning-performance");
  await addOrigin(root, directory);
  const next = await commitText(root, "next\n", "next");
  const calls = observe(t), plan = await getCurrentPushPlan(root);
  t.diagnostic(JSON.stringify({ phase: "plan", calls: calls.length, commands: calls.map(args => args[0]) }));
  assert.equal(plan.snapshot.head, next); assert.equal(plan.snapshot.remoteHead, head);
  assert.equal(plan.branch, "main"); assert.equal(plan.remote, "origin");
  assert.ok(calls.length <= 3, `push planning used ${calls.length} Git processes`);
});

test("a single outgoing commit does not repeat the same ancestry query before native push", async t => {
  const { root, directory } = await safetyFixture(t, "single-commit-push-performance");
  const remote = await addOrigin(root, directory), next = await commitText(root, "next\n", "next");
  const calls = observe(t), plan = await getCurrentPushPlan(root);
  const result = await pushCurrentWithAutoUpstream(root, plan);
  t.diagnostic(JSON.stringify({ phase: "push", calls: calls.length,
    ancestry: calls.filter(args => args[0] === "merge-base"), commands: calls.map(args => args[0]) }));
  assert.equal(result.execution?.strategy, "single");
  assert.ok(calls.length <= 13, `single-commit push used ${calls.length} Git processes`);
  assert.equal(calls.filter(args => args[0] === "merge-base").length, 1);
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), next);
});
