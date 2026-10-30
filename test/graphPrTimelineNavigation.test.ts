import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runGitWithInput } from "../src/git/gitExec";
import { GitLogService } from "../src/git/gitLogService";
import { PullRequestService } from "../src/git/pullRequestService";
import { PullRequestStackService } from "../src/git/pullRequestStackService";
import { pullRequestInfoFromGraphQl } from "../src/git/pullRequestInfo";
import { createOperationGraphPanel } from "./helpers/graphOperationPanel";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";
import { GraphLiveRenderer } from "./helpers/graphLiveRenderer";
import type { ToWebviewMessage } from "../src/webview/graphProtocol";

/** 서로 다른 세 브랜치의 시각을 교차시키고 PR 브랜치 ref만 삭제해 실제 그래프 밖 대상을 만든다. */
async function timelineFixture(t: TestContext, onPost?: (message: ToWebviewMessage) => void, autoReady = true, includePrHead = false) {
  const f = await safetyFixture(t, "pr-timeline-navigation");
  const records: string[] = [];
  for (const [branch, offset] of [["main", 0], ["other", 1], ["removed-pr", 2]] as const) {
    for (let index = 0; index < 600; index++) {
      const subject = `${branch} ${index}`;
      records.push(`commit refs/heads/${branch}\ncommitter Fixture <fixture@example.test> ${1700000000 + index * 3 + offset} +0000\n` +
        `data ${Buffer.byteLength(subject)}\n${subject}\n${index === 0 ? `from ${f.head}\n` : ""}\n`);
    }
  }
  await runGitWithInput(["fast-import", "--quiet"], f.root, records.join("") + "done\n");
  const target = await git(f.root, "rev-parse", "removed-pr~260");
  const navigationHead = includePrHead ? await git(f.root, "rev-parse", "removed-pr") : target;
  await git(f.root, "branch", "-D", "removed-pr");
  const pr = pullRequestInfoFromGraphQl({ number: 42, title: "Unreferenced pull request", state: "OPEN",
    headRefOid: navigationHead, headRefName: "removed-pr", baseRefName: "main" });
  pr.commitHashes = [...new Set([target, navigationHead])];
  pr.commitSummaries = [{ hash: target, title: await git(f.root, "show", "-s", "--format=%s", target), author: "Fixture" }];
  t.mock.method(PullRequestService.prototype, "getOverview", async () => ({ available: true,
    repository: "owner/repo", defaultBranch: "main", hasMore: false, pullRequests: [pr] }));
  t.mock.method(PullRequestStackService.prototype, "getGraphSnapshot", async () => ({
    repository: "owner/repo", defaultBranch: "main", stacks: [], layers: [] }));
  const h = createOperationGraphPanel(t, new GitLogService(f.root), onPost);
  t.after(() => h.panel.dispose());
  if (autoReady) {
    await h.receiveMessage({ type: "ready" });
    await h.panel.messages.refreshPullRequests("timeline-navigation");
  }
  return { ...f, ...h, target, navigationHead };
}

test("an unreferenced PR stays in the whole dated timeline across both pagination directions", async t => {
  const f = await timelineFixture(t);
  /** 실제 Native 저장소 원문으로 조회가 사용자 상태를 쓰지 않았는지 확인한다. */
  const protectedState = async () => ({ head: await git(f.root, "rev-parse", "HEAD"), refs: await git(f.root, "show-ref"),
    index: await readFile(join(f.root, ".git/index")), config: await readFile(join(f.root, ".git/config")),
    files: await readFile(join(f.root, "tracked.txt")) });
  const before = await protectedState();
  await f.receiveMessage({ type: "ensureCommitVisible", requestId: "outside-pr", hashes: [f.target], pullRequestNumber: 42 });
  assert.ok(f.messages.some(message => message.type === "commitVisibility" && message.requestId === "outside-pr" && message.found));
  const oracle = (await git(f.root, "rev-list", "--date-order", "--branches", "--remotes", "--tags", f.target)).split("\n");
  /** 전체 시간순의 연속 구간이어야 하며 원래 PR 행이 페이지 확장 후에도 남아야 한다. */
  const expectNativeRange = () => {
    const hashes = f.panel.commits.map((commit: { hash: string }) => commit.hash);
    assert.deepEqual(hashes, oracle.slice(f.panel.rangeStartIndex, f.panel.rangeStartIndex + hashes.length));
    assert.equal(new Set(hashes).size, hashes.length);
    assert.ok(hashes.includes(f.target));
  };
  assert.ok(f.panel.rangeStartIndex > 0, "the jump must retain access to newer commits from other branches");
  assert.equal(f.panel.exhausted, false, "an ancestor-only result must not falsely end older pagination");
  assert.ok(f.panel.commits.some((commit: { subject: string }) => commit.subject.startsWith("main ")));
  assert.ok(f.panel.commits.some((commit: { subject: string }) => commit.subject.startsWith("other ")));
  expectNativeRange();
  for (const direction of ["newer", "older", "older", "newer"] as const) {
    await f.receiveMessage({ type: "loadMore", direction });
    expectNativeRange();
  }
  assert.deepEqual(await protectedState(), before);
});

