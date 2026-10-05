import assert from "node:assert/strict";
import test from "node:test";
import type { GhExecute } from "../src/git/ghRunner";
import type { GhPullRequestNode } from "../src/git/pullRequestInfo";
import { fetchPullRequestListPage } from "../src/git/pullRequestListService";

type IdentifiedNode = GhPullRequestNode & { id: string; __typename: "PullRequest" };

/** root 목록과 ID 조회가 같은 실제 PR을 가리키는 완전한 GraphQL fixture를 만든다. */
function records(count = 80): IdentifiedNode[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return { id: `PR-${number}`, __typename: "PullRequest", number, title: `Title ${number}`,
      state: ["OPEN", "MERGED", "CLOSED"][index % 3], url: `https://github.com/owner/repo/pull/${number}`,
      headRefName: `feature-${number}`, headRefOid: `head-${number}`, baseRefName: "main", baseRefOid: `base-${number}`,
      mergeCommit: { oid: `merge-${number}` }, author: { login: "author" }, isDraft: false, reviewDecision: "APPROVED",
      updatedAt: "2026-10-05T00:00:00Z", labels: { nodes: [{ name: "bug", color: "00ff00", description: "Fix" }] },
      comments: { totalCount: 2 }, reviewThreads: { nodes: [{ comments: { totalCount: 3 } }], pageInfo: { hasNextPage: false } },
      files: { totalCount: number + 10 }, commits: { nodes: [{ commit: { oid: `start-${number}` } }, { commit: { oid: `head-${number}` } }],
        pageInfo: { hasNextPage: false } } };
  });
}

/** 첫 목록 응답은 구 구현도 해석할 수 있게 PR identity와 메타데이터를 함께 가진다. */
function page(nodes: IdentifiedNode[], hasMore = true): string {
  return JSON.stringify({ data: { repository: { nameWithOwner: "owner/repo", defaultBranchRef: { name: "main" },
    pullRequests: { nodes, pageInfo: { hasNextPage: hasMore, endCursor: hasMore ? "opaque-next-page" : null } } } } });
}

/** API가 반환 순서를 바꿔도 요청 identity를 기준으로 원래 목록 순서를 보존해야 한다. */
function nodePage(args: readonly string[], nodes: IdentifiedNode[]): string {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const requested = args.filter(arg => arg.startsWith("ids[]=")).map(arg => arg.slice(6));
  return JSON.stringify({ data: { nodes: requested.reverse().map(id => byId.get(id)) } });
}

/** 큐와 취소의 microtask가 진행될 때까지 기다리며 벽시계 시간 가정은 하지 않는다. */
function settle(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }

/** 실제 첫 root 응답처럼 중첩 commit/review 정보를 제거해 얕은 표시의 완료 플래그를 검증한다. */
function summaryPage(nodes: IdentifiedNode[]): string {
  const response = JSON.parse(page(nodes));
  for (const node of response.data.repository.pullRequests.nodes) {
    delete node.commits; delete node.reviewThreads; delete node.files; delete node.comments; delete node.labels;
    delete node.headRefOid; delete node.baseRefOid; delete node.mergeCommit; delete node.reviewDecision;
  }
  return JSON.stringify(response);
}

