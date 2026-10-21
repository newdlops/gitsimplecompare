import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PullRequestService } from "../src/git/pullRequestService";
import { pullRequestInfoFromGraphQl } from "../src/git/pullRequestInfo";
import { GraphPullRequestPager } from "../src/webview/graphPullRequests";

/** Native 객체 조회가 필요 없는 PR 메타데이터를 만들어 목록과 검색의 수명만 검증한다. */
function pr(number: number, head = "a".repeat(40)) {
  return pullRequestInfoFromGraphQl({ number, title: `PR ${number}`, state: "OPEN", headRefOid: head });
}

/** 기본 목록만 교체하는 실제 pager 경로를 호출하며 테스트별 overview 실행기를 격리한다. */
function mockOverview(t: TestContext, read = () => [] as ReturnType<typeof pr>[]) {
  t.mock.method(PullRequestService.prototype, "getOverview", async () => ({ available: true, hasMore: false,
    repository: "owner/repo", defaultBranch: "main", pullRequests: read() }));
}

test("Graph jump retains searched PRs outside the refreshed list and prefers fresh overview metadata", async t => {
  let overview: ReturnType<typeof pr>[] = [];
  mockOverview(t, () => overview);
  const searched = pr(42), pager = new GraphPullRequestPager(async (_root, query) => ({ query,
    pullRequests: [searched], hasMore: false, totalCount: 1 }));
  await pager.search("/repo", "search", "needle", undefined, () => {});
  await pager.refresh("/repo", [], "manual", () => {});
  assert.deepEqual(pager.items, []);
  assert.equal(pager.findGraphTarget(42), searched);
  overview = [pr(42, "b".repeat(40))];
  await pager.refresh("/repo", [], "manual", () => {});
  assert.equal(pager.findGraphTarget(42)?.headHash, "b".repeat(40));
  assert.equal(pager.findGraphTarget(undefined), undefined);
  assert.equal(pager.findGraphTarget(999), undefined);
});

test("Graph jump keeps only current search pages after the overview is replaced", async t => {
  mockOverview(t);
  const pager = new GraphPullRequestPager(async (_root, query, cursor) => ({ query,
    pullRequests: [pr(query === "first" ? cursor ? 43 : 42 : 44)], hasMore: false, totalCount: 1 }));
  await pager.search("/repo", "first", "first", undefined, () => {});
  await pager.search("/repo", "more", "first", "page-2", () => {});
  await pager.refresh("/repo", [], "manual", () => {});
  assert.equal(pager.findGraphTarget(42)?.number, 42);
  assert.equal(pager.findGraphTarget(43)?.number, 43);
  await pager.search("/repo", "second", "second", undefined, () => {});
  await pager.refresh("/repo", [], "manual", () => {});
  assert.equal(pager.findGraphTarget(42), undefined);
  assert.equal(pager.findGraphTarget(43), undefined);
  assert.equal(pager.findGraphTarget(44)?.number, 44);
});

test("repository changes discard both retained navigation metadata and a late search result", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pager = new GraphPullRequestPager(async (_root, query) => {
    if (query === "late") await gate;
    return { query, pullRequests: [pr(query === "late" ? 43 : 42)], hasMore: false, totalCount: 1 };
  });
  await pager.search("/old", "first", "first", undefined, () => {});
  const pending = pager.search("/old", "late", "late", undefined, () => {});
  pager.resetRepository(); release(); await pending;
  assert.equal(pager.findGraphTarget(42), undefined);
  assert.equal(pager.findGraphTarget(43), undefined);
  assert.deepEqual(pager.items, []);
});
