import assert from "node:assert/strict";
import test from "node:test";
import type { GhExecute } from "../src/git/ghRunner";
import type { GhPullRequestNode } from "../src/git/pullRequestInfo";
import { fetchPullRequestListPage } from "../src/git/pullRequestListService";
import { fetchRemainingReviewThreadCommentCounts } from "../src/git/pullRequestCommentCounts";

/** 첫 PR 페이지의 저장소·기본 branch·cursor를 실제 GraphQL 응답 형태로 만든다. */
function firstPage(nodes: GhPullRequestNode[], hasMore = false): string {
  return JSON.stringify({ data: { repository: {
    nameWithOwner: "owner/repository", defaultBranchRef: { name: "main" },
    pullRequests: { nodes, pageInfo: { hasNextPage: hasMore, endCursor: hasMore ? "next-pr-page" : null } },
  } } });
}

/** commit hash와 후속 cursor를 가진 GraphQL connection을 만들어 페이지 순서를 검증한다. */
function commitPage(hashes: string[], nextCursor?: string): string {
  return JSON.stringify({ data: { repository: { pullRequest: { commits: {
    nodes: hashes.map((oid) => ({ commit: { oid } })),
    pageInfo: { hasNextPage: !!nextCursor, endCursor: nextCursor },
  } } } } });
}

/** review thread별 댓글 수와 후속 cursor를 가진 응답을 만든다. */
function reviewPage(counts: number[], nextCursor?: string): string {
  return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
    nodes: counts.map((totalCount) => ({ comments: { totalCount } })),
    pageInfo: { hasNextPage: !!nextCursor, endCursor: nextCursor },
  } } } } });
}

/** 완료 순서를 테스트가 정하는 promise를 반환해 벽시계 대기 없이 동시 실행을 검사한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

/** 현재 microtask chain이 끝날 때까지만 진행해 다음 worker의 시작을 관측한다. */
function settle(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }

/** 후속 페이지 한 장이 필요한 PR을 만들어 여러 PR의 독립 요청을 재현한다. */
function pagedPullRequest(number: number): GhPullRequestNode {
  return { number, headRefOid: `head-${number}`, commits: {
    nodes: [{ commit: { oid: `start-${number}` } }],
    pageInfo: { hasNextPage: true, endCursor: `cursor-${number}` },
  } };
}

test("one request returns the same 80 PR records and repository metadata without repo view", async () => {
  const requested: string[][] = [];
  const nodes = Array.from({ length: 80 }, (_, index) => ({
    number: index + 1, headRefOid: `commit-${index}`, baseRefName: "main", headRefName: `feature-${index}`,
    commits: { nodes: [{ commit: { oid: `commit-${index}` } }], pageInfo: { hasNextPage: false } },
    comments: { totalCount: 2 }, reviewThreads: { nodes: [{ comments: { totalCount: 3 } }] },
  }));
  const runner: GhExecute = async (args, cwd, options) => {
    requested.push([...args]);
    assert.equal(cwd, "/repo");
    assert.equal(options.operation, "graph-pr-list-page");
    assert.ok(args.includes("owner={owner}") && args.includes("name={repo}"));
    assert.ok(args.includes("limit=80"));
    const query = args.find((arg) => arg.startsWith("query="))!;
    assert.match(query, /commits\(first: 30\)/);
    assert.match(query, /reviewThreads\(first: 20\)/);
    assert.match(query, /nameWithOwner/);
    return firstPage(nodes, true);
  };
  const result = await fetchPullRequestListPage("/repo", undefined, undefined, runner);
  assert.equal(requested.length, 1);
  assert.equal(result.repository, "owner/repository");
  assert.equal(result.defaultBranch, "main");
  assert.equal(result.pullRequests.length, 80);
  assert.deepEqual(result.pullRequests.map((pr) => pr.number), nodes.map((pr) => pr.number));
  assert.equal(result.pullRequests[0].commentCount, 5);
  assert.deepEqual(result.pullRequests[79].commitHashes, ["commit-79"]);
  assert.deepEqual(result.pageInfo, { hasNextPage: true, endCursor: "next-pr-page" });
});

test("next PR page forwards the cursor and accepts an empty successful page", async () => {
  let reads = 0;
  const runner: GhExecute = async (args) => {
    reads++;
    assert.ok(args.includes("cursor=previous-pr-page"));
    return firstPage([]);
  };
  const page = await fetchPullRequestListPage("/repo", "previous-pr-page", undefined, runner);
  assert.equal(reads, 1);
  assert.deepEqual(page.pullRequests, []);
  assert.equal(page.pageInfo?.hasNextPage, false);
});

