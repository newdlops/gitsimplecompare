import assert from "node:assert/strict";
import test from "node:test";
import { FileHistoryReadCache, type FileHistoryReader } from "../src/git/fileHistoryReadCache";
import type { FileHistoryEntry } from "../src/git/fileHistoryService";
import { FileHistoryDiskStorage } from "../src/git/fileHistoryStorage";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** 실제 캐시 schema를 통과하는 커밋을 만들어 반환 값의 독립성도 검증한다. */
function record(title = "Initial", hash = "a".repeat(40)): FileHistoryEntry {
  return { hash, shortHash: hash.slice(0, 7), baseRef: "b".repeat(40), title, message: `${title}\n`, author: "Author",
    dateIso: "2026-10-05T12:00:00Z", relativeDate: "1 hour ago", status: "M", path: "file.ts", additions: 3, deletions: 1 };
}

/** 완료/close 시점을 검사에서 직접 제어하는 promise다. */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

/** 시간 지연을 가정하지 않고 큐와 signal microtask가 진행될 때까지 기다린다. */
async function settle(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }

/** HEAD/config와 조회 횟수를 독립적으로 변경할 수 있는 실제 수명 경계 fake다. */
function fixture() {
  let key = "v1", revision = "a".repeat(40), logs = 0, dates = 0;
  const reader: FileHistoryReader = {
    context: async () => ({ key, revision }),
    history: async (_root, file, ref) => { logs++; return [{ ...record(file, ref), path: file }]; },
    dates: async (_root, entries) => { dates++; return entries.map(entry => ({ ...entry, relativeDate: "Current relative date" })); },
  };
  return { reader, change(next: string, head = revision) { key = next; revision = head; },
    counts: () => ({ logs, dates }) };
}

test("same HEAD/config reuses complete histories without clearing other files or exposing mutable cache objects", async t => {
  const f = fixture(), cache = new FileHistoryReadCache(f.reader); t.after(() => cache.dispose());
  assert.equal((await cache.read("/repo", "one.ts")).source, "git");
  await cache.read("/repo", "two.ts");
  const repeated = await cache.read("/repo", "one.ts");
  assert.equal(repeated.source, "memory"); assert.equal(repeated.commits[0].relativeDate, "Current relative date");
  repeated.commits[0].message = "consumer mutation";
  assert.notEqual((await cache.read("/repo", "one.ts")).commits[0].message, "consumer mutation");
  assert.deepEqual(f.counts(), { logs: 2, dates: 2 });
});

test("a new HEAD or history configuration invalidates only its version and force explicitly bypasses a cached result", async t => {
  const f = fixture(), cache = new FileHistoryReadCache(f.reader); t.after(() => cache.dispose());
  await cache.read("/repo", "file.ts");
  f.change("new-config"); assert.equal((await cache.read("/repo", "file.ts")).source, "git");
  f.change("new-head", "c".repeat(40)); assert.equal((await cache.read("/repo", "file.ts")).commits[0].hash, "c".repeat(40));
  await cache.read("/repo", "file.ts", { force: true });
  assert.deepEqual(f.counts(), { logs: 4, dates: 0 });
});

test("HEAD moving during history loading cannot publish or cache the older result", async t => {
  const f = fixture();
  const original = f.reader.history;
  f.reader.history = async (...args) => { const result = await original(...args); f.change("latest", "c".repeat(40)); return result; };
  const cache = new FileHistoryReadCache(f.reader); t.after(() => cache.dispose());
  const result = await cache.read("/repo", "file.ts");
  assert.equal(result.commits[0].hash, "c".repeat(40)); assert.equal(f.counts().logs, 2);
});

test("one consumer cancelling does not stop the same file while another consumer still needs it", async t => {
  const f = fixture(), gate = deferred<FileHistoryEntry[]>(); let cancelled = 0, calls = 0;
  f.reader.history = async (_root, _file, _ref, signal) => { calls++; signal.addEventListener("abort", () => cancelled++, { once: true }); return gate.promise; };
  const cache = new FileHistoryReadCache(f.reader); t.after(() => cache.dispose());
  const a = new AbortController(), b = new AbortController();
  const first = cache.read("/repo", "same.ts", { signal: a.signal }); const rejected = assert.rejects(first, { name: "AbortError" });
  const second = cache.read("/repo", "same.ts", { signal: b.signal });
  await settle(); a.abort(); await rejected;
  assert.equal(cancelled, 0); assert.equal(calls, 1);
  gate.resolve([record()]); assert.equal((await second).commits.length, 1);
});

