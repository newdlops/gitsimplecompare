import assert from "node:assert/strict";
import test from "node:test";
import { GhCliError } from "../src/git/ghCli";
import type { GhExecute } from "../src/git/ghRunner";
import { clearGitHubRepositoryNameCache } from "../src/git/githubRepositoryName";
import { searchPullRequests } from "../src/git/pullRequestSearchService";
import { fetchSearchPullRequestsByNumber } from "../src/git/pullRequestSearchReads";
import type { GhPullRequestNode } from "../src/git/pullRequestInfo";
import { safetyFixture } from "./helpers/gitSafetyFixture";

/** 첫 검색·단건·묶음 조회가 공통으로 반환할 완전한 PR metadata다. */
function node(number: number) {
  return { number, title: `PR ${number}`, state: "OPEN", url: `https://github.com/fixture/repo/pull/${number}`,
    headRefName: `feature-${number}`, baseRefName: "main", headRefOid: `head-${number}`, baseRefOid: "base",
    files: { totalCount: 1 }, comments: { totalCount: 0 },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    commits: { nodes: [{ commit: { oid: `head-${number}`, messageHeadline: `Change ${number}` } }], pageInfo: { hasNextPage: false } } };
}

/** GraphQL search 응답에서 빈 성공과 누락·부분 응답을 구별할 수 있도록 필수 연결을 만든다. */
function search(nodes: ReturnType<typeof node>[] = [], cursor?: string) {
  return { data: { search: { nodes, issueCount: nodes.length, pageInfo: { hasNextPage: Boolean(cursor), endCursor: cursor } } } };
}

test("commit association search expands 45 complete PRs in three bounded metadata requests", async t => {
  clearGitHubRepositoryNameCache(); t.after(clearGitHubRepositoryNameCache);
  const f = await safetyFixture(t, "pr-search-batch"), calls: string[] = [], widths: number[] = [];
  const runner: GhExecute = async (args, _root, options) => {
    calls.push(options.operation);
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "fixture/repo" });
    if (options.operation === "pr-search") return JSON.stringify(search());
    if (options.operation === "pr-search-associated") return JSON.stringify(Array.from({ length: 45 }, (_, index) => ({ number: index + 1 })));
    const query = args.find(arg => arg.startsWith("query=")) || "";
    const numbers = [...query.matchAll(/p(\d+):\s*pullRequest/g)].map(match => Number(match[1]));
    if (numbers.length) {
      widths.push(numbers.length);
      return JSON.stringify({ data: { repository: Object.fromEntries(numbers.map(number => [`p${number}`, node(number)])) } });
    }
    const number = Number(args.find(arg => arg.startsWith("number="))?.slice(7));
    return JSON.stringify({ data: { repository: { pullRequest: node(number) } } });
  };
  const result = await searchPullRequests(f.root, "abcdef0", undefined, undefined, runner);
  assert.deepEqual(result.pullRequests.map(pr => pr.number), Array.from({ length: 45 }, (_, index) => index + 1));
  assert.ok(result.pullRequests.every(pr => pr.commitHashesComplete && pr.commitSummaries?.[0].title === `Change ${pr.number}`));
  assert.equal(calls.filter(name => /pr-search-number/.test(name)).length, 3);
  assert.deepEqual(widths, [20, 20, 5]);
  assert.equal(calls.length, 6, "one repository lookup, one search, one association and three metadata requests");
});

test("partial GraphQL search data is rejected before any supplemental reads", async t => {
  clearGitHubRepositoryNameCache(); t.after(clearGitHubRepositoryNameCache);
  const f = await safetyFixture(t, "pr-search-partial"); let calls = 0;
  await assert.rejects(searchPullRequests(f.root, "topic", undefined, undefined, async args => {
    calls++;
    return JSON.stringify(args[0] === "repo" ? { nameWithOwner: "fixture/repo" }
      : { ...search([node(1)]), errors: [{ message: "partial response" }] });
  }), /incomplete|not available/i);
  assert.equal(calls, 2);
});

