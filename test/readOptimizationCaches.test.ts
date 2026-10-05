import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fileIO from "node:fs/promises";
import { mapWithConcurrency } from "../src/utils/mapWithConcurrency";
import { LruCache } from "../src/utils/lruCache";
import { ScopedGitReadCache } from "../src/git/scopedGitReadCache";
import { clearUntrackedStatsCache, countUntrackedLines, untrackedStatsCacheStats } from "../src/git/untrackedStats";
import { GitLogService, ONGOING_COMMIT_HASH } from "../src/git/gitLogService";
import { DiffHunkService } from "../src/git/diffHunkService";
import { safetyFixture } from "./helpers/gitSafetyFixture";

/** 고정 sleep 없이 현재 비동기 loader가 시작할 기회를 제공한다. */
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("bounded file workers retain all inputs in order under out-of-order completions", async () => {
  let active = 0, peak = 0;
  const input = Array.from({ length: 1000 }, (_, i) => i);
  const output = await mapWithConcurrency(input, 4, async item => {
    peak = Math.max(peak, ++active);
    await settle(); active--; return item * 2;
  });
  assert.equal(peak, 4); assert.deepEqual(output, input.map(i => i * 2)); assert.equal(active, 0);
});

test("cancellation starts no more file tasks and waits for already owned workers to settle", async () => {
  const controller = new AbortController(); let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const read = mapWithConcurrency(Array(100).fill(0), 4, async () => { calls++; await gate; }, controller.signal);
  const rejected = assert.rejects(read, { name: "AbortError" });
  await settle(); controller.abort(); let finished = false; void rejected.then(() => { finished = true; });
  await settle(); assert.equal(finished, false); assert.equal(calls, 4);
  release(); await rejected; assert.equal(calls, 4);
});

test("LRU count and byte limits include replacements and protect recently read small entries", () => {
  const cache = new LruCache<string, string>(3, 12, (key, value) => key.length + value.length);
  cache.set("a", "111"); cache.set("b", "222"); cache.set("c", "333"); cache.get("a"); cache.set("d", "444");
  assert.equal(cache.get("b"), undefined); assert.equal(cache.get("a"), "111");
  cache.set("a", "12345"); assert.ok(cache.stats().bytes <= 12);
  cache.set("oversized", "x".repeat(50)); assert.equal(cache.get("oversized"), undefined);
  cache.clear(); assert.equal(cache.stats().entries, 0); assert.equal(cache.stats().bytes, 0);
});

test("one hunk file invalidation preserves cached and active readers of other files", async () => {
  const cache = new ScopedGitReadCache<number>(4); const signals: AbortSignal[] = [];
  const resolvers: Array<(value: number) => void> = [];
  const loader = (signal: AbortSignal) => { signals.push(signal); return new Promise<number>(resolve => { resolvers.push(resolve); }); };
  const a = cache.read("a:unstaged", "a", loader), shared = cache.read("a:unstaged", "a", loader);
  const b = cache.read("b:staged", "b", loader); const observed = Promise.allSettled([a, shared]);
  await settle(); assert.equal(signals.length, 2); cache.invalidate("a");
  assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
  resolvers[0](1); resolvers[1](2);
  assert.ok((await observed).every(result => result.status === "rejected")); assert.equal(await b, 2);
  assert.equal(await cache.read("b:staged", "b", loader), 2); assert.equal(signals.length, 2);
  assert.equal(await cache.read("a:unstaged", "a", async () => 3), 3);
  cache.invalidate(); assert.equal(cache.size(), 0);
});

test("shared hunk consumer cancellation, errors and LRU eviction are independent", async () => {
  const cache = new ScopedGitReadCache<number>(2); const controller = new AbortController();
  let release!: (value: number) => void, signal!: AbortSignal, calls = 0;
  const loader = (owned: AbortSignal) => { calls++; signal = owned; return new Promise<number>(resolve => { release = resolve; }); };
  const first = cache.read("a", "a", loader, controller.signal), second = cache.read("a", "a", loader);
  const rejected = assert.rejects(first, { name: "AbortError" }); await settle(); controller.abort(); await rejected;
  assert.equal(signal.aborted, false); release(1); assert.equal(await second, 1); assert.equal(calls, 1);
  await assert.rejects(cache.read("failed", "f", async () => { throw new Error("fixture failure"); }), /fixture failure/);
  assert.equal(await cache.read("failed", "f", async () => 2), 2);
  await cache.read("c", "c", async () => 3); assert.equal(cache.size(), 2);
  assert.equal(await cache.read("a", "a", async () => ++calls), 2); cache.invalidate();
});

