import assert from "node:assert/strict";
import test from "node:test";
import { GitHubRepositoryCatalog, RepositoryCatalogError } from "../src/git/githubRepositoryCatalog";

/** HTTP body 소비와 재검증 header를 실제 fetch 계약처럼 분리한다. */
function response(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return { ok: status === 200, status, headers: new Headers(headers), json: async () => payload };
}
const page = (description = "original") => [{ full_name: "organization/private", private: true, description }];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** 응답 도착을 제어해 stale-first 표시나 구독자간 취소 전파를 검출한다. */
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("reopening always authorizes before 304 body/Link reuse and callers cannot mutate the private cache", async () => {
  const headers: Headers[] = [], validation = deferred<any>();
  const catalog = new GitHubRepositoryCatalog(async (_url, options) => {
    headers.push(new Headers(options.headers));
    return headers.length === 1 ? response(page(), 200, { etag: '"v1"', link: '<https://api.github.com/user/repos?page=2>; rel="next"' }) : validation.promise;
  });
  try {
    const first = await catalog.listPage("token-a"); first.repositories[0].description = "changed by caller";
    let ready = false;
    const second = catalog.listPage("token-a").then(value => { ready = true; return value; });
    await tick(); assert.equal(ready, false); assert.equal(headers[1].get("if-none-match"), '"v1"');
    validation.resolve({ ...response(undefined, 304), json: async () => { assert.fail("304 must not read a body"); } });
    const result = await second; assert.equal(result.repositories[0].description, "original"); assert.equal(result.nextPage, 2);
  } finally { validation.resolve(response([], 200)); await catalog.dispose(); }
});

test("uncached 304 repairs once without validators and a repeated 304 fails", async () => {
  for (const repaired of [true, false]) {
    const seen: Headers[] = [];
    const catalog = new GitHubRepositoryCatalog(async (_url, options) => {
      seen.push(new Headers(options.headers)); return response(page(), repaired && seen.length === 2 ? 200 : 304, { etag: '"v1"' });
    });
    try {
      if (repaired) assert.equal((await catalog.listPage("token")).repositories.length, 1);
      else await assert.rejects(catalog.listPage("token"), RepositoryCatalogError);
      assert.equal(seen.length, 2); assert(seen.every(headers => !headers.has("if-none-match")));
    } finally { await catalog.dispose(); }
  }
});

test("different OAuth identities and pages never reuse another validator", async () => {
  const seen: Array<[string | null, string | null, string | null]> = [];
  const catalog = new GitHubRepositoryCatalog(async (url, options) => {
    const headers = new Headers(options.headers); seen.push([headers.get("authorization"), new URL(url).searchParams.get("page"), headers.get("if-none-match")]);
    return response(page(), 200, { etag: '"v1"' });
  });
  try {
    await catalog.listPage("a"); await catalog.listPage("b"); await catalog.listPage("a", 2); await catalog.listPage("a");
    assert.deepEqual(seen.map(value => value[2]), [null, null, null, '"v1"']);
  } finally { await catalog.dispose(); }
});

test("idle expiry, LRU, total bytes, per-page bytes and missing ETags bound representation reuse", async () => {
  let now = 0;
  const seen: Array<[number, string | null]> = [];
  const catalog = new GitHubRepositoryCatalog(async (url, options) => {
    const n = Number(new URL(url).searchParams.get("page")); seen.push([n, new Headers(options.headers).get("if-none-match")]);
    return response(page(n === 4 ? "x".repeat(1000) : "small"), 200, n === 5 ? {} : { etag: '"v1"' });
  }, { now: () => now, idleTtlMs: 10, maxPages: 2, maxBytes: 1000, maxPageBytes: 500 });
  try {
    for (const n of [1, 2, 1, 3, 2, 4, 4, 5, 5]) await catalog.listPage("token", n);
    assert.deepEqual(seen.map(value => value[1]), [null, null, '"v1"', null, null, null, null, null, null]);
    now = 20; await catalog.listPage("token", 2); assert.equal(seen.at(-1)![1], null);
  } finally { await catalog.dispose(); }
});

for (const status of [401, 403]) {
  test(`HTTP ${status} invalidates every cached page for that OAuth identity`, async () => {
    let failing = false; const validators: Array<string | null> = [];
    const catalog = new GitHubRepositoryCatalog(async (_url, options) => {
      validators.push(new Headers(options.headers).get("if-none-match")); return response(page(), failing ? status : 200, { etag: '"v1"' });
    });
    try {
      await catalog.listPage("token", 1); await catalog.listPage("token", 2); failing = true;
      await assert.rejects(catalog.listPage("token", 1), error => (error as RepositoryCatalogError).kind === "authentication");
      failing = false; await catalog.listPage("token", 2); assert.equal(validators.at(-1), null);
    } finally { await catalog.dispose(); }
  });
}

