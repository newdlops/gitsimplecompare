import assert from "node:assert/strict";
import test from "node:test";
import { completeSearchPullRequests } from "../src/git/pullRequestSearchReads";
import { searchPullRequests } from "../src/git/pullRequestSearchService";
import { GitHubReadCache } from "../src/git/githubReadCache";
import type { GhExecute } from "../src/git/ghRunner";

/** 시작·취소 요청·실제 종료를 각각 독립적으로 관찰하는 gate다. */
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
/** 원래 오류를 관찰하면서 종료 gate 이전의 조기 반환을 검출한다. */
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
/** review 연결은 끝났고 commit tail만 남은 독립 PR worker용 metadata다. */
function node(number: number): any { return { number, title: "PR", state: "OPEN", url: `https://github.com/owner/repo/pull/${number}`,
  headRefName: "topic", baseRefName: "main", headRefOid: "head", baseRefOid: "base", files: { totalCount: 1 }, comments: { totalCount: 0 },
  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
  commits: { nodes: [{ commit: { oid: "head", messageHeadline: "Head" } }], pageInfo: { hasNextPage: true, endCursor: "tail" } } }; }

test("a failed commit worker joins another worker's delayed close and keeps the first failure", async () => {
  const begun = deferred<void>(), stop = deferred<void>(), close = deferred<void>();
  const failure = new Error("first commit failed"); let closed = false, settled = false;
  const pending = completeSearchPullRequests("/worker-close", "owner", "repo", [node(1), node(2)], async (_args, _root, options) => {
    const number = options.request?.kind === "graphql" ? options.request.variables.number : undefined;
    if (number === 1) { await begun.promise; throw failure; }
    begun.resolve(undefined);
    await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => { stop.resolve(undefined); resolve(); }, { once: true }));
    await close.promise; closed = true; throw new DOMException("cancelled", "AbortError");
  });
  const observed = pending.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  try {
    await stop.promise; await turn(); assert.equal(settled, false); assert.equal(closed, false);
    close.resolve(undefined); assert.equal(await observed, failure); assert.equal(closed, true);
  } finally { close.resolve(undefined); await observed; }
});

test("a review-tail failure joins the actual cached commit execution, not only its cancelled subscriber", async () => {
  const begun = deferred<void>(), stop = deferred<void>(), close = deferred<void>();
  const failure = new Error("review tail failed"); let closed = false, settled = false;
  const cache = new GitHubReadCache(async (_args, _root, options) => {
    if (options.operation.includes("review")) { await begun.promise; throw failure; }
    options.signal!.addEventListener("abort", () => stop.resolve(undefined), { once: true }); begun.resolve(undefined);
    await close.promise; closed = true; throw new DOMException("cancelled", "AbortError");
  });
  const value = node(1); value.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "review" };
  const execute: GhExecute = (args, root, options) => cache.read(args, root, options);
  const pending = completeSearchPullRequests("/cached-close", "owner", "repo", [value], execute);
  const observed = pending.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  try {
    await stop.promise; await turn(); assert.equal(settled, false); assert.equal(closed, false);
    close.resolve(undefined); assert.equal(await observed, failure); assert.equal(closed, true);
  } finally { close.resolve(undefined); await observed; await cache.dispose(); }
});

test("an exact-number failure joins the independent text search's actual cached execution", async () => {
  const begun = deferred<void>(), stop = deferred<void>(), close = deferred<void>();
  const failure = new Error("exact lookup failed"); let closed = false, settled = false;
  const cache = new GitHubReadCache(async (args, _root, options) => {
    if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" });
    if (options.operation === "pr-search") {
      options.signal!.addEventListener("abort", () => stop.resolve(undefined), { once: true }); begun.resolve(undefined);
      await close.promise; closed = true; throw new DOMException("cancelled", "AbortError");
    }
    await begun.promise; throw failure;
  });
  const execute: GhExecute = (args, root, options) => cache.read(args, root, options);
  const pending = searchPullRequests("/branch-close", "123", undefined, undefined, execute);
  const observed = pending.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  try {
    await stop.promise; await turn(); assert.equal(settled, false); assert.equal(closed, false);
    close.resolve(undefined); assert.equal(await observed, failure); assert.equal(closed, true);
  } finally { close.resolve(undefined); await observed; await cache.dispose(); }
});
