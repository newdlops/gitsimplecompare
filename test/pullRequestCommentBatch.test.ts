import assert from "node:assert/strict";
import test from "node:test";
import { fetchRemainingReviewThreadCommentCounts } from "../src/git/pullRequestCommentCounts";
import { fetchPullRequestListPage, type PullRequestListPage } from "../src/git/pullRequestListService";
import type { GhPullRequestNode } from "../src/git/pullRequestInfo";

/** 각 PR의 첫 댓글 cursor와 독립 합산 값을 가진 목록 응답을 만든다. */
function node(number: number): GhPullRequestNode {
  return { number, headRefOid: `head-${number}`, comments: { totalCount: 2 },
    reviewThreads: { nodes: [{ comments: { totalCount: 3 } }], pageInfo: { hasNextPage: true, endCursor: `start-${number}` } } };
}
/** GraphQL connection의 댓글 수와 다음 cursor를 직렬화 가능한 형태로 만든다. */
function threads(count: number, endCursor?: string) {
  return { nodes: [{ comments: { totalCount: count } }], pageInfo: { hasNextPage: !!endCursor, endCursor } };
}
/** 테스트가 느린 네트워크 응답 시점을 직접 제어한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

test("nine PR comment tails use three requests and a refresh always counts new comments", async () => {
  let listReads = 0, tailReads = 0, added = 4;
  const runner = async (args: readonly string[], _root: string, options: { operation: string }) => {
    if (options.operation === "graph-pr-list-page") {
      listReads++;
      return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", pullRequests: {
        nodes: Array.from({ length: 9 }, (_, index) => node(index + 1)),
      } } } });
    }
    tailReads++;
    if (options.operation === "graph-pr-review-thread-count-page") return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: threads(added) } } } });
    const numbers = args.filter(arg => /^number\d+=/.test(arg));
    assert.ok(numbers.length <= 4);
    return JSON.stringify({ data: { repository: Object.fromEntries(numbers.map((_, index) => [`pr${index}`, { reviewThreads: threads(added) }])) } });
  };
  const first = await fetchPullRequestListPage("/repo", undefined, undefined, runner);
  assert.equal(listReads, 1); assert.equal(tailReads, 3);
  assert.deepEqual(first.pullRequests.map(pr => pr.commentCount), Array(9).fill(9));
  added = 12;
  const next = await fetchPullRequestListPage("/repo", undefined, undefined, runner, {
    previous: { repository: first.repository, pullRequests: first.pullRequests },
  });
  assert.deepEqual(next.pullRequests.map(pr => pr.commentCount), Array(9).fill(17));
  assert.ok(next.pullRequests.every(pr => pr.commentCountComplete));
});

test("batch pagination advances each PR independently and excludes completed connections", async () => {
  const pages = new Map<number, number>();
  const requested: number[][] = [];
  const counts = await fetchRemainingReviewThreadCommentCounts("/repo", "owner", "repo", [1, 2, 3, 4].map(node), undefined, async args => {
    const numbers = args.filter(arg => /^number\d+=/.test(arg)).map(arg => Number(arg.split("=")[1]));
    requested.push(numbers);
    const repository = Object.fromEntries(numbers.map((number, index) => {
      const page = (pages.get(number) || 0) + 1; pages.set(number, page);
      const last = number === 1 ? 3 : number === 3 ? 2 : 1;
      return [`pr${index}`, { reviewThreads: threads(page, page < last ? `next-${number}-${page}` : undefined) }];
    }));
    return JSON.stringify({ data: { repository } });
  });
  assert.deepEqual(requested, [[1, 2, 3, 4], [1, 3], [1]]);
  assert.deepEqual([...counts], [[1, 6], [2, 1], [3, 3], [4, 1]]);
});

for (const failure of ["missing", "graphql", "repeated", "cancelled"]) {
  test(`batch comment totals never succeed partially after ${failure}`, async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(fetchRemainingReviewThreadCommentCounts("/repo", "owner", "repo", [node(1), node(2)], controller.signal, async () => {
      calls++;
      if (failure === "cancelled") controller.abort();
      return JSON.stringify({ errors: failure === "graphql" ? [{ message: "partial failure" }] : undefined,
        data: { repository: { pr0: { reviewThreads: threads(1, failure === "repeated" ? "start-1" : undefined) },
          pr1: failure === "missing" ? null : { reviewThreads: threads(2) } } } });
    }), failure === "cancelled" ? { name: "AbortError" } : /not available|did not advance/);
    assert.equal(calls, 1);
  });
}

test("finished commit pagination reaches the UI before slow comments without mutating previous snapshots", { timeout: 5000 }, async () => {
  const comments = deferred<string>(), ready = deferred<PullRequestListPage>();
  const snapshots: PullRequestListPage[] = [];
  const pr = node(1);
  pr.commits = { nodes: [{ commit: { oid: "first" } }], pageInfo: { hasNextPage: true, endCursor: "commits" } };
  const loading = fetchPullRequestListPage("/repo", undefined, undefined, async (_args, _root, options) => {
    if (options.operation === "graph-pr-list-page") return JSON.stringify({ data: { repository: {
      nameWithOwner: "owner/repo", pullRequests: { nodes: [pr] },
    } } });
    if (options.operation === "graph-pr-commit-page") return JSON.stringify({ data: { repository: { pullRequest: {
      headRefOid: "head-1", commits: { nodes: [{ commit: { oid: "middle" } }, { commit: { oid: "head-1" } }], pageInfo: { hasNextPage: false } },
    } } } });
    return comments.promise;
  }, { onProgress: page => { snapshots.push(page); if (page.pullRequests[0].commitHashesComplete) ready.resolve(page); } });
  try {
    const intermediate = await ready.promise;
    assert.equal(intermediate.pullRequests[0].commentCountComplete, false);
    assert.equal(snapshots[0].pullRequests[0].commitHashesComplete, false);
    assert.deepEqual(intermediate.pullRequests[0].commitHashes, ["first", "middle", "head-1"]);
  } finally { comments.resolve(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: threads(7) } } } })); }
  const final = await loading;
  assert.equal(final.pullRequests[0].commentCount, 12);
  assert.equal(final.pullRequests[0].commentCountComplete, true);
  assert.equal(snapshots[1].pullRequests[0].commentCountComplete, false);
});

test("a failed progress renderer cannot crash background pagination or hide final data", async () => {
  const page = await fetchPullRequestListPage("/repo", undefined, undefined, async (_args, _root, options) => {
    if (options.operation === "graph-pr-list-page") return JSON.stringify({ data: { repository: {
      nameWithOwner: "owner/repo", pullRequests: { nodes: [node(1)] },
    } } });
    return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: threads(7) } } } });
  }, { onProgress: () => { throw new Error("renderer disposed"); } });
  assert.equal(page.pullRequests[0].commentCount, 12);
  assert.equal(page.pullRequests[0].commentCountComplete, true);
});

/** 같은 GraphQL 묶음의 작은 PR은 다른 PR의 후속 페이지를 기다리지 않고 완료 표시한다. */
test("completed PR comments publish before another PR in the same batch finishes", { timeout: 5000 }, async () => {
  const slow = deferred<string>(), ready = deferred<PullRequestListPage>();
  let rounds = 0;
  const loading = fetchPullRequestListPage("/repo", undefined, undefined, async (_args, _root, options) => {
    if (options.operation === "graph-pr-list-page") return JSON.stringify({ data: { repository: {
      nameWithOwner: "owner/repo", pullRequests: { nodes: [node(1), node(2)] },
    } } });
    if (++rounds === 1) return JSON.stringify({ data: { repository: {
      pr0: { reviewThreads: threads(7) }, pr1: { reviewThreads: threads(4, "slow-next") },
    } } });
    return slow.promise;
  }, { onProgress: page => { if (page.pullRequests[0].commentCountComplete) ready.resolve(page); } });
  try {
    const page = await ready.promise;
    assert.equal(page.pullRequests[0].commentCount, 12);
    assert.equal(page.pullRequests[1].commentCountComplete, false);
  } finally { slow.resolve(JSON.stringify({ data: { repository: { pr0: { reviewThreads: threads(8) } } } })); }
  const page = await loading;
  assert.equal(page.pullRequests[0].commentCount, 12);
  assert.equal(page.pullRequests[1].commentCount, 17);
});