test("last-consumer cancellation stops Git and a replacement waits for actual close before starting", async t => {
  const f = fixture(), close = deferred<FileHistoryEntry[]>(); let calls = 0, cancelled = false, running = 0, maximum = 0;
  f.reader.history = async (_root, _file, _ref, signal) => {
    calls++; running++; maximum = Math.max(maximum, running);
    try {
      if (calls === 1) { signal.addEventListener("abort", () => { cancelled = true; }, { once: true }); return await close.promise; }
      return [record()];
    } finally { running--; }
  };
  const cache = new FileHistoryReadCache(f.reader); t.after(() => cache.dispose());
  const consumer = new AbortController();
  const first = cache.read("/repo", "same.ts", { signal: consumer.signal }); const rejected = assert.rejects(first, { name: "AbortError" });
  await settle(); consumer.abort(); await rejected;
  assert.equal(cancelled, true);
  const next = cache.read("/repo", "same.ts"); await settle(); assert.equal(calls, 1);
  close.reject(new DOMException("actual process closed", "AbortError"));
  assert.equal((await next).commits.length, 1); assert.equal(maximum, 1); assert.equal(running, 0);
});

test("different files have only two actual histories running and cancelled queued work never starts", async t => {
  const f = fixture(), gates = [deferred<FileHistoryEntry[]>(), deferred<FileHistoryEntry[]>()];
  let running = 0, maximum = 0, calls = 0;
  f.reader.history = async () => { const number = calls++; running++; maximum = Math.max(maximum, running); try { return await gates[number].promise; } finally { running--; } };
  const cache = new FileHistoryReadCache(f.reader); t.after(() => cache.dispose());
  const first = cache.read("/repo", "first.ts"), second = cache.read("/repo", "second.ts"), controller = new AbortController();
  const queued = cache.read("/repo", "queued.ts", { signal: controller.signal }); const rejected = assert.rejects(queued, { name: "AbortError" });
  await settle(); assert.equal(calls, 2); controller.abort(); await rejected;
  for (const gate of gates) gate.resolve([record()]); await Promise.all([first, second]);
  assert.equal(calls, 2); assert.equal(maximum, 2); assert.equal(running, 0);
});

test("dispose cancels running and queued consumers and finishes only after owned history reads close", async () => {
  const f = fixture(); let active = 0;
  f.reader.history = async (_root, _file, _ref, signal) => {
    active++;
    try { return await new Promise<FileHistoryEntry[]>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("closed", "AbortError")), { once: true })); }
    finally { active--; }
  };
  const cache = new FileHistoryReadCache(f.reader);
  const pending = ["one", "two", "three"].map(file => cache.read("/repo", file));
  const observed = Promise.allSettled(pending); await settle(); assert.equal(active, 2);
  await cache.dispose(); assert.equal(active, 0);
  assert.ok((await observed).every(result => result.status === "rejected"));
  await assert.rejects(cache.read("/repo", "new"), { name: "AbortError" });
});

test("older histories are evicted after forty files without discarding active consumers", async t => {
  const f = fixture(), cache = new FileHistoryReadCache(f.reader); t.after(() => cache.dispose());
  for (let i = 0; i < 45; i++) await cache.read("/repo", `file-${i}`);
  await cache.read("/repo", "file-0"); assert.equal(f.counts().logs, 46);
  assert.equal((await cache.read("/repo", "file-44")).source, "memory");
});

test("a reopened reader restores a validated persistent history and corruption falls back to Git", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "gsc-history-store-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture(), store = new FileHistoryDiskStorage(directory);
  let cache = new FileHistoryReadCache(f.reader, () => true, () => undefined, store);
  await cache.read("/repo", "file.ts"); await cache.dispose();
  cache = new FileHistoryReadCache(f.reader, () => true, () => undefined, store); t.after(() => cache.dispose());
  assert.equal((await cache.read("/repo", "file.ts")).source, "disk"); assert.equal(f.counts().logs, 1);
  await cache.dispose(); await writeFile(path.join(directory, (await readdir(directory))[0]), "corrupt");
  cache = new FileHistoryReadCache(f.reader, () => true, () => undefined, store);
  assert.equal((await cache.read("/repo", "file.ts")).source, "git"); assert.equal(f.counts().logs, 2);
});
