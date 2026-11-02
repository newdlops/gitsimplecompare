import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { GitLogService } from "../src/git/gitLogService";
import { PullRequestService } from "../src/git/pullRequestService";
import { GraphPanelMessageRouter, type GraphPanelMessageRouterDeps } from "../src/webview/graphPanelMessageRouter";
import { GraphPullRequestPager, openGraphPullRequest } from "../src/webview/graphPullRequests";
import { pullRequestInfoFromGraphQl } from "../src/git/pullRequestInfo";
import { GraphLiveRenderer } from "./helpers/graphLiveRenderer";
import { productionHtmlBuilder } from "./helpers/graphProductionHtml";
import type { Page } from "@playwright/test";
import * as vscodeMock from "./helpers/vscodeMock";

/** 웹뷰가 표시한 PR과 host 기본 목록의 교체를 실제 pager/router에서 재현한다. */
async function harness(t: TestContext) {
  let root = "/repo/current", reads = 0;
  const searched = pullRequestInfoFromGraphQl({ number: 42, title: "Searched PR", state: "OPEN",
    url: "https://github.com/owner/repo/pull/42", headRefName: "topic", baseRefName: "main", headRefOid: "a".repeat(40) });
  const pager = new GraphPullRequestPager(async (_root, query) => ({ query, pullRequests: [searched], hasMore: false, totalCount: 1 }));
  const router = new GraphPanelMessageRouter({ logService: () => ({ repoRoot: root } as GitLogService),
    localBranches: () => [], post: () => {}, withBusy: (_key, action) => action(), reloadGraph: async () => true,
  } as GraphPanelMessageRouterDeps);
  (router as any).pullRequestPager = pager;
  t.mock.method(PullRequestService.prototype, "getOverview", async () => ({ available: true, repository: "owner/repo", hasMore: false, pullRequests: [] }));
  t.mock.method(PullRequestService.prototype, "getPullRequestRefs", async () => { reads++; return undefined; });
  t.after(() => { router.cancelPullRequestLoading("dispose"); vscodeMock.__resetWindowMessages(); });
  vscodeMock.__resetWindowMessages();
  await pager.search(root, "search", "42", undefined, () => {});
  await pager.refresh(root, [], "manual", () => {});
  assert.deepEqual(pager.items, []);
  return { router, pager, searched, reads: () => reads, changeRepository: () => { root = "/repo/other"; router.cancelPullRequestLoading("repositoryChanged"); } };
}

test("the GitHub link opens a searched PR still visible after the overview refresh removes it", async t => {
  const h = await harness(t);
  await h.router.handle({ type: "openPullRequest", number: 42 });
  assert.equal(vscodeMock.__externalUris.length, 1);
  assert.equal(String(vscodeMock.__externalUris[0]), h.searched.url);
  assert.deepEqual(vscodeMock.__warningMessages, []); assert.equal(h.reads(), 0);
});

test("the GitHub link prefers the current overview over retained search metadata", async t => {
  const h = await harness(t), fresh = { ...h.searched, url: "https://github.example.com/current/repo/pull/42" };
  t.mock.method(PullRequestService.prototype, "getOverview", async () => ({ available: true, repository: "current/repo", hasMore: false, pullRequests: [fresh] }));
  await h.pager.refresh("/repo/current", [], "manual", () => {});
  await h.router.handle({ type: "openPullRequest", number: 42 });
  assert.equal(String(vscodeMock.__externalUris[0]), fresh.url); assert.equal(h.reads(), 0);
});

test("a PR outside both loaded lists opens after only its own metadata is fetched", async t => {
  const h = await harness(t), calls: unknown[][] = [];
  t.mock.method(PullRequestService.prototype, "getPullRequestRefs", async function(this: PullRequestService, number: number) {
    calls.push([this.repoRoot, number]); return { number, url: "https://github.com/owner/repo/pull/99" } as any;
  });
  await h.router.handle({ type: "openPullRequest", number: 99 });
  assert.deepEqual(calls, [["/repo/current", 99]]);
  assert.equal(String(vscodeMock.__externalUris[0]), "https://github.com/owner/repo/pull/99");
  assert.deepEqual(vscodeMock.__warningMessages, []);
});