test("a file invalidation waits for actual predecessor close before spawning its replacement", async () => {
  const cache = new ScopedGitReadCache<number>(); let close!: (value: number) => void, calls = 0;
  const old = cache.read("a", "file", async () => new Promise<number>(resolve => { close = resolve; }));
  const observed = assert.rejects(old, { name: "AbortError" }); await settle(); cache.invalidate("file"); await observed;
  const replacement = cache.read("a", "file", async () => ++calls); await settle(); assert.equal(calls, 0);
  close(1); assert.equal(await replacement, 1); assert.equal(calls, 1); cache.invalidate();
});

test("long-lived untracked stats obey both count and memory caps while returning all values", async t => {
  const root = await mkdtemp(join(tmpdir(), "gsc-untracked-limit-")); t.after(() => rm(root, { recursive: true, force: true }));
  clearUntrackedStatsCache(); t.after(clearUntrackedStatsCache);
  const files = Array.from({ length: 4300 }, (_, i) => `new-${i}.txt`);
  await mapWithConcurrency(files, 4, async file => writeFile(join(root, file), "one\n"));
  const values = await mapWithConcurrency(files, 4, file => countUntrackedLines(root, file));
  assert.equal(values.length, files.length); assert.ok(values.every(value => value === 1));
  const stats = untrackedStatsCacheStats(); assert.ok(stats.entries <= 4096); assert.ok(stats.bytes <= 1024 * 1024); assert.ok(stats.evictions > 0);
});

test("untracked stats distinguish replaced files with the same size and mtime and discard missing paths", async t => {
  const root = await mkdtemp(join(tmpdir(), "gsc-untracked-cache-")); t.after(() => rm(root, { recursive: true, force: true }));
  clearUntrackedStatsCache(); t.after(clearUntrackedStatsCache);
  const file = join(root, "new.txt"), when = new Date("2020-01-01T00:00:00Z");
  await writeFile(file, "a\nb\n"); await utimes(file, when, when); assert.equal(await countUntrackedLines(root, "new.txt"), 2);
  await writeFile(join(root, "replacement"), "abc\n"); await utimes(join(root, "replacement"), when, when);
  await rename(join(root, "replacement"), file); assert.equal(await countUntrackedLines(root, "new.txt"), 1);
  await rm(file); assert.equal(await countUntrackedLines(root, "new.txt"), undefined); assert.equal(untrackedStatsCacheStats().entries, 0);
});

test("virtual commit detail retains every untracked file and exact additions under bounded IO", async t => {
  const { root } = await safetyFixture(t, "untracked-all-files");
  const names = Array.from({ length: 350 }, (_, i) => `untracked-${String(i).padStart(4, "0")}.txt`);
  await mapWithConcurrency(names, 4, async name => writeFile(join(root, name), "one\ntwo\n"));
  let active = 0, peak = 0, reads = 0;
  const originalRead = fileIO.readFile;
  t.mock.method(fileIO, "readFile", async (...args: Parameters<typeof fileIO.readFile>) => {
    reads++; peak = Math.max(peak, ++active);
    try { return await originalRead(...args); } finally { active--; }
  });
  const detail = await new GitLogService(root).getCommitDetail(ONGOING_COMMIT_HASH);
  assert.deepEqual(detail.files.map(file => file.path), names);
  assert.ok(detail.files.every(file => file.additions === 2 && file.deletions === 0));
  assert.equal(reads, names.length); assert.ok(peak <= 4); assert.equal(active, 0);
  reads = 0; peak = 0;
  const hunks = await new DiffHunkService(root).getWorkingDiff();
  assert.deepEqual(hunks.map(file => file.path), names);
  assert.equal(reads, names.length); assert.ok(peak <= 4);
  assert.ok(hunks.every(file => file.hunks.length === 1 && !file.binary));
  assert.ok(untrackedStatsCacheStats().bytes <= 1024 * 1024); clearUntrackedStatsCache();
});