test("rate-limit cooldown prevents another request until Retry-After/reset expires", async () => {
  let now = 100_000, calls = 0;
  const catalog = new GitHubRepositoryCatalog(async () => { calls++; return calls === 1 ? response(undefined, 429, { "retry-after": "2" }) : response(page()); }, { now: () => now });
  try {
    await assert.rejects(catalog.listPage("token"), error => (error as RepositoryCatalogError).kind === "rate-limit");
    await assert.rejects(catalog.listPage("token"), error => (error as RepositoryCatalogError).kind === "rate-limit"); assert.equal(calls, 1);
    now += 2001; assert.equal((await catalog.listPage("token")).repositories.length, 1); assert.equal(calls, 2);
  } finally { await catalog.dispose(); }
});

test("same-page singleflight isolates subscriber cancellation and disposes only its owned pending work", async () => {
  const result = deferred<any>(); let calls = 0, worker: AbortSignal | null | undefined;
  const catalog = new GitHubRepositoryCatalog(async (_url, options) => { calls++; worker = options.signal; return result.promise; });
  const abort = new AbortController(), a = catalog.listPage("token", 1, abort.signal), b = catalog.listPage("token");
  const rejection = assert.rejects(a, error => (error as RepositoryCatalogError).kind === "cancelled");
  await tick(); abort.abort(); await rejection;
  assert.equal(worker?.aborted, false); assert.equal(calls, 1);
  result.resolve(response(page())); assert.equal((await b).repositories.length, 1); await catalog.dispose();
});

test("catalog dispose aborts the final active fetch, waits for cleanup and rejects future reads", async () => {
  let closed = false;
  const started = deferred<void>();
  const catalog = new GitHubRepositoryCatalog(async (_url, options) => {
    started.resolve();
    await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => setTimeout(() => { closed = true; resolve(); }, 10), { once: true }));
    throw new Error("fixture private connection");
  });
  const loading = catalog.listPage("token"), rejection = assert.rejects(loading, error => (error as RepositoryCatalogError).kind === "cancelled");
  await started.promise; await catalog.dispose(); await rejection; assert(closed);
  await assert.rejects(catalog.listPage("token"), error => (error as RepositoryCatalogError).kind === "cancelled");
});

for (const primary of [true, false]) {
  test(`${primary ? "primary reset" : "secondary body"} rate limit establishes the right cooldown`, async () => {
    let now = 100_000, calls = 0;
    const catalog = new GitHubRepositoryCatalog(async () => {
      calls++; return calls === 1 ? response({ message: "You have exceeded a secondary rate limit." }, 403,
        primary ? { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "102" } : {}) : response(page());
    }, { now: () => now });
    try {
      await assert.rejects(catalog.listPage("token"), error => (error as RepositoryCatalogError).kind === "rate-limit");
      await assert.rejects(catalog.listPage("token"), error => (error as RepositoryCatalogError).kind === "rate-limit"); assert.equal(calls, 1);
      now += primary ? 2001 : 60_001; await catalog.listPage("token"); assert.equal(calls, 2);
    } finally { await catalog.dispose(); }
  });
}

test("total representation bytes evict an older page even below the page-count limit", async () => {
  const validators: Array<string | null> = [];
  const catalog = new GitHubRepositoryCatalog(async (_url, options) => {
    validators.push(new Headers(options.headers).get("if-none-match")); return response(page(), 200, { etag: '"v1"' });
  }, { maxPages: 32, maxBytes: 500, maxPageBytes: 1000 });
  try {
    await catalog.listPage("token", 1); await catalog.listPage("token", 1); await catalog.listPage("token", 2); await catalog.listPage("token", 1);
    assert.deepEqual(validators, [null, '"v1"', null, null]);
  } finally { await catalog.dispose(); }
});

test("304 without a new Link cannot hide a newly available tail behind an old full terminal page", async () => {
  let calls = 0;
  const catalog = new GitHubRepositoryCatalog(async () => ++calls === 1
    ? response(Array.from({ length: 100 }, (_, index) => ({ full_name: `owner/repo-${index}` })), 200, { etag: '"v1"' }) : response(undefined, 304));
  try { assert.equal((await catalog.listPage("token")).nextPage, undefined); assert.equal((await catalog.listPage("token")).nextPage, 2); }
  finally { await catalog.dispose(); }
});

test("idle private representations are released by the owned timer without another UI request", async () => {
  const catalog = new GitHubRepositoryCatalog(async () => response(page(), 200, { etag: '"v1"' }), { idleTtlMs: 15 });
  try {
    await catalog.listPage("token"); assert.equal(catalog.metrics().cachePages, 1);
    await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(catalog.metrics().cachePages, 0);
  } finally { await catalog.dispose(); }
});

test("HTTP failures release their unread fetch body before returning to the picker", async () => {
  let closed = false;
  const catalog = new GitHubRepositoryCatalog(async () => ({ ...response(undefined, 401), body: { async cancel() {
    await new Promise(resolve => setTimeout(resolve, 10)); closed = true;
  } } }));
  try {
    await assert.rejects(catalog.listPage("token"), error => (error as RepositoryCatalogError).kind === "authentication");
    assert(closed);
  } finally { await catalog.dispose(); }
});