for (const emptyCatalog of [false, true]) test(`a PR jump before branch discovery keeps whole-history paging (empty catalog: ${emptyCatalog})`, async t => {
  const f = await timelineFixture(t);
  f.panel.remoteCatalogStatus = "pending";
  if (emptyCatalog) { f.panel.lastBranchRefs = []; f.panel.lastLocalBranches = []; }
  else f.panel.lastBranchRefs = [{ name: "main", kind: "local" }];
  await f.receiveMessage({ type: "ensureCommitVisible", requestId: "early-pr", hashes: [f.target], pullRequestNumber: 42 });
  const oracle = (await git(f.root, "rev-list", "--date-order", "--branches", "--remotes", "--tags", f.target)).split("\n");
  assert.ok(f.panel.commits.some((commit: { subject: string }) => commit.subject.startsWith("other ")),
    "an early All-branches jump must include healthy branches not yet present in the UI catalog");
  for (const direction of ["older", "newer"] as const) {
    await f.receiveMessage({ type: "loadMore", direction });
    const hashes = f.panel.commits.map((commit: { hash: string }) => commit.hash);
    assert.deepEqual(hashes, oracle.slice(f.panel.rangeStartIndex, f.panel.rangeStartIndex + hashes.length));
    assert.ok(hashes.includes(f.target), "a still-empty catalog must not clear the accepted PR history window");
  }
});

/** 실행 중인 실제 transport 결과를 제한 시간 안에서만 기다려 무한 대기를 성공으로 세지 않는다. */
async function until(check: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(`Timed out: ${description}`);
}