/** 큰 PR 네 개가 있어도 다섯 번째 PR의 첫 후속 페이지가 두 번째 페이지보다 먼저 시작된다. */
test("PR pagination shares four request slots fairly between pages", async () => {
  const requested: string[] = [];
  const prs = Array.from({ length: 6 }, (_, index) => ({ ...node(index + 1), reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    commits: { nodes: [{ commit: { oid: `first-${index + 1}` } }], pageInfo: { hasNextPage: true, endCursor: "page1" } } }));
  let active = 0, maximum = 0;
  await fetchPullRequestListPage("/repo", undefined, undefined, async (args, _root, options) => {
    if (options.operation === "graph-pr-list-page") return JSON.stringify({ data: { repository: {
      nameWithOwner: "owner/repo", pullRequests: { nodes: prs },
    } } });
    maximum = Math.max(maximum, ++active);
    const number = Number(args.find(arg => arg.startsWith("number="))!.split("=")[1]);
    const cursor = args.find(arg => arg.startsWith("cursor="))!.split("=")[1];
    requested.push(`${number}:${cursor}`);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return JSON.stringify({ data: { repository: { pullRequest: { headRefOid: `head-${number}`, commits: {
      nodes: [{ commit: { oid: `${number}-${cursor}` } }], pageInfo: { hasNextPage: cursor === "page1", endCursor: "page2" },
    } } } } });
  });
  assert.equal(maximum, 4);
  assert.deepEqual(requested.slice(0, 6), [1, 2, 3, 4, 5, 6].map(number => `${number}:page1`));
});
