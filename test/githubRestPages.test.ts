import assert from "node:assert/strict";
import test from "node:test";
import { GitHubReadRuntime } from "../src/git/githubReadRuntime";
import { GitHubReadCache } from "../src/git/githubReadCache";
import { restRead } from "../src/git/githubReadRequest";
import type { GitHubReadSessionState } from "../src/git/githubReadSession";
import * as pageProtocol from "../src/git/githubRestPages";

/** 네트워크와 실제 인증을 사용하지 않는 CLI 고정 canonical 문맥이다. */
function session(): GitHubReadSessionState {
  return { root: "/repo", env: { GH_TOKEN: "fixture-token" }, context: "fixture",
    scope: { host: "github.com", name: "owner/repo", owner: "owner", repository: "repo" } };
}

test("opt-in CLI pages preserve final Link while dropping secret response headers", async () => {
  const path = "/repos/owner/repo/issues?per_page=100&page=1";
  const link = '<https://api.github.com/repos/owner/repo/issues?per_page=100&page=2>; rel="next"';
  const seen: string[][] = [];
  const runtime = new GitHubReadRuntime({ policy: async () => ({ transport: "cli", systemProxy: "none" }),
    cli: async args => {
      seen.push([...args]);
      return 'HTTP/2.0 200 OK\r\nLink: ' + link + '\r\nETag: "page-1"\r\nSet-Cookie: fixture-secret\r\nAuthorization: fixture-secret\r\n\r\n[{"id":7}]';
    } });
  try {
    const read = restRead(path), request = { ...read.request, responseMode: "page" as const };
    const value = await runtime.execute(read.args, "/repo", { operation: "fixture-page", request, readSession: session() });
    assert(seen[0].includes("--include"), "Page CLI reads must request response metadata");
    assert.deepEqual(JSON.parse(value), { __gscRestPage: 1, body: '[{"id":7}]', metadata: { status: 200, link, etag: '"page-1"' } });
    assert(!value.includes("fixture-secret"));
  } finally { await runtime.dispose(); }
});

test("body-only CLI reads keep their original argument and response contract", async () => {
  let args: readonly string[] = [];
  const runtime = new GitHubReadRuntime({ policy: async () => ({ transport: "cli", systemProxy: "none" }),
    cli: async values => { args = values; return '[{"id":7}]'; } });
  try {
    const read = restRead("/repos/owner/repo/issues");
    assert.equal(await runtime.execute(read.args, "/repo", { operation: "fixture-body", request: read.request, readSession: session() }), '[{"id":7}]');
    assert.deepEqual(args, ["api", "repos/owner/repo/issues"]);
  } finally { await runtime.dispose(); }
});

test("completed cache distinguishes page metadata from body-only reads", async () => {
  let executions = 0;
  const cache = new GitHubReadCache(async (_args, _root, options) => {
    executions++;
    return (options.request as { responseMode?: string })?.responseMode === "page" ? "page-value" : "body-value";
  });
  const body = restRead("/repos/owner/repo/issues"), page = { ...body.request, responseMode: "page" as const };
  const options = { operation: "fixture-format", ttlMs: 60_000, env: { GH_TOKEN: "fixture-token" } };
  try {
    assert.equal(await cache.read(body.args, "/repo", { ...options, request: body.request }), "body-value");
    assert.equal(await cache.read(body.args, "/repo", { ...options, request: page }), "page-value");
    assert.equal(executions, 2);
  } finally { await cache.dispose(); }
});