test("large PR pagination keeps every commit in API order and adds all review comments", async () => {
  const node = pagedPullRequest(1);
  node.headRefOid = "head";
  node.comments = { totalCount: 2 };
  node.reviewThreads = {
    nodes: [{ comments: { totalCount: 3 } }],
    pageInfo: { hasNextPage: true, endCursor: "review-next" },
  };
  const calls: string[] = [];
  const runner: GhExecute = async (args, _cwd, options) => {
    calls.push(options.operation);
    if (options.operation === "graph-pr-list-page") return firstPage([node]);
    assert.ok(args.includes("owner=owner") && args.includes("name=repository"));
    if (options.operation === "graph-pr-review-thread-count-page") return reviewPage([4, 5]);
    if (args.includes("cursor=cursor-1")) return commitPage(["start-1", "middle"], "last");
    assert.ok(args.includes("cursor=last"));
    return commitPage(["middle", "head"]);
  };
  const result = await fetchPullRequestListPage("/repo", undefined, undefined, runner);
  assert.deepEqual(result.pullRequests[0].commitHashes, ["start-1", "middle", "head"]);
  assert.equal(result.pullRequests[0].commentCount, 14);
  assert.equal(calls.filter((operation) => operation === "graph-pr-commit-page").length, 2);
});

test("independent large PRs overlap with at most four outstanding network requests", async () => {
  const pending: Array<ReturnType<typeof deferred<string>>> = [];
  let active = 0, maximum = 0;
  const runner: GhExecute = async (_args, _cwd, options) => {
    if (options.operation === "graph-pr-list-page") return firstPage(Array.from({ length: 9 }, (_, index) => pagedPullRequest(index + 1)));
    const read = deferred<string>();
    pending.push(read);
    active++;
    maximum = Math.max(maximum, active);
    try { return await read.promise; }
    finally { active--; }
  };
  const result = fetchPullRequestListPage("/repo", undefined, undefined, runner);
  await settle();
  assert.equal(pending.length, 4);
  for (let index = 0; index < 9; index++) {
    pending[index].resolve(commitPage([`end-${index + 1}`]));
    await settle();
  }
  const page = await result;
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.equal(page.pullRequests.length, 9);
  assert.deepEqual(page.pullRequests[8].commitHashes, ["start-9", "end-9", "head-9"]);
});

test("commit and comment pagination share the same four-request limit", async () => {
  const pending: Array<ReturnType<typeof deferred<string>>> = [];
  const operations: string[] = [];
  const nodes = [1, 2, 3].map((number) => ({ ...pagedPullRequest(number), reviewThreads: {
    pageInfo: { hasNextPage: true, endCursor: "comments" },
  } }));
  const runner: GhExecute = async (_args, _cwd, options) => {
    if (options.operation === "graph-pr-list-page") return firstPage(nodes);
    const read = deferred<string>();
    operations.push(options.operation);
    pending.push(read);
    return read.promise;
  };
  const result = fetchPullRequestListPage("/repo", undefined, undefined, runner);
  await settle();
  assert.equal(pending.length, 4);
  assert.equal(operations.filter((operation) => operation === "graph-pr-review-thread-count-page").length, 2);
  for (let index = 0; index < 6; index++) {
    pending[index].resolve(operations[index] === "graph-pr-commit-page" ? commitPage(["end"]) : reviewPage([7]));
    await settle();
  }
  const page = await result;
  assert.deepEqual(page.pullRequests.map((pr) => pr.commentCount), [7, 7, 7]);
});

test("cancellation before a read starts performs no network request", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(fetchPullRequestListPage("/repo", undefined, controller.signal, async () => {
    calls++;
    return firstPage([]);
  }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("cancellation stops running pages and does not start queued pagination", async () => {
  const controller = new AbortController();
  let calls = 0, cancelled = 0;
  const runner: GhExecute = async (_args, _cwd, options) => {
    calls++;
    if (options.operation === "graph-pr-list-page") return firstPage([1, 2, 3, 4, 5, 6].map(pagedPullRequest));
    return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => {
      cancelled++;
      reject(new DOMException("cancelled", "AbortError"));
    }, { once: true }));
  };
  const result = fetchPullRequestListPage("/repo", undefined, controller.signal, runner);
  const rejected = assert.rejects(result, { name: "AbortError" });
  await settle();
  controller.abort();
  await rejected;
  assert.equal(calls, 5);
  assert.equal(cancelled, 4);
});

test("first failed supplemental page cancels peers and never returns a partial successful list", async () => {
  const failure = deferred<string>();
  let calls = 0, cancelled = 0;
  const expected = new Error("GitHub unavailable");
  const runner: GhExecute = async (_args, _cwd, options) => {
    calls++;
    if (options.operation === "graph-pr-list-page") return firstPage([1, 2, 3, 4, 5, 6].map(pagedPullRequest));
    if (calls === 2) return failure.promise;
    return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => {
      cancelled++;
      reject(new DOMException("cancelled", "AbortError"));
    }, { once: true }));
  };
  const result = fetchPullRequestListPage("/repo", undefined, undefined, runner);
  const rejected = assert.rejects(result, (error) => error === expected);
  await settle();
  failure.reject(expected);
  await rejected;
  assert.equal(calls, 5);
  assert.equal(cancelled, 3);
});