test("a repeated search cursor fails after two pages instead of downloading duplicates to the row limit", async t => {
  clearGitHubRepositoryNameCache(); t.after(clearGitHubRepositoryNameCache);
  const f = await safetyFixture(t, "pr-search-cursor"); let searches = 0;
  await assert.rejects(searchPullRequests(f.root, "topic", undefined, undefined, async args => {
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "fixture/repo" });
    searches++; return JSON.stringify(search([node(1)], "same-cursor"));
  }), /cursor|advance/i);
  assert.equal(searches, 2);
});

for (const missing of [false, 404, 422]) {
  test(`associated PR lookup ${missing ? `allows a missing commit (${missing})` : "propagates authentication failures"}`, async t => {
    clearGitHubRepositoryNameCache(); t.after(clearGitHubRepositoryNameCache);
    const f = await safetyFixture(t, `pr-search-associated-${missing}`);
    const runner: GhExecute = async (args, _root, options) => {
      if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "fixture/repo" });
      if (options.operation === "pr-search") return JSON.stringify(search([node(1)]));
      throw new GhCliError(missing ? "Not Found" : "GitHub authentication failed", [...args],
        missing === 404 ? "HTTP 404: Not Found" : missing === 422 ? "HTTP 422: No commit found for SHA" : "HTTP 401: Bad credentials", "", 1);
    };
    if (missing) assert.equal((await searchPullRequests(f.root, "abcdef0", undefined, undefined, runner)).pullRequests.length, 1);
    else await assert.rejects(searchPullRequests(f.root, "abcdef0", undefined, undefined, runner), /authentication/i);
  });
}

for (const status of [422, 429, 503]) {
  test(`HTTP ${status} without an explicit missing commit is never hidden as an empty association`, async t => {
    clearGitHubRepositoryNameCache(); t.after(clearGitHubRepositoryNameCache);
    const f = await safetyFixture(t, `pr-search-http-${status}`);
    await assert.rejects(searchPullRequests(f.root, "abcdef0", undefined, undefined, async (args, _root, options) => {
      if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "fixture/repo" });
      if (options.operation === "pr-search") return JSON.stringify(search());
      throw new GhCliError("GitHub request failed", [...args], `HTTP ${status}: Request cannot be processed`, "", 1);
    }), /GitHub request failed/);
  });
}

for (const kind of ["missing", "identity", "partial", "connection"] as const) {
  test(`batch metadata rejects ${kind} responses without accepting a partial PR set`, async () => {
    await assert.rejects(fetchSearchPullRequestsByNumber("/repo", "fixture", "repo", [1, 2], async () => {
      const p2: Record<string, unknown> = node(kind === "identity" ? 3 : 2);
      if (kind === "connection") delete p2.commits;
      return JSON.stringify({ data: { repository: { p1: node(1), ...(kind === "missing" ? {} : { p2 }) } },
        ...(kind === "partial" ? { errors: [{ message: "partial field" }] } : {}) });
    }), /incomplete/i);
  });
}

test("explicit missing PRs are omitted and duplicate PR numbers are queried once", async () => {
  let reads = 0;
  const result = await fetchSearchPullRequestsByNumber("/repo", "fixture", "repo", [1, 2, 1], async args => {
    reads++;
    assert.equal((args.find(arg => arg.startsWith("query="))!.match(/p1:/g) || []).length, 1);
    return JSON.stringify({ data: { repository: { p1: node(1), p2: null } } });
  });
  assert.equal(reads, 1); assert.deepEqual(result.map(pr => pr.number), [1]);
});

test("numeric searches preserve text matches when GitHub reports NOT_FOUND for the requested PR alias", async t => {
  clearGitHubRepositoryNameCache(); t.after(clearGitHubRepositoryNameCache);
  const f = await safetyFixture(t, "pr-search-number-missing");
  const value = await searchPullRequests(f.root, "#999", undefined, undefined, async (args, _root, options) => {
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "fixture/repo" });
    if (options.operation === "pr-search") return JSON.stringify(search([node(1)]));
    const stdout = JSON.stringify({ data: { repository: { p999: null } }, errors: [{ type: "NOT_FOUND", path: ["repository", "p999"], message: "Could not resolve to a PullRequest" }] });
    throw new GhCliError("GitHub GraphQL request failed", [...args], "Could not resolve to a PullRequest", stdout, 1, options.operation);
  });
  assert.deepEqual(value.pullRequests.map(pr => pr.number), [1]);
});