test("identity-first PR loading preserves all 80 records, full fields, and the opaque page cursor", async () => {
  const nodes = records();
  let heavyRoot = false;
  let identityRequests = 0;
  const result = await fetchPullRequestListPage("/repo", undefined, undefined, async (args, _root, options) => {
    if (options.operation === "graph-pr-list-page") {
      heavyRoot = /commits\(|reviewThreads\(/.test(args.find(arg => arg.startsWith("query=")) || "");
      assert.ok(args.includes("limit=80"));
      return page(nodes);
    }
    identityRequests++;
    return nodePage(args, nodes);
  });
  assert.equal(heavyRoot, false, "the ordered root connection must not expand 80 nested commit/review connections");
  assert.ok(identityRequests > 1, "heavy PR information is fetched in independent bounded groups");
  assert.equal(result.pullRequests.length, 80);
  assert.deepEqual(result.pullRequests.slice(0, 3).map(pr => [pr.number, pr.state]), [[1, "OPEN"], [2, "MERGED"], [3, "CLOSED"]]);
  assert.equal(result.pullRequests[79].number, 80);
  assert.equal(result.pullRequests[0].fileCount, 11);
  assert.equal(result.pullRequests[79].fileCount, 90);
  assert.equal(result.pullRequests[0].commentCount, 5);
  assert.deepEqual(result.pullRequests[0].commitHashes, ["start-1", "head-1"]);
  assert.equal(result.pullRequests[0].reviewDecision, "APPROVED");
  assert.deepEqual(result.pullRequests[0].labels, [{ name: "bug", color: "00ff00", description: "Fix" }]);
  assert.deepEqual(result.pageInfo, { hasNextPage: true, endCursor: "opaque-next-page" });
});

test("PR metadata groups overlap without exceeding the four-request limit", async () => {
  const nodes = records();
  let active = 0, maximum = 0;
  const waiting: Array<() => void> = [];
  const runner: GhExecute = async (args, _root, options) => {
    if (options.operation === "graph-pr-list-page") return page(nodes);
    active++; maximum = Math.max(maximum, active);
    return new Promise(resolve => waiting.push(() => { active--; resolve(nodePage(args, nodes)); }));
  };
  const result = fetchPullRequestListPage("/repo", undefined, undefined, runner);
  await settle();
  const started = waiting.length;
  for (const complete of waiting) complete();
  const completed = await result;
  assert.equal(started, 4);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.equal(completed.pullRequests.length, 80);
});

test("an omitted PR metadata identity never becomes a partial successful list", async () => {
  const nodes = records(2);
  await assert.rejects(fetchPullRequestListPage("/repo", undefined, undefined, async (_args, _root, options) => {
    if (options.operation === "graph-pr-list-page") return page(nodes);
    return JSON.stringify({ data: { nodes: [nodes[0], null] } });
  }), /not available|identity|incomplete/i);
});

test("cancelling metadata loading stops every running group before supplemental pagination", async () => {
  const nodes = records();
  const controller = new AbortController();
  let reads = 0, cancelled = 0;
  const result = fetchPullRequestListPage("/repo", undefined, controller.signal, async (_args, _root, options) => {
    reads++;
    if (options.operation === "graph-pr-list-page") return page(nodes);
    return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => {
      cancelled++; reject(new DOMException("cancelled", "AbortError"));
    }, { once: true }));
  });
  const observed = result.then(() => ({ success: true, error: undefined }), error => ({ success: false, error }));
  await settle();
  controller.abort();
  const completed = await observed;
  assert.equal(completed.success, false);
  assert.equal(completed.error?.name, "AbortError");
  assert.equal(reads, 5);
  assert.equal(cancelled, 4);
});

test("an identity page with GraphQL partial errors is not published as a successful page", async () => {
  const nodes = records(1);
  await assert.rejects(fetchPullRequestListPage("/repo", undefined, undefined, async (args, _root, options) => {
    if (options.operation === "graph-pr-list-page") {
      const result = JSON.parse(page(nodes));
      result.errors = [{ message: "one field failed" }];
      return JSON.stringify(result);
    }
    return nodePage(args, nodes);
  }), /not available|incomplete/i);
});

test("a missing identity connection cannot erase the retained PR list as an empty success", async () => {
  await assert.rejects(fetchPullRequestListPage("/repo", undefined, undefined, async () => JSON.stringify({ data: { repository: {
    nameWithOwner: "owner/repo", pullRequests: { pageInfo: { hasNextPage: false } },
  } } })), /not available|incomplete/i);
});

test("metadata without the requested commit connection never marks a head-only list as complete", async () => {
  const nodes = records(1);
  await assert.rejects(fetchPullRequestListPage("/repo", undefined, undefined, async (args, _root, options) => {
    if (options.operation === "graph-pr-list-page") return page(nodes);
    const response = JSON.parse(nodePage(args, nodes));
    delete response.data.nodes[0].commits;
    return JSON.stringify(response);
  }), /not available|incomplete/i);
});

