import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { BranchOperationService } from "../src/git/branchOperationService";
import { GitLogService } from "../src/git/gitLogService";
import { runGitWithInput } from "../src/git/gitExec";
import { PullService } from "../src/git/pullService";
import { getCurrentPushPlan, pushCurrentWithAutoUpstream } from "../src/git/pushService";
import { checkoutBranch } from "../src/webview/graphBranchActions";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/**
 * 실제 사용자 저장소 대신 fixture에서 실행되는 Git 프로세스만 작업 구간별로 기록한다.
 * @param t mock 복구를 소유하는 테스트 문맥 @param label 측정 작업 이름 @param task 실제 서비스 호출
 * @returns 작업 결과와 검증용으로 복사한 Git 인수 목록
 */
async function measured<T>(t: TestContext, label: string, task: () => Promise<T>) {
  const spawn = childProcess.spawn, calls: string[][] = [];
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push([...args[1]]);
    return (spawn as Function)(...args);
  });
  const started = performance.now(), result = await task();
  t.diagnostic(JSON.stringify({ label, gitProcesses: calls.length,
    elapsedMs: Math.round(performance.now() - started), commands: calls.map(args => args[0]) }));
  return { result, calls: calls.map(args => [...args]) };
}

test("checkout reads only its target branch before switching and preserves local edits", async t => {
  const { root } = await safetyFixture(t, "checkout-performance");
  await git(root, "branch", "target");
  await writeFile(join(root, "tracked.txt"), "keep local edit\n");
  const service = new GitLogService(root);
  let refreshed = 0;
  const { result, calls } = await measured(t, "checkout", () => checkoutBranch({ logService: service,
    refreshCheckout: async () => { refreshed++; }, refreshGraph: async () => {} }, "target"));
  assert.equal(result, true); assert.equal(refreshed, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ["for-each-ref", "--format=%(refname)%00%(HEAD)", "refs/heads/target"]);
  assert.equal(await git(root, "branch", "--show-current"), "target");
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "keep local edit\n");
});

for (const action of ["squashMerge", "rebaseMerge"] as const) {
  test(`${action} retains its actual commit result and undo snapshot with fewer preparation queries`, async t => {
    const { root, head } = await safetyFixture(t, `branch-${action}-performance`);
    await git(root, "switch", "-qc", "target");
    await writeFile(join(root, "target.txt"), "target content\n");
    await git(root, "add", "target.txt"); await git(root, "commit", "-qm", "target");
    const target = await git(root, "rev-parse", "HEAD");
    await git(root, "switch", "main");
    const before = await commitText(root, "main content\n", "main");
    const service = new BranchOperationService(root);
    const { result, calls } = await measured(t, action, () => service[action]("target"));
    assert.ok(calls.length <= (action === "squashMerge" ? 16 : 18), `${action} exceeded its Git process budget: ${calls.length}`);
    assert.equal(result.status, "completed"); assert.equal(result.beforeHead, before);
    assert.equal(await git(root, "rev-parse", result.snapshotRef), before);
    assert.equal(await git(root, "rev-parse", "HEAD"), result.afterHead);
    assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "main content\n");
    assert.equal(await readFile(join(root, "target.txt"), "utf8"), "target content\n");
    assert.notEqual(result.afterHead, head);
    if (action === "rebaseMerge") assert.equal(await git(root, "rev-parse", "HEAD^"), target);
    await service.undoLastOperation();
    assert.equal(await git(root, "rev-parse", "HEAD"), before);
  });
}

test("push preparation batches configuration reads while publishing only its approved commit", async t => {
  const { root, directory } = await safetyFixture(t, "push-performance");
  const remote = await addOrigin(root, directory);
  const head = await commitText(root, "push content\n", "push");
  const { result, calls } = await measured(t, "push", async () => {
    const plan = await getCurrentPushPlan(root);
    return pushCurrentWithAutoUpstream(root, plan);
  });
  assert.equal(result.execution?.strategy, "single");
  assert.ok(calls.length <= 17, `push used ${calls.length} Git processes`);
  assert.ok(calls.filter(args => args[0] === "config").length <= 3, "push must not repeat the configuration read removed from validated preparation");
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), head);
});

