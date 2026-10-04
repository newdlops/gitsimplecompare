import assert from "node:assert/strict";
import test from "node:test";
import { SharedGitRead } from "../src/git/sharedGitRead";

/** 실제 loader의 완료만 제어하며 공유 서비스의 세대 판단은 제품 코드를 실행한다. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}

/** 실제 외부 변경은 이미 force로 시작한 조회 뒤에도 최신 pass를 요구한다. */
test("observed change after a forced read starts cannot accept its stale result", async () => {
  const first = deferred<string>(), next = deferred<string>(); let calls = 0;
  const shared = new SharedGitRead(async () => { calls++; return calls === 1 ? first.promise : next.promise; }, value => value);
  const graph = shared.read({ force: true });
  await Promise.resolve();
  assert.equal(calls, 1);
  const tab = shared.read({ force: true, changed: true });
  first.resolve("stale");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2, "Observed changes require a follow-up beyond an already forced generation.");
  next.resolve("latest");
  assert.deepEqual(await Promise.all([graph, tab]), ["latest", "latest"]);
  await shared.dispose();
});

/** loader 시작 전 알림들과 이전 pass 뒤 예약된 알림들은 한 최신 실행으로 합친다. */
test("observed changes coalesce before a loader starts and while its latest pass is queued", async () => {
  const first = deferred<string>(), next = deferred<string>(); let calls = 0;
  const shared = new SharedGitRead(async () => { calls++; return calls === 1 ? first.promise : next.promise; }, value => value);
  const initial = [shared.read({ changed: true }), shared.read({ changed: true })];
  await Promise.resolve();
  assert.equal(calls, 1);
  const changed = Array.from({ length: 8 }, () => shared.read({ changed: true }));
  first.resolve("stale");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  next.resolve("latest");
  assert.deepEqual(await Promise.all([...initial, ...changed]), Array(10).fill("latest"));
  assert.equal(calls, 2);
  await shared.dispose();
});

/** 실제 공유 서비스의 loader 경계에서 결과 완료 순서만 제어한다. */
function fixture() {
  const reads: { signal: AbortSignal; resolve: (value: number) => void; reject: (error: Error) => void }[] = [];
  const service = new SharedGitRead<number>(signal => new Promise((resolve, reject) => { reads.push({ signal, resolve, reject }); }), value => value);
  return { reads, service };
}
const next = () => new Promise(resolve => setImmediate(resolve));

test("cancelling one consumer preserves another; the last release aborts the actual loader", async () => {
  const { reads, service } = fixture();
  const first = new AbortController(), second = new AbortController();
  const a = service.read({ signal: first.signal }), b = service.read({ signal: second.signal });
  await next(); assert.equal(reads.length, 1);
  const cancelled = assert.rejects(a, { name: "AbortError" }); first.abort(); await cancelled;
  assert.equal(reads[0].signal.aborted, false);
  reads[0].resolve(7); assert.equal(await b, 7);
  service.invalidate();
  const last = new AbortController(), pending = service.read({ signal: last.signal });
  await next(); const rejected = assert.rejects(pending, { name: "AbortError" }); last.abort(); await rejected;
  assert.equal(reads[1].signal.aborted, true); reads[1].reject(new DOMException("cancelled", "AbortError"));
  await service.dispose();
});

test("overlapping forced refreshes wait for one follow-up generation and discard the stale cache", async () => {
  const { reads, service } = fixture();
  const old = service.read(); await next();
  const fresh = Array.from({ length: 8 }, () => service.read({ force: true }));
  assert.equal(reads.length, 1);
  reads[0].resolve(1); await next(); assert.equal(reads.length, 2);
  reads[1].resolve(2);
  assert.equal(await old, 2); assert.deepEqual(await Promise.all(fresh), Array(8).fill(2));
  assert.equal(await service.read(), 2); assert.equal(reads.length, 2);
  await service.dispose();
});

test("mutation invalidation prevents late results from becoming the latest snapshot", async () => {
  const { reads, service } = fixture();
  const pending = service.read(); await next(); service.invalidate(); reads[0].resolve(1);
  await next(); assert.equal(reads.length, 2); reads[1].resolve(9);
  assert.equal(await pending, 9); assert.equal(await service.read(), 9);
  await service.dispose();
});

test("a new consumer can cancel while a released process is still stopping", async () => {
  const { reads, service } = fixture(), first = new AbortController();
  const pending = service.read({ signal: first.signal }); await next();
  const firstCancelled = assert.rejects(pending, { name: "AbortError" }); first.abort(); await firstCancelled;
  const waiting = new AbortController(), nextRead = service.read({ signal: waiting.signal });
  const nextCancelled = assert.rejects(nextRead, { name: "AbortError" }); waiting.abort();
  let timer: ReturnType<typeof setTimeout>;
  try { await Promise.race([nextCancelled, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Cancellation waited for old process close.")), 200); })]); }
  finally { clearTimeout(timer!); reads[0].reject(new DOMException("cancelled", "AbortError")); await service.dispose(); }
});
