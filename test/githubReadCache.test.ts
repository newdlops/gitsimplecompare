import assert from "node:assert/strict";
import test from "node:test";
import { GitHubReadCache } from "../src/git/githubReadCache";

/** 시간 대기 없이 동시에 활성화된 원격 조회를 제어할 promise다. */
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
/** queued worker가 다음 요청을 시작할 때까지 microtask를 소비한다. */
function settle(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }

/** 비동기 metadata 검사 뒤 실제 실행이 시작됐는지 제한 시간 안에 관찰한다. */
async function waitFor(condition: () => boolean): Promise<void> {
  const until = Date.now() + 2000;
  while (!condition()) {
    assert.ok(Date.now() < until, "execution did not reach the expected state");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test("three consumers share one read and cancelling one keeps the other two", async () => {
  const response = deferred<string>(); let calls = 0; let signal: AbortSignal | undefined;
  const cache = new GitHubReadCache(async (_args, _root, options) => { calls++; signal = options.signal; return response.promise; });
  const controller = new AbortController();
  const one = cache.read(["api", "same"], "/repo", { operation: "test", signal: controller.signal, ttlMs: 1000 });
  const two = cache.read(["api", "same"], "/repo", { operation: "test", ttlMs: 1000 });
  const three = cache.read(["api", "same"], "/repo", { operation: "test", ttlMs: 1000 });
  await settle(); controller.abort();
  await assert.rejects(one, /cancelled/); assert.equal(signal?.aborted, false);
  response.resolve("value"); assert.deepEqual(await Promise.all([two, three]), ["value", "value"]);
  assert.equal(await cache.read(["api", "same"], "/repo", { operation: "test", ttlMs: 1000 }), "value");
  assert.equal(calls, 1);
});

test("the global read queue never exceeds four active requests", async () => {
  const reads: Array<ReturnType<typeof deferred<string>>> = []; let active = 0, maximum = 0;
  const cache = new GitHubReadCache(async () => {
    const response = deferred<string>(); reads.push(response); active++; maximum = Math.max(maximum, active);
    try { return await response.promise; } finally { active--; }
  });
  const results = Array.from({ length: 15 }, (_, n) => cache.read(["api", String(n)], "/repo", { operation: "test" }));
  await waitFor(() => reads.length === 4); assert.equal(reads.length, 4);
  for (let n = 0; n < 15; n++) { await waitFor(() => reads.length > n); reads[n].resolve("ok"); await settle(); }
  await Promise.all(results); assert.equal(maximum, 4);
});

test("last consumer cancellation aborts the process and queued cancelled reads never start", async () => {
  const signals: AbortSignal[] = []; let calls = 0;
  const cache = new GitHubReadCache(async (_args, _root, { signal }) => {
    calls++; signals.push(signal!);
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
  });
  const controller = new AbortController();
  const pending = Array.from({ length: 9 }, (_, n) => cache.read([String(n)], "/repo", { operation: "test", signal: controller.signal }));
  const results = Promise.allSettled(pending);
  await settle(); controller.abort(); await results;
  assert.equal(calls, 4); assert.ok(signals.every(signal => signal.aborted));
});

test("errors and timeouts do not poison retries, and head versions do not share responses", async () => {
  let calls = 0;
  const cache = new GitHubReadCache(async () => { if (++calls === 1) return new Promise(() => {}); return String(calls); }, 10);
  await assert.rejects(cache.read(["api"], "/repo", { operation: "test", version: "old", ttlMs: 1000 }), /timed out/);
  assert.equal(await cache.read(["api"], "/repo", { operation: "test", version: "old", ttlMs: 1000 }), "2");
  assert.equal(await cache.read(["api"], "/repo", { operation: "test", version: "new", ttlMs: 1000 }), "3");
});

test("pre-cancelled reads and successful empty responses are handled without repeat calls", async () => {
  let calls = 0; const cache = new GitHubReadCache(async () => { calls++; return ""; });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(cache.read(["api"], "/repo", { operation: "test", signal: controller.signal }), /cancelled/);
  await cache.read(["api"], "/repo", { operation: "test", ttlMs: 1000 });
  await cache.read(["api"], "/repo", { operation: "test", ttlMs: 1000 });
  assert.equal(calls, 1);
});