test("a late first page after cancellation cannot trigger supplemental reads", async () => {
  const controller = new AbortController();
  const initial = deferred<string>();
  let calls = 0;
  const result = fetchPullRequestListPage("/repo", undefined, controller.signal, async () => { calls++; return initial.promise; });
  const rejected = assert.rejects(result, { name: "AbortError" });
  controller.abort();
  initial.resolve(firstPage([pagedPullRequest(1)]));
  await rejected;
  assert.equal(calls, 1);
});

test("incomplete repository responses fail instead of erasing the retained PR list", async () => {
  await assert.rejects(fetchPullRequestListPage("/repo", undefined, undefined, async () => '{"data":{"repository":null}}'), /not available/);
});

test("repeated commit cursors fail promptly instead of fetching forever", async () => {
  let calls = 0;
  const runner: GhExecute = async (_args, _cwd, options) => {
    calls++;
    return options.operation === "graph-pr-list-page"
      ? firstPage([pagedPullRequest(1)])
      : commitPage(["middle"], "cursor-1");
  };
  await assert.rejects(fetchPullRequestListPage("/repo", undefined, undefined, runner), /did not advance/);
  assert.equal(calls, 2);
});

test("small first review page still counts every thread beyond twenty supplemental pages", async () => {
  let pages = 0;
  const counts = await fetchRemainingReviewThreadCommentCounts("/repo", "owner", "repository", [{
    number: 1, reviewThreads: { pageInfo: { hasNextPage: true, endCursor: "page-0" } },
  }], undefined, async () => {
    pages++;
    return reviewPage([100], pages < 21 ? `page-${pages}` : undefined);
  });
  assert.equal(pages, 21);
  assert.equal(counts.get(1), 2100);
});

test("repeated review cursors fail instead of silently returning a partial count", async () => {
  let pages = 0;
  await assert.rejects(fetchRemainingReviewThreadCommentCounts("/repo", "owner", "repository", [{
    number: 1, reviewThreads: { pageInfo: { hasNextPage: true, endCursor: "repeated" } },
  }], undefined, async () => { pages++; return reviewPage([5], "repeated"); }), /did not advance/);
  assert.equal(pages, 1);
});

test("a stalled GitHub request times out, aborts the child, and permits a fresh retry", async () => {
  let childSignal: AbortSignal | undefined;
  const late = deferred<string>();
  const runner: GhExecute = async (_args, _cwd, options) => {
    childSignal = options.signal;
    return late.promise;
  };
  await assert.rejects(fetchPullRequestListPage("/repo", undefined, undefined, runner, { requestTimeoutMs: 10 }), /timed out/);
  assert.equal(childSignal?.aborted, true);
  late.resolve(firstPage([pagedPullRequest(1)]));
  const retried = await fetchPullRequestListPage("/repo", undefined, undefined, async () => firstPage([]));
  assert.deepEqual(retried.pullRequests, []);
});

test("a supplemental timeout fails the whole page without returning incomplete commits", async () => {
  const runner: GhExecute = async (_args, _cwd, options) => {
    if (options.operation === "graph-pr-list-page") return firstPage([pagedPullRequest(1)]);
    return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => {
      reject(new DOMException("cancelled", "AbortError"));
    }, { once: true }));
  };
  await assert.rejects(fetchPullRequestListPage("/repo", undefined, undefined, runner, { requestTimeoutMs: 10 }), /timed out/);
});

test("invalid timeout values are rejected before starting a network request", async () => {
  for (const requestTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(fetchPullRequestListPage("/repo", undefined, undefined, async () => {
      assert.fail("invalid read should never start");
    }, { requestTimeoutMs }), RangeError);
  }
});
