import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { GitLogService } from "../src/git/gitLogService";
import { PullRequestService } from "../src/git/pullRequestService";
import { PullRequestStackService } from "../src/git/pullRequestStackService";
import { pullRequestInfoFromGraphQl } from "../src/git/pullRequestInfo";
import type { PullRequestDetailInfo } from "../src/git/pullRequestDetail";
import { createOperationGraphPanel } from "./helpers/graphOperationPanel";
import { safetyFixture } from "./helpers/gitSafetyFixture";
import { GraphLiveRenderer } from "./helpers/graphLiveRenderer";
import type { FromWebviewMessage } from "../src/webview/graphProtocol";

/** 실제 host와 browser가 관찰한 조건만 짧은 상한 안에서 기다린다. */
async function until(check: () => boolean | Promise<boolean>, description: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out: ${description}`);
}

/** 백 개씩 나뉜 큰 파일 목록을 만들어 첫 페이지가 댓글·후속 파일보다 먼저 표시되는지 검사한다. */
function detail(count: number, loading: boolean): PullRequestDetailInfo {
  return { number: 42, fileCount: 155, commentCount: 0, fileCommentCount: 0,
    filesTruncated: false, reviewThreadsTruncated: false, filesLoading: loading, reviewThreadsLoading: true,
    files: Array.from({ length: count }, (_, index) => ({ path: `src/nested/file-${String(index).padStart(3, "0")}.ts`,
      status: "M", additions: 2, deletions: 1, commentCount: 0 })) };
}

test("production PR details survive preceding commit cancellation ACKs and display the first page before completion", {
  skip: process.env.GSC_VERIFY_PR_RENDERER !== "1",
}, async t => {
  const fixture = await safetyFixture(t, "pr-detail-transport");
  const renderer = await GraphLiveRenderer.create();
  const pr = pullRequestInfoFromGraphQl({ number: 42, title: "Changed files transport", state: "OPEN",
    headRefOid: fixture.head, baseRefOid: fixture.head, headRefName: "feature", baseRefName: "main" });
  t.mock.method(PullRequestService.prototype, "getOverview", async () => ({ available: true,
    repository: "owner/repo", defaultBranch: "main", hasMore: false, pullRequests: [pr] }));
  t.mock.method(PullRequestStackService.prototype, "getGraphSnapshot", async () => ({
    repository: "owner/repo", defaultBranch: "main", stacks: [], layers: [] }));
  let publish: ((value: PullRequestDetailInfo) => void) | undefined, finish: (() => void) | undefined, reads = 0;
  t.mock.method(PullRequestService.prototype, "getDetail", async (_number, signal, onProgress) => {
    reads++; publish = onProgress;
    onProgress?.(detail(100, true));
    await new Promise<void>((resolve, reject) => {
      finish = resolve;
      signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    });
    return { ...detail(155, false), reviewThreadsLoading: false };
  });
  const host = createOperationGraphPanel(t, new GitLogService(fixture.root), message => renderer.post(message));
  t.after(async () => { finish?.(); host.panel.dispose(); await renderer.dispose(); });
  const requests: FromWebviewMessage[] = [];
  renderer.onMessage(async message => {
    requests.push(message);
    if (message.type !== "openPullRequestFileDiff") await host.receiveMessage(message);
  });
  await renderer.mount(host.surface.webview.html);
  await until(() => host.messages.some(message => message.type === "pullRequestOverview"), "initial PR overview");
  await renderer.clickControl("#graph-pr-list");
  await renderer.clickControl(".pr-card-heading");
  await until(() => reads === 1, "one actual host detail request");
  assert.ok(host.messages.some(message => message.type === "graphDetailCancelled" && message.number === undefined),
    "the production router must deliver its unnumbered commit cancellation ACKs");
  assert.ok(host.messages.some(message => message.type === "pullRequestDetail" && message.partial));
  await until(async () => (await renderer.readPullRequestDetail()).paths.length === 100,
    "the posted first page must reach the actual drawer before remaining files or comments finish", 2000);
  await renderer.clickControl(".pr-file-row >> nth=0");
  assert.ok(requests.some(message => message.type === "openPullRequestFileDiff" && message.path === detail(100, true).files[0].path));
  publish?.(detail(155, false));
  await until(async () => (await renderer.readPullRequestDetail()).paths.length === 155, "all changed files before comments finish");
  finish?.();
  await until(() => host.messages.some(message => message.type === "pullRequestDetail" && !message.partial), "terminal detail response");
  await renderer.waitForPendingFrame();
  assert.deepEqual((await renderer.readPullRequestDetail()).paths, detail(155, false).files.map(file => file.path));
  assert.doesNotMatch((await renderer.readPullRequestDetail()).text, /Loading changed files|Loading file comments/);
  await renderer.capturePullRequestDetail("/private/tmp/gsc-pr-detail-transport");
  await renderer.clickControl("[data-pr-overview]");
  await renderer.clickControl(".pr-card-heading");
  assert.equal(reads, 1, "returning to a completed detail must reuse its current cache");
  assert.equal((await renderer.readPullRequestDetail()).paths.length, 155);
});

// 명시한 기존 저장소에서는 GitHub 읽기만 수행하고, Git/Graph 동작은 별도의 임시 저장소에 격리한다.
test("live GitHub changed files cross the production host/browser transport and match independent REST results", {
  skip: !process.env.GSC_VERIFY_PR_LIVE_ROOT,
}, async t => {
  const root = process.env.GSC_VERIFY_PR_LIVE_ROOT!;
  const number = Number(process.env.GSC_VERIFY_PR_LIVE_NUMBER);
  assert.ok(Number.isSafeInteger(number) && number > 0, "An explicit live PR number is required");
  const liveService = new PullRequestService(root), readDetail = PullRequestService.prototype.getDetail;
  const [pr, oracle] = await Promise.all([liveService.getPullRequestRefs(number), liveService.getChangedFiles(number)]);
  assert.ok(pr, "The selected live PR must exist");
  assert.equal(oracle.truncated, false, "The independent REST file oracle must be complete");
  assert.ok(oracle.files.length > 0, "Use a PR with changed files to verify actual rendering");
  const fixture = await safetyFixture(t, "pr-detail-live-transport");
  const renderer = await GraphLiveRenderer.create();
  t.mock.method(PullRequestService.prototype, "getOverview", async () => ({ available: true,
    repository: "live/verification", defaultBranch: pr.baseRefName, hasMore: false, pullRequests: [pr] }));
  t.mock.method(PullRequestStackService.prototype, "getGraphSnapshot", async () => ({
    repository: "live/verification", defaultBranch: pr.baseRefName, stacks: [], layers: [] }));
  let requestedAt = 0, firstPostedAt = 0, firstPaths: string[] = [], final: PullRequestDetailInfo | undefined, reads = 0;
  t.mock.method(PullRequestService.prototype, "getDetail", async (requestedNumber, signal, onProgress) => {
    assert.equal(requestedNumber, number); reads++; requestedAt = Date.now();
    final = await readDetail.call(liveService, number, signal, progress => {
      if (!firstPostedAt) { firstPostedAt = Date.now(); firstPaths = progress.files.map(file => file.path); }
      onProgress?.(progress);
    });
    return final;
  });
  const host = createOperationGraphPanel(t, new GitLogService(fixture.root), message => renderer.post(message));
  t.after(async () => { host.panel.dispose(); await renderer.dispose(); });
  renderer.onMessage(message => host.receiveMessage(message));
  await renderer.mount(host.surface.webview.html);
  await until(() => host.messages.some(message => message.type === "pullRequestOverview"), "live PR overview");
  await renderer.clickControl("#graph-pr-list");
  await renderer.clickControl(".pr-card-heading");
  await until(() => firstPostedAt > 0, "actual GitHub first file page", 35000);
  await until(async () => {
    const displayed = new Set((await renderer.readPullRequestDetail()).paths);
    return firstPaths.every(file => displayed.has(file)) && displayed.size >= firstPaths.length;
  }, "live first page rendered after its production host message", 1500);
  const firstRenderedAt = Date.now();
  assert.ok(firstRenderedAt - firstPostedAt < 1500, "The renderer must not wait for a later GitHub request");
  await until(() => host.messages.some(message => message.type === "pullRequestDetail" && !message.partial), "complete live detail", 35000);
  await renderer.waitForPendingFrame();
  const displayed = await renderer.readPullRequestDetail(), completedAt = Date.now();
  assert.ok(final); assert.equal(final.filesTruncated, false);
  assert.deepEqual([...displayed.paths].sort(), oracle.files.map(file => file.path).sort());
  assert.equal(final.fileCount, oracle.files.length);
  assert.doesNotMatch(displayed.text, /Loading changed files|Loading file comments/);
  assert.equal(reads, 1, "Background host ACKs must not make the PR retry its detail request");
  const after = await liveService.getPullRequestRefs(number);
  assert.equal(after?.headHash, pr.headHash); assert.equal(after?.baseHash, pr.baseHash);
  await renderer.capturePullRequestDetail(`/private/tmp/gsc-pr-detail-live-${number}`);
  const evidence = { check: "liveGitHubPrDetailTransport", firstPageFiles: firstPaths.length, totalFiles: displayed.paths.length,
    backendFirstPageMs: firstPostedAt - requestedAt, firstPageRenderMs: firstRenderedAt - firstPostedAt,
    allFilesRenderMs: completedAt - requestedAt, detailRequests: reads, exactRestFilePaths: true, headBaseUnchanged: true,
    viewports: [[390, 844], [768, 1024], [1440, 900]] };
  await writeFile(`/private/tmp/gsc-pr-detail-live-${number}.json`, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
});