test("one missing alias in a batch does not discard other complete PRs", async () => {
  const value = await fetchSearchPullRequestsByNumber("/repo", "fixture", "repo", [1, 2], async args => {
    const stdout = JSON.stringify({ data: { repository: { p1: node(1), p2: null } }, errors: [{ type: "NOT_FOUND", path: ["repository", "p2"] }] });
    throw new GhCliError("GraphQL NOT_FOUND", [...args], "Not found", stdout, 1);
  });
  assert.deepEqual(value.map(pr => pr.number), [1]);
});

for (const kind of ["repository", "wrong-alias", "non-null", "permission"] as const) {
  test(`GraphQL ${kind} errors cannot masquerade as an absent requested PR`, async () => {
    const expected = new GhCliError("GraphQL request failed", [], "query failed", JSON.stringify({
      data: { repository: { p1: kind === "non-null" ? node(1) : null } },
      errors: [{ type: kind === "permission" ? "FORBIDDEN" : "NOT_FOUND",
        path: kind === "repository" ? ["repository"] : ["repository", kind === "wrong-alias" ? "p9" : "p1"] }],
    }), 1);
    await assert.rejects(fetchSearchPullRequestsByNumber("/repo", "fixture", "repo", [1], async () => { throw expected; }),
      error => error === expected);
  });
}

test("commit associations continue past one hundred without dropping PRs", async t => {
  clearGitHubRepositoryNameCache(); t.after(clearGitHubRepositoryNameCache);
  const f = await safetyFixture(t, "pr-search-associated-pages"), pages: number[] = [];
  const result = await searchPullRequests(f.root, "abcdef0", undefined, undefined, async (args, _root, options) => {
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "fixture/repo" });
    if (options.operation === "pr-search") return JSON.stringify(search());
    if (options.operation === "pr-search-associated") {
      const page = Number(new URL(`https://api.github.test/${args[1]}`).searchParams.get("page") || "1"); pages.push(page);
      return JSON.stringify(page === 1 ? Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })) : [{ number: 101 }, { number: 102 }]);
    }
    const numbers = [...args.find(arg => arg.startsWith("query="))!.matchAll(/p(\d+):\s*pullRequest/g)].map(match => Number(match[1]));
    return JSON.stringify({ data: { repository: Object.fromEntries(numbers.map(number => [`p${number}`, node(number)])) } });
  });
  assert.deepEqual(result.pullRequests.map(pr => pr.number), Array.from({ length: 102 }, (_, index) => index + 1));
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.totalCount, 102);
});

for (const kind of ["repeated", "failed"] as const) {
  test(`a ${kind} association tail never becomes a partial successful search`, async t => {
    clearGitHubRepositoryNameCache(); t.after(clearGitHubRepositoryNameCache);
    const f = await safetyFixture(t, `pr-search-tail-${kind}`); let pages = 0, metadata = 0;
    await assert.rejects(searchPullRequests(f.root, "abcdef0", undefined, undefined, async (args, _root, options) => {
      if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "fixture/repo" });
      if (options.operation === "pr-search") return JSON.stringify(search());
      if (options.operation === "pr-search-associated") {
        pages++;
        if (pages > 1 && kind === "failed") throw new GhCliError("tail failed", [...args], "HTTP 404: Not Found", "", 1);
        return JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })));
      }
      metadata++; throw new Error("metadata must not start after an incomplete association list");
    }), kind === "repeated" ? /did not advance/ : /tail failed/);
    assert.equal(pages, 2); assert.equal(metadata, 0);
  });
}