test("a missing root node identity fails before starting metadata reads", async () => {
  let metadataReads = 0;
  await assert.rejects(fetchPullRequestListPage("/repo", undefined, undefined, async (_args, _root, options) => {
    if (options.operation !== "graph-pr-list-page") metadataReads++;
    const result = JSON.parse(page(records(1)));
    result.data.repository.pullRequests.nodes = [null];
    return JSON.stringify(result);
  }), /identities.*(?:not available|incomplete)/i);
  assert.equal(metadataReads, 0);
});

test("the first metadata network failure cancels peers and retains the original error", async () => {
  const nodes = records();
  let fail: (() => void) | undefined;
  let cancelled = 0, published = 0;
  const result = fetchPullRequestListPage("/repo", undefined, undefined, async (args, _root, options) => {
    if (options.operation === "graph-pr-list-page") return page(nodes);
    if (args.includes("ids[]=PR-1")) return new Promise((_resolve, reject) => {
      fail = () => reject(new Error("metadata request failed"));
    });
    return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => {
      cancelled++; reject(new DOMException("peer cancelled", "AbortError"));
    }, { once: true }));
  }, { onProgress: () => { published++; } });
  const observed = result.then(() => undefined, error => error);
  await settle();
  fail!();
  const error = await observed;
  assert.equal(error.message, "metadata request failed");
  assert.equal(cancelled, 3);
  assert.equal(published, 1, "the validated summary was published before a later metadata failure");
});

test("GraphQL errors in a metadata batch do not publish otherwise complete PR information", async () => {
  const nodes = records(1);
  let published = 0;
  await assert.rejects(fetchPullRequestListPage("/repo", undefined, undefined, async (args, _root, options) => {
    if (options.operation === "graph-pr-list-page") return page(nodes);
    const response = JSON.parse(nodePage(args, nodes));
    response.errors = [{ message: "metadata field failed" }];
    return JSON.stringify(response);
  }, { onProgress: () => { published++; } }), /not available/i);
  assert.equal(published, 1, "only the validated summary may be published when detailed fields fail");
});

test("all eighty basic PR rows become available before any slow metadata batch finishes", async () => {
  const nodes = records(); const snapshots: any[] = [];
  const waiting: Array<() => void> = [];
  const result = fetchPullRequestListPage("/repo", undefined, undefined, async (args, _root, options) => {
    if (options.operation === "graph-pr-list-page") {
      const query = args.find(arg => arg.startsWith("query="))!;
      assert.match(query, /number title state url/); assert.doesNotMatch(query, /commits\(|reviewThreads\(/);
      return summaryPage(nodes);
    }
    return new Promise(resolve => waiting.push(() => resolve(nodePage(args, nodes))));
  }, { onProgress: snapshot => snapshots.push(snapshot) });
  await settle();
  assert.equal(waiting.length, 4); assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].pullRequests.map((pr: any) => pr.number), nodes.map(pr => pr.number));
  assert.ok(snapshots[0].pullRequests.every((pr: any) => pr.title && pr.commitHashesComplete === false && pr.commentCountComplete === false));
  assert.equal(snapshots[0].pullRequests[0].fileCountComplete, false);
  assert.deepEqual(snapshots[0].pullRequests[0].commitHashes, []);
  for (const complete of waiting) complete();
  const final = await result;
  assert.equal(final.pullRequests.length, 80); assert.equal(final.pullRequests[0].commentCount, 5);
  assert.equal(final.pullRequests[0].fileCount, 11); assert.equal(final.pullRequests[0].fileCountComplete, true);
  assert.deepEqual(final.pullRequests[0].commitHashes, ["start-1", "head-1"]);
  assert.equal(snapshots[0].pullRequests[0].commentCountComplete, false, "later hydration must not mutate a published summary");
});

