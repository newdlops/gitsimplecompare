import assert from "node:assert/strict";
import test from "node:test";
import { fetchPullRequestListPage, type PullRequestListPage } from "../src/git/pullRequestListService";
import { pullRequestInfoFromGraphQl, type GhPullRequestNode } from "../src/git/pullRequestInfo";
import { PullRequestService, type PullRequestOverview } from "../src/git/pullRequestService";
import { GraphPullRequestPager } from "../src/webview/graphPullRequests";
import { handlePullRequestAction } from "../src/webview/graphPullRequestActions";
import { __resetWindowMessages, __warningMessages } from "./helpers/vscodeMock";
import { fetchPreviewBootstrap, fetchPreviewCommitSummaries } from "../src/git/pullRequestPreviewRemote";

/** 완료 시점을 테스트가 소유해 첫 표시와 후속 조회 사이의 순서를 검증한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
/** 큰 PR의 첫 connection을 만들어 후속 페이지와 안전한 재사용을 검증한다. */
function node(): GhPullRequestNode {
  return { number: 42, title: "Large PR", headRefOid: "head", baseRefOid: "base", baseRefName: "main",
    commits: { nodes: [{ commit: { oid: "first" } }], pageInfo: { hasNextPage: true, endCursor: "next" } } };
}
/** 실제 목록 API의 repository envelope로 테스트 PR을 감싼다. */
function firstPage(pr = node()): string {
  return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", defaultBranchRef: { name: "main" },
    pullRequests: { nodes: [pr], pageInfo: { hasNextPage: false } } } } });
}
/** head를 검증할 수 있는 마지막 commit 페이지를 만든다. */
function lastPage(): string {
  return JSON.stringify({ data: { repository: { pullRequest: { headRefOid: "head", baseRefOid: "base",
    commits: { nodes: [{ commit: { oid: "middle" } }, { commit: { oid: "head" } }], pageInfo: { hasNextPage: false } } } } } });
}

test("PR list is visible before slow commit/comment pages and published snapshots cannot mutate", async () => {
  const remaining = deferred<string>();
  const initial = deferred<PullRequestListPage>();
  const pr = node(); pr.comments = { totalCount: 2 };
  pr.reviewThreads = { nodes: [{ comments: { totalCount: 3 } }], pageInfo: { hasNextPage: true, endCursor: "review" } };
  const result = fetchPullRequestListPage("/repo", undefined, undefined, async (_args, _root, options) => {
    if (options.operation === "graph-pr-list-page") return firstPage(pr);
    await remaining.promise;
    return options.operation === "graph-pr-commit-page" ? lastPage() : JSON.stringify({ data: { repository: { pullRequest: {
      reviewThreads: { nodes: [{ comments: { totalCount: 7 } }], pageInfo: { hasNextPage: false } },
    } } } });
  }, { onProgress: page => initial.resolve(page) });
  const shown = await initial.promise;
  assert.equal(shown.pullRequests[0].title, "Large PR");
  assert.equal(shown.pullRequests[0].commitHashesComplete, false);
  assert.equal(shown.pullRequests[0].commentCountComplete, false);
  remaining.resolve("");
  const completed = await result;
  assert.deepEqual(completed.pullRequests[0].commitHashes, ["first", "middle", "head"]);
  assert.equal(completed.pullRequests[0].commentCount, 12);
  assert.equal(completed.pullRequests[0].commentCountComplete, true);
  assert.deepEqual(shown.pullRequests[0].commitHashes, ["first", "head"]);
  assert.equal(shown.pullRequests[0].commentCount, 5);
});

for (const boundary of ["same", "repository", "head", "base", "baseName", "incomplete"]) {
  test(`commit pagination reuses only a complete identical snapshot: ${boundary}`, async () => {
    const known = { ...pullRequestInfoFromGraphQl(node()), commitHashes: ["first", "middle", "head"], commitHashesComplete: true };
    const previous = { repository: "owner/repo", pullRequests: [known] };
    if (boundary === "repository") previous.repository = "other/repo";
    if (boundary === "head") known.headHash = "old-head";
    if (boundary === "base") known.baseHash = "old-base";
    if (boundary === "baseName") known.baseRefName = "different";
    if (boundary === "incomplete") known.commitHashesComplete = false;
    let calls = 0;
    const result = await fetchPullRequestListPage("/repo", undefined, undefined, async () => ++calls === 1 ? firstPage() : lastPage(), { previous });
    assert.equal(calls, boundary === "same" ? 1 : 2);
    assert.deepEqual(result.pullRequests[0].commitHashes, ["first", "middle", "head"]);
    assert.equal(result.pullRequests[0].commitHashesComplete, true);
  });
}