test("in-flight page readers cannot receive a coalesced body-only response", async () => {
  let started = 0;
  const release: Array<() => void> = [];
  const cache = new GitHubReadCache(async (_args, _root, options) => {
    started++;
    await new Promise<void>(resolve => release.push(resolve));
    return options.request?.kind === "rest" && options.request.responseMode === "page" ? "page-value" : "body-value";
  });
  const body = restRead("/repos/owner/repo/issues"), page = { ...body.request, responseMode: "page" as const };
  const options = { operation: "fixture-format", env: { GH_TOKEN: "fixture-token" } };
  const first = cache.read(body.args, "/repo", { ...options, request: body.request });
  const second = cache.read(body.args, "/repo", { ...options, request: page });
  try {
    const deadline = Date.now() + 1000;
    while (started < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(started, 2);
    release.forEach(resolve => resolve());
    assert.deepEqual(await Promise.all([first, second]), ["body-value", "page-value"]);
  } finally { release.forEach(resolve => resolve()); await cache.dispose(); }
});

test("a page envelope decodes to the original JSON data without exposing response secrets", () => {
  const raw = JSON.stringify({ __gscRestPage: 1, body: '[{"id":7}]', metadata: { status: 200, etag: "v1", authorization: "fixture-secret" } });
  assert.deepEqual(pageProtocol.decodeRestPage?.(raw), { data: [{ id: 7 }], metadata: { status: 200, etag: "v1" } });
  assert.deepEqual(pageProtocol.decodeRestPage?.('[{"id":7}]'), { data: [{ id: 7 }] });
});

test("known final-page headers avoid an empty tail at exact page-size boundaries", () => {
  const path = "/repos/owner/repo/issues?per_page=100&page=1";
  for (const length of [0, 99, 100]) {
    const page = { data: Array.from({ length }, () => ({ id: 7 })), metadata: { status: 200 } };
    assert.equal(pageProtocol.nextRestPage?.(page, path, 1), undefined);
  }
  const full = { data: Array.from({ length: 100 }, () => ({ id: 7 })) };
  assert.equal(pageProtocol.nextRestPage?.(full, path, 1), 2, "Headerless runners must retain the length fallback");
});

test("a valid next Link advances exactly one page without following another endpoint", () => {
  const path = "/repos/owner/repo/issues?per_page=100&page=1";
  const metadata = { status: 200, link: '<https://api.github.com/repos/owner/repo/issues?page=2&per_page=100>; rel="next", <https://api.github.com/repos/owner/repo/issues?per_page=100&page=4>; rel="last"' };
  assert.equal(pageProtocol.nextRestPage?.({ data: [{ id: 7 }], metadata }, path, 1), 2);
});

test("Enterprise CLI readers validate Link against their explicit trusted API base", () => {
  const page = { data: [{ id: 7 }], metadata: { status: 200,
    link: '<https://ghe.example/api/v3/repos/owner/repo/issues?per_page=100&page=2>; rel="next"' } };
  assert.equal(pageProtocol.nextRestPage(page, "/repos/owner/repo/issues?per_page=100&page=1", 1, 100, "https://ghe.example/api/v3"), 2);
});

test("all page-size boundaries preserve every item without a fabricated terminal request", () => {
  const fixtures = [
    { sizes: [0], items: 0, calls: 1 }, { sizes: [99], items: 99, calls: 1 },
    { sizes: [100], items: 100, calls: 1 }, { sizes: [100, 1], items: 101, calls: 2 },
    { sizes: [100, 100], items: 200, calls: 2 },
    { sizes: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100], items: 1000, calls: 10 },
    { sizes: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 1], items: 1001, calls: 11 },
  ];
  for (const fixture of fixtures) {
    const received: number[] = [];
    let page = 1, calls = 0;
    for (;;) {
      calls++;
      const data = Array.from({ length: fixture.sizes[page - 1] }, (_, index) => (page - 1) * 100 + index);
      const metadata = { status: 200, ...(page < fixture.sizes.length ? {
        link: `<https://api.github.com/items?per_page=100&page=${page + 1}>; rel="next"` } : {}) };
      const decoded = pageProtocol.decodeRestPage<number[]>(pageProtocol.encodeRestPage(JSON.stringify(data), metadata));
      received.push(...decoded.data);
      const next = pageProtocol.nextRestPage(decoded, `/items?per_page=100&page=${page}`, page);
      if (!next) break;
      page = next;
    }
    assert.equal(received.length, fixture.items); assert.equal(new Set(received).size, fixture.items);
    assert.equal(calls, fixture.calls);
  }
});

test("CLI informational and redirect headers never replace the final page metadata", () => {
  const value = pageProtocol.normalizeRestPageCli('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 301 Moved\r\nLocation: /elsewhere\r\nSet-Cookie: fixture-secret\r\n\r\nHTTP/2.0 200 OK\r\nETag: final\r\n\r\n[]');
  assert.deepEqual(pageProtocol.decodeRestPage(value), { data: [], metadata: { status: 200, etag: "final" } });
  assert(!value.includes("fixture-secret"));
});

test("unsafe, repeated, skipped and conflicting next-page URLs fail without leaking their value", () => {
  const path = "/repos/owner/repo/issues?per_page=100&page=1";
  for (const next of ["https://evil.invalid/fixture-secret?page=2", "https://api.github.com/another?page=2",
    "https://api.github.com/repos/owner/repo/issues?per_page=100&page=1",
    "https://api.github.com/repos/owner/repo/issues?per_page=100&page=3",
    "https://api.github.com/repos/owner/repo/issues?per_page=50&page=2",
    "https://api.github.com/repos/owner/repo/issues?per_page=100&page=2&page=2"]) {
    assert.throws(() => pageProtocol.nextRestPage?.({ data: [], metadata: { status: 200, link: `<${next}>; rel="next"` } }, path, 1), error => {
      assert.equal((error as { reason?: string }).reason, "pagination");
      assert(!String(error).includes("fixture-secret")); return true;
    });
  }
});

test("invalid JSON and corrupt envelopes fail with a safe typed reason", () => {
  for (const raw of ["fixture-private-body", '{"__gscRestPage":2}', '{"__gscRestPage":1,"body":"[]","metadata":{"status":304}}']) {
    assert.throws(() => pageProtocol.decodeRestPage?.(raw), error => {
      assert.equal((error as { kind?: string }).kind, "rest-page");
      assert(!String(error).includes("fixture-private-body")); return true;
    });
  }
});