for (const action of ["row", "commit"] as const) test(`production PR ${action} control reaches the native timeline, paginates both ways, and opens history`, {
  skip: process.env.GSC_VERIFY_PR_RENDERER !== "1",
}, async t => {
  const renderer = await GraphLiveRenderer.create();
  t.after(() => renderer.dispose());
  const f = await timelineFixture(t, message => renderer.post(message), false, action === "commit");
  t.mock.method(PullRequestService.prototype, "getDetail", async () => ({ number: 42, files: [], fileCount: 0,
    commentCount: 0, fileCommentCount: 0, filesTruncated: false, reviewThreadsTruncated: false }));
  const requests: Array<{ type: string; direction?: string }> = [];
  renderer.onMessage(async message => { requests.push(message); await f.receiveMessage(message); });
  await renderer.mount(f.surface.webview.html);
  await until(() => f.panel.commits.length >= 300 && !f.panel.loading &&
    f.messages.some(message => message.type === "pullRequestOverview"), "initial graph and PR list");
  await renderer.waitForPendingFrame();
  await renderer.clickControl("#graph-pr-list");
  if (action === "row") await renderer.clickControl('[data-focus-pr="42"]');
  else {
    await renderer.clickControl(".pr-card-heading");
    await renderer.clickControl(`[data-focus-commit="${f.target}"]`);
  }
  await until(async () => !f.panel.loading && await renderer.countElements(`.pr-focused-row[data-hash="${f.target}"]`) === 1, "unloaded PR row revealed");
  const oracle = (await git(f.root, "rev-list", "--date-order", "--branches", "--remotes", "--tags", f.navigationHead)).split("\n");
  /** backend 위치와 실제 DOM 순서를 독립 Native 전체 이력에 동시에 대조한다. */
  const verifyTimeline = async () => {
    await renderer.waitForPendingFrame();
    const hashes = f.panel.commits.map((commit: { hash: string }) => commit.hash);
    assert.deepEqual(hashes, oracle.slice(f.panel.rangeStartIndex, f.panel.rangeStartIndex + hashes.length));
    assert.deepEqual(await renderer.readRenderedHashes(), hashes);
    assert.ok(hashes.includes(f.target));
  };
  await verifyTimeline();
  for (const direction of ["older", "newer"] as const) {
    const available = direction === "older" ? !f.panel.exhausted : f.panel.rangeStartIndex > 0;
    if (available) {
      const count = requests.filter(request => request.type === "loadMore" && request.direction === direction).length;
      await renderer.scrollGraph(direction);
      await until(() => !f.panel.loading && requests.filter(request => request.type === "loadMore" && request.direction === direction).length > count,
        `${direction} pagination from the real scroll container`);
    }
    await verifyTimeline();
  }
  for (const direction of ["older", "newer"]) assert.ok(requests.some(request => request.type === "loadMore" && request.direction === direction),
    `the production renderer must actually request ${direction} history`);
  await renderer.clickControl(`.row[data-hash="${f.target}"] .commit-hash`);
  await until(() => f.messages.some(message => message.type === "commitDetail" && message.detail.hash === f.target && !message.detail.loading),
    "complete selected PR commit history");
  const selected = f.messages.filter(message => message.type === "commitDetail" && message.detail.hash === f.target && !message.detail.loading).at(-1);
  assert.ok(selected?.type === "commitDetail");
  assert.equal(selected.detail.message.trim(), await git(f.root, "show", "-s", "--format=%B", f.target));
  assert.deepEqual(selected.detail.parents, (await git(f.root, "rev-list", "--parents", "-n1", f.target)).split(" ").slice(1));
  console.log(JSON.stringify({ check: "prTimelineNativeRenderer", action, nativeCount: oracle.length,
    loadedCount: f.panel.commits.length, rangeStartIndex: f.panel.rangeStartIndex,
    directions: [...new Set(requests.filter(request => request.type === "loadMore").map(request => request.direction))],
    selectedCommitVerified: true }));
  await renderer.waitForPendingFrame();
  await renderer.capture(`/private/tmp/gsc-pr-timeline-renderer-${action}`);
});

test("production PR commit details open an unloaded native commit without requiring a graph jump", {
  skip: process.env.GSC_VERIFY_PR_RENDERER !== "1",
}, async t => {
  const renderer = await GraphLiveRenderer.create();
  t.after(() => renderer.dispose());
  const f = await timelineFixture(t, message => renderer.post(message), false);
  t.mock.method(PullRequestService.prototype, "getDetail", async () => ({ number: 42, files: [], fileCount: 0,
    commentCount: 0, fileCommentCount: 0, filesTruncated: false, reviewThreadsTruncated: false }));
  const requests: Array<{ type: string }> = [];
  renderer.onMessage(async message => { requests.push(message); await f.receiveMessage(message); });
  await renderer.mount(f.surface.webview.html);
  await until(() => f.messages.some(message => message.type === "pullRequestOverview") && !f.panel.loading, "initial graph and metadata");
  await renderer.clickControl("#graph-pr-list"); await renderer.clickControl(".pr-card-heading");
  const before = f.panel.commits.map((commit: { hash: string }) => commit.hash);
  assert.ok(!before.includes(f.target));
  assert.match((await renderer.readPullRequestDetail()).text, /removed-pr 339/);
  await renderer.clickControl(`[data-open-pr-commit="${f.target}"]`);
  await until(() => f.messages.some(message => message.type === "commitDetail" && message.detail.hash === f.target && !message.detail.loading),
    "full native details from the PR's direct content control");
  await renderer.waitForPendingFrame();
  assert.equal(await renderer.countElements(".pr-detail-shell"), 0);
  assert.match((await renderer.readPullRequestDetail()).text, /removed-pr 339/);
  assert.deepEqual(f.panel.commits.map((commit: { hash: string }) => commit.hash), before);
  assert.equal(requests.some(message => message.type === "ensureCommitVisible"), false);
  const selected = f.messages.filter(message => message.type === "commitDetail" && !message.detail.loading).at(-1);
  assert.ok(selected?.type === "commitDetail");
  assert.equal(selected.detail.message.trim(), await git(f.root, "show", "-s", "--format=%B", f.target));
});