test("a late link lookup cannot open a previous repository's PR after repository replacement", async t => {
  const h = await harness(t); let release!: (value: any) => void, started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(PullRequestService.prototype, "getPullRequestRefs", async () => { started(); return new Promise(resolve => { release = resolve; }); });
  const pending = h.router.handle({ type: "openPullRequest", number: 99 });
  await Promise.race([begun, pending]); assert.equal(typeof release, "function", "the missing PR must reach its single metadata lookup");
  h.changeRepository(); release({ number: 99, url: "https://github.com/owner/repo/pull/99" }); await pending;
  assert.equal(vscodeMock.__externalUris.length, 0); assert.deepEqual(vscodeMock.__warningMessages, []);
});

test("repository replacement discards retained search links before resolving the same number", async t => {
  const h = await harness(t), calls: string[] = []; h.changeRepository();
  t.mock.method(PullRequestService.prototype, "getPullRequestRefs", async function(this: PullRequestService) {
    calls.push(this.repoRoot); return { number: 42, url: "https://github.com/other/repo/pull/42" } as any;
  });
  await h.router.handle({ type: "openPullRequest", number: 42 });
  assert.deepEqual(calls, ["/repo/other"]); assert.equal(String(vscodeMock.__externalUris[0]), "https://github.com/other/repo/pull/42");
});

test("invalid PR link numbers never query GitHub or open a browser", async t => {
  const h = await harness(t);
  for (const number of [0, -1, 1.5, NaN, Infinity]) await h.router.handle({ type: "openPullRequest", number });
  assert.equal(h.reads(), 0); assert.equal(vscodeMock.__externalUris.length, 0);
});

test("a missing PR remains a warning and a metadata lookup failure remains an error", async t => {
  await harness(t);
  await openGraphPullRequest("/repo/current", [], 99);
  assert.equal(vscodeMock.__externalUris.length, 0); assert.deepEqual(vscodeMock.__warningMessages, ["Pull request #99 is not loaded."]);
  const failure = new Error("GitHub authorization failed");
  t.mock.method(PullRequestService.prototype, "getPullRequestRefs", async () => { throw failure; });
  await assert.rejects(openGraphPullRequest("/repo/current", [], 99), error => error === failure);
  assert.equal(vscodeMock.__externalUris.length, 0);
});

test("clicking the rendered GitHub button after search and overview refresh reaches the browser", {
  skip: process.env.GSC_VERIFY_PR_RENDERER !== "1",
}, async t => {
  const h = await harness(t), renderer = await GraphLiveRenderer.create();
  t.after(() => renderer.dispose());
  let searched!: () => void, opened!: () => void;
  const searchDone = new Promise<void>(resolve => { searched = resolve; }), openDone = new Promise<void>(resolve => { opened = resolve; });
  renderer.onMessage(async message => {
    if (message.type === "searchPullRequests") {
      await h.pager.search("/repo/current", message.requestId, message.query, message.cursor, value => renderer.post(value));
      await h.pager.refresh("/repo/current", [], "manual", value => renderer.post(value)); searched();
    } else if (message.type === "openPullRequest") { await h.router.handle(message); opened(); }
  });
  const build = await productionHtmlBuilder();
  await renderer.mount(build({ webview: { cspSource: "https://gsc.fixture", asWebviewUri: (uri: unknown) => uri } }, { fsPath: process.cwd() }));
  renderer.post({ type: "pullRequestOverview", overview: { available: true, repository: "owner/repo", hasMore: false, pullRequests: [] } });
  await renderer.clickControl("#graph-pr-list");
  const page = (renderer as unknown as { page: Page }).page;
  await page.locator("[data-pr-search-input]").fill("42"); await searchDone;
  await renderer.clickControl('[data-open-pr="42"]'); await openDone;
  assert.deepEqual(h.pager.items, []); assert.equal(h.reads(), 0);
  assert.equal(String(vscodeMock.__externalUris[0]), h.searched.url); assert.deepEqual(vscodeMock.__warningMessages, []);
});