test("completed metadata batches start commit pagination while slower metadata batches are still running", async () => {
  const nodes = records(); nodes[0].commits = { nodes: [{ commit: { oid: "start-1" } }], pageInfo: { hasNextPage: true, endCursor: "tail-1" } };
  const metadata: Array<() => void> = []; let commitTailStarted = false, active = 0, maximum = 0;
  const result = fetchPullRequestListPage("/repo", undefined, undefined, async (args, _root, options) => {
    active++; maximum = Math.max(maximum, active);
    try {
      if (options.operation === "graph-pr-list-page") return summaryPage(nodes);
      if (options.operation === "graph-pr-list-nodes") return await new Promise<string>(resolve => metadata.push(() => resolve(nodePage(args, nodes))));
      assert.equal(options.operation, "graph-pr-commit-page"); commitTailStarted = true;
      return JSON.stringify({ data: { repository: { pullRequest: { headRefOid: "head-1", baseRefOid: "base-1", commits: {
        nodes: [{ commit: { oid: "middle-1" } }, { commit: { oid: "head-1" } }], pageInfo: { hasNextPage: false },
      } } } } });
    } finally { active--; }
  });
  void result.catch(() => undefined);
  await settle(); assert.equal(metadata.length, 4);
  metadata[0](); await settle();
  assert.equal(commitTailStarted, true, "pagination should overlap the other three metadata requests");
  for (const complete of metadata.slice(1)) complete();
  const page = await result;
  assert.deepEqual(page.pullRequests[0].commitHashes, ["start-1", "middle-1", "head-1"]);
  assert.equal(page.pullRequests[0].commitHashesComplete, true); assert.equal(page.pullRequests.length, 80);
  assert.ok(maximum <= 4); assert.equal(active, 0);
});

test("a metadata node cannot replace the summary with a different PR number under the same global ID", async () => {
  const nodes = records(1);
  await assert.rejects(fetchPullRequestListPage("/repo", undefined, undefined, async (args, _root, options) => {
    if (options.operation === "graph-pr-list-page") return summaryPage(nodes);
    const response = JSON.parse(nodePage(args, nodes)); response.data.nodes[0].number = 99;
    return JSON.stringify(response);
  }), /identity|incomplete/i);
});

test("connections larger than the maximum first page still complete every commit and review thread", async () => {
  const nodes = records(1), hashes = Array.from({ length: 133 }, (_, index) => `commit-${index}`);
  nodes[0].headRefOid = hashes.at(-1);
  nodes[0].commits = { nodes: hashes.slice(0, 100).map(oid => ({ commit: { oid } })), pageInfo: { hasNextPage: true, endCursor: "commit-100" } };
  nodes[0].reviewThreads = { nodes: Array.from({ length: 100 }, () => ({ comments: { totalCount: 2 } })), pageInfo: { hasNextPage: true, endCursor: "review-100" } };
  const result = await fetchPullRequestListPage("/repo", undefined, undefined, async (args, _root, options) => {
    if (options.operation === "graph-pr-list-page") return summaryPage(nodes);
    if (options.operation === "graph-pr-list-nodes") return nodePage(args, nodes);
    if (options.operation === "graph-pr-commit-page") return JSON.stringify({ data: { repository: { pullRequest: {
      headRefOid: nodes[0].headRefOid, baseRefOid: "base-1", commits: { nodes: hashes.slice(100).map(oid => ({ commit: { oid } })), pageInfo: { hasNextPage: false } },
    } } } });
    assert.equal(options.operation, "graph-pr-review-thread-count-page");
    return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: Array.from({ length: 51 }, () => ({ comments: { totalCount: 2 } })), pageInfo: { hasNextPage: false } } } } } });
  });
  assert.deepEqual(result.pullRequests[0].commitHashes, hashes); assert.equal(result.pullRequests[0].commitHashesComplete, true);
  assert.equal(result.pullRequests[0].commentCount, 304); assert.equal(result.pullRequests[0].commentCountComplete, true);
});

test("a supplemental failure arriving as metadata completes preserves its real error", async () => {
  const nodes = records(1);
  nodes[0].reviewThreads!.pageInfo = { hasNextPage: true, endCursor: "review-next" };
  await assert.rejects(fetchPullRequestListPage("/repo", undefined, undefined, async (args, _root, options) => {
    if (options.operation === "graph-pr-list-page") return summaryPage(nodes);
    if (options.operation === "graph-pr-list-nodes") return nodePage(args, nodes);
    throw new Error("review failed immediately");
  }), /review failed immediately/);
});