test("pager publishes initial rows, preserves them after pagination errors and rejects stale progress", async t => {
  const pending = deferred<PullRequestOverview>();
  let progress!: (overview: PullRequestOverview) => void;
  t.mock.method(PullRequestService.prototype, "getOverview", async (_branches: unknown, _cursor: unknown, _signal: unknown, publish: typeof progress) => {
    progress = publish; return pending.promise;
  });
  const pager = new GraphPullRequestPager();
  const messages: any[] = [];
  const first = pager.refresh("/repo", [], "initial", message => messages.push(message));
  const overview = { available: true, repository: "owner/repo", hasMore: false, detailsLoading: true,
    pullRequests: [pullRequestInfoFromGraphQl(node())] };
  progress(overview);
  assert.equal(pager.items.length, 1); assert.equal(messages[0].overview.detailsLoading, true);
  pending.resolve({ available: false, error: "network failed", hasMore: false, pullRequests: [] });
  await first;
  assert.equal(messages[1].overview.detailsLoading, undefined);
  assert.equal(messages[1].overview.error, "network failed");
  assert.equal(pager.items[0].commitHashesComplete, false);
  pager.resetRepository();
  progress(overview);
  assert.equal(messages.length, 2); assert.equal(pager.items.length, 0);
});

test("cancelled first-page callback cannot overwrite the next repository", async t => {
  const pending = deferred<PullRequestOverview>();
  let late!: (overview: PullRequestOverview) => void;
  let calls = 0;
  t.mock.method(PullRequestService.prototype, "getOverview", async (_branches: unknown, _cursor: unknown, _signal: unknown, publish: typeof late) => {
    if (++calls === 1) { late = publish; return pending.promise; }
    return { available: true, repository: "new/repo", hasMore: false, pullRequests: [] };
  });
  const pager = new GraphPullRequestPager(); const messages: any[] = [];
  const old = pager.refresh("/old", [], "old", message => messages.push(message));
  pager.resetRepository();
  await pager.refresh("/new", [], "new", message => messages.push(message));
  const stale = { available: true, repository: "old/repo", hasMore: false, pullRequests: [pullRequestInfoFromGraphQl(node())] };
  late(stale); pending.resolve(stale); await old;
  assert.equal(pager.repositoryName, "new/repo"); assert.equal(pager.items.length, 0); assert.equal(messages.length, 1);
});

test("a forged UI action with incomplete commits is rejected before confirmation or Git work", async () => {
  __resetWindowMessages();
  await handlePullRequestAction({ logService: {} as any, pullRequests: () => [pullRequestInfoFromGraphQl(node())],
    refreshGraph: async () => { assert.fail("Git action should not run"); } }, 42, "squash");
  assert.match(__warningMessages.at(-1)!, /still loading/);
});

test("an unchanged pager refresh acknowledges completion without repeating the PR payload", async t => {
  t.mock.method(PullRequestService.prototype, "getOverview", async () => ({ available: true, repository: "owner/repo", hasMore: false, pullRequests: [] }));
  const pager = new GraphPullRequestPager(); const messages: any[] = [];
  await pager.refresh("/repo", [], "first", message => messages.push(message));
  await pager.refresh("/repo", [], "manual", message => messages.push(message));
  assert.deepEqual(messages.map(message => message.type), ["pullRequestOverview", "pullRequestOverviewRetained"]);
});

test("preview bootstrap rejects a changed head before fetching files", async () => {
  await assert.rejects(fetchPreviewBootstrap("/repo", pullRequestInfoFromGraphQl(node()), async () => JSON.stringify({
    data: { repository: { nameWithOwner: "owner/repo", pullRequest: { headRefOid: "changed" } } },
  })), /head changed/);
});

test("a changed base during pagination cannot become a reusable commit snapshot", async () => {
  let calls = 0;
  await assert.rejects(fetchPullRequestListPage("/repo", undefined, undefined, async () =>
    ++calls === 1 ? firstPage() : lastPage().replace('"baseRefOid":"base"', '"baseRefOid":"changed"')), /base changed/);
});

test("repository search comments stay complete after their extra thread pages have been counted", () => {
  const pr = node(); pr.reviewThreads = { pageInfo: { hasNextPage: true, endCursor: "remaining" } };
  assert.equal(pullRequestInfoFromGraphQl(pr).commentCountComplete, false);
  assert.equal(pullRequestInfoFromGraphQl(pr, 0).commentCountComplete, true);
  assert.equal(pullRequestInfoFromGraphQl(pr, 5).commentCount, 5);
});

test("preview metadata and first 100 commits share a request; only the remaining page is fetched", async () => {
  const hashes = Array.from({ length: 100 }, (_, i) => `commit-${i}`);
  let calls = 0;
  const runner = async () => {
    calls++;
    return calls === 1 ? JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", pullRequest: {
      headRefOid: "head", title: "Existing title", body: "Existing body", commits: {
        nodes: hashes.map(oid => ({ commit: { oid, messageHeadline: oid } })), pageInfo: { hasNextPage: true, endCursor: "rest" },
      },
    } } } }) : lastPage();
  };
  const pr = pullRequestInfoFromGraphQl(node());
  const initial = await fetchPreviewBootstrap("/repo", pr, runner);
  assert.equal(calls, 1); assert.equal(initial.body, "Existing body");
  const commits = await fetchPreviewCommitSummaries("/repo", pr, runner, initial.firstPage);
  assert.equal(calls, 2); assert.deepEqual(commits.map(commit => commit.hash), [...hashes, "middle", "head"]);
});