test("batched metadata still completes 105 original commits and every review comment", async () => {
  const hashes = Array.from({ length: 105 }, (_, index) => `commit-${index}`);
  const first: GhPullRequestNode = node(7);
  first.headRefOid = hashes.at(-1)!;
  first.commits = { nodes: hashes.slice(0, 100).map(oid => ({ commit: { oid, messageHeadline: oid } })),
    pageInfo: { hasNextPage: true, endCursor: "next-commits" } };
  first.reviewThreads = { nodes: [{ comments: { totalCount: 2 } }], pageInfo: { hasNextPage: true, endCursor: "next-threads" } };
  const calls: string[] = [];
  const result = await fetchSearchPullRequestsByNumber("/repo", "fixture", "repo", [7], async (_args, _root, options) => {
    calls.push(options.operation);
    if (options.operation === "pr-search-number") return JSON.stringify({ data: { repository: { p7: first } } });
    if (options.operation === "graph-pr-review-thread-count-page") return JSON.stringify({ data: { repository: { pullRequest: {
      reviewThreads: { nodes: [{ comments: { totalCount: 4 } }], pageInfo: { hasNextPage: false } } } } } });
    assert.equal(options.operation, "graph-pr-commit-page");
    return JSON.stringify({ data: { repository: { pullRequest: { headRefOid: first.headRefOid, baseRefOid: "base",
      commits: { nodes: hashes.slice(100).map(oid => ({ commit: { oid, messageHeadline: oid } })), pageInfo: { hasNextPage: false } } } } } });
  });
  assert.deepEqual(result[0].commitHashes, hashes); assert.equal(result[0].commitHashesComplete, true);
  assert.equal(result[0].commitSummaries?.length, 105); assert.equal(result[0].commentCount, 6);
  assert.equal(calls.length, 3);
});

/** 파일 검사와 큐를 거쳐 실제 batch 실행이 시작됐는지 관찰한다. */
async function waitFor(condition: () => boolean): Promise<void> {
  const until = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < until, "expected search batch did not start");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

for (const cancel of [false, true]) {
  test(`one hundred associated PRs ${cancel ? "cancel every active batch without starting the fifth" : "share four request slots through completion"}`, async t => {
    clearGitHubRepositoryNameCache(); t.after(clearGitHubRepositoryNameCache);
    const f = await safetyFixture(t, `pr-search-parallel-${cancel}`), controller = new AbortController();
    t.after(() => controller.abort());
    const waiting: Array<() => void> = []; let active = 0, maximum = 0, cancelled = 0;
    const pending = searchPullRequests(f.root, "abcdef0", undefined, controller.signal, async (args, _root, options) => {
      if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "fixture/repo" });
      if (options.operation === "pr-search") return JSON.stringify(search());
      if (options.operation === "pr-search-associated") return JSON.stringify(args[1].includes("&page=") ? []
        : Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })));
      const numbers = [...args.find(arg => arg.startsWith("query="))!.matchAll(/p(\d+):\s*pullRequest/g)].map(match => Number(match[1]));
      active++; maximum = Math.max(maximum, active);
      try {
        return await new Promise<string>((resolve, reject) => {
          const abort = () => { cancelled++; reject(new DOMException("cancelled", "AbortError")); };
          options.signal!.addEventListener("abort", abort, { once: true });
          waiting.push(() => { options.signal!.removeEventListener("abort", abort);
            resolve(JSON.stringify({ data: { repository: Object.fromEntries(numbers.map(number => [`p${number}`, node(number)])) } })); });
        });
      } finally { active--; }
    });
    const observed = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await waitFor(() => waiting.length === 4);
    assert.equal(maximum, 4);
    if (cancel) {
      controller.abort(); const result = await observed;
      assert.equal(result.error?.name, "AbortError"); assert.equal(cancelled, 4); assert.equal(waiting.length, 4);
    } else {
      for (let index = 0; index < 5; index++) { await waitFor(() => waiting.length > index); waiting[index](); }
      const result = await observed; assert.equal(result.error, undefined); assert.equal(result.value?.pullRequests.length, 100);
    }
    assert.equal(active, 0); assert.equal(maximum, 4);
  });
}