test("pull connects once on its normal path and keeps uncommitted work", async t => {
  const { root, directory } = await safetyFixture(t, "pull-performance");
  await addOrigin(root, directory);
  await writeFile(join(root, "tracked.txt"), "uncommitted content\n");
  const { result, calls } = await measured(t, "pull", () => new PullService(root).pullCurrent());
  assert.equal(calls.length, 4);
  assert.equal(calls.filter(args => args[0] === "pull" || args[0] === "ls-remote").length, 1);
  assert.deepEqual(result, { status: "completed", hadLocalChanges: true });
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "uncommitted content\n");
  assert.equal(await git(root, "stash", "list"), "");
});

test("fetch uses one native transfer and updates the remote tracking branch", async t => {
  const { root, directory } = await safetyFixture(t, "fetch-performance");
  const remote = await addOrigin(root, directory);
  const hash = await commitText(root, "remote next\n", "next");
  await git(root, "push", "origin", `${hash}:refs/heads/next`);
  await git(root, "update-ref", "-d", "refs/remotes/origin/next");
  const { calls } = await measured(t, "fetch", () => new GitLogService(root).fetchAll());
  assert.deepEqual(calls, [["fetch", "--all", "--prune"]]);
  assert.equal(await git(root, "rev-parse", "refs/remotes/origin/next"), await git(remote, "rev-parse", "refs/heads/next"));
});

/** 대량 브랜치의 upstream 이력 계산을 건너뛰는 효과를 같은 실제 저장소에서 직접 비교한다. */
test("checkout target lookup skips all other branch histories in a thousand-branch repository", async t => {
  const { root, directory, head } = await safetyFixture(t, "large-checkout-performance");
  await git(root, "remote", "add", "origin", join(directory, "unused-origin"));
  const commits = 2000, branches = 1000, input: string[] = [], config: string[] = [];
  for (let index = 1; index <= commits; index++) {
    const text = `history ${index}\n`;
    input.push(`commit refs/heads/history\nmark :${index}\ncommitter Checkout Test <checkout@example.test> ${1_700_000_000 + index} +0000\ndata ${Buffer.byteLength(text)}\n${text}from ${index === 1 ? head : `:${index - 1}`}\nM 100644 inline history.txt\ndata ${Buffer.byteLength(text)}\n${text}\n`);
  }
  input.push(`reset refs/remotes/origin/main\nfrom :${commits}\n\n`);
  for (let index = 0; index < branches; index++) {
    const name = `bench-${String(index).padStart(4, "0")}`;
    input.push(`reset refs/heads/${name}\nfrom :${index + 1}\n\n`);
    config.push(`[branch "${name}"]\n remote = origin\n merge = refs/heads/main\n`);
  }
  input.push("done\n");
  await runGitWithInput(["fast-import", "--quiet"], root, input.join(""));
  const configPath = join(root, ".git", "config");
  await writeFile(configPath, await readFile(configPath, "utf8") + config.join(""));
  await git(root, "pack-refs", "--all");
  const service = new GitLogService(root), samples: Array<{ previousMs: number; targetedMs: number }> = [];
  for (let round = 0; round < 2; round++) {
    const before = performance.now(), all = await service.getLocalBranches();
    const previousMs = performance.now() - before, start = performance.now();
    const target = await service.getLocalBranchCheckoutState("bench-0000");
    samples.push({ previousMs: Math.round(previousMs), targetedMs: Math.round(performance.now() - start) });
    assert.equal(all.length, branches + 2); assert.equal(all.find(branch => branch.name === target?.name)?.behind, commits - 1);
    assert.deepEqual(target, { name: "bench-0000", current: false });
  }
  t.diagnostic(JSON.stringify({ branches, commits, samples }));
});
