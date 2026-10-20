import assert from "node:assert/strict";
import test from "node:test";
import { GitTagService, invalidateRemoteTagCache, type GitTagRunner } from "../src/git/gitTagService";
import { REMOTE_TAG_CACHE_LIMIT } from "../src/git/remoteTagReads";

/** Git 실행을 막지 않고 pending loader와 소비자 listener가 등록될 때까지 진행한다. */
async function settle(): Promise<void> { for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setImmediate(resolve)); }

test("already-cancelled tag requests start no local, remote-list or network reads", async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  const service = new GitTagService("/tag-cancel-before", async () => { calls++; return ""; });
  await assert.rejects(service.getTagStatuses({ signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(service.getRemoteTagRefs({ signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(service.getLocalTagRefs(controller.signal), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("one cancelled consumer preserves the shared read and the last consumer waits for close", async () => {
  let remoteReads = 0, remoteSignal!: AbortSignal, close!: () => void, release!: (value: string) => void;
  const closed = new Promise<void>(resolve => { close = resolve; });
  const runner: GitTagRunner = async (args, _root, options) => {
    if (args[0] === "remote") return "origin\n";
    remoteReads++; remoteSignal = options!.signal!;
    return new Promise<string>((resolve, reject) => {
      release = resolve;
      remoteSignal.addEventListener("abort", () => { void closed.then(() => reject(new DOMException("cancelled", "AbortError"))); }, { once: true });
    });
  };
  const service = new GitTagService("/tag-cancel-shared", runner), one = new AbortController(), two = new AbortController();
  const first = service.getRemoteTagRefs({ signal: one.signal });
  const second = service.getRemoteTagRefs({ signal: two.signal });
  const firstError = assert.rejects(first, { name: "AbortError" });
  let secondFinished = false;
  const secondError = assert.rejects(second, { name: "AbortError" }).then(() => { secondFinished = true; });
  try {
    await settle(); assert.equal(remoteReads, 1);
    one.abort(); await firstError; assert.equal(remoteSignal.aborted, false);
    two.abort(); await settle(); assert.equal(remoteSignal.aborted, true); assert.equal(secondFinished, false);
    close(); await secondError;
    const fresh = service.getRemoteTagRefs(); await settle(); assert.equal(remoteReads, 2);
    release("new\trefs/tags/fresh\n"); assert.equal((await fresh)[0].name, "fresh");
  } finally { one.abort(); two.abort(); close(); release?.(""); await Promise.allSettled([first, second]); }
});

test("cancellation stops queued remotes and awaits every started worker", async () => {
  const controller = new AbortController(); let started = 0, active = 0, peak = 0;
  const runner: GitTagRunner = async (args, _root, options) => {
    if (args[0] === "remote") return Array.from({ length: 40 }, (_, i) => `remote-${i}`).join("\n");
    started++; active++; peak = Math.max(peak, active);
    try { return await new Promise<string>((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }); } finally { active--; }
  };
  const pending = new GitTagService("/tag-workers-cancel", runner).getRemoteTagRefs({ signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  try { await settle(); assert.equal(started, 4); controller.abort(); await rejected; }
  finally { controller.abort(); await Promise.allSettled([pending]); }
  assert.equal(peak, 4); assert.equal(active, 0); assert.equal(started, 4);
});

test("bounded workers return every successful remote while an authentication failure preserves local tags", async () => {
  let active = 0, peak = 0;
  const runner: GitTagRunner = async args => {
    if (args[0] === "remote") return Array.from({ length: 9 }, (_, i) => `remote-${i}`).join("\n");
    if (args[0] === "for-each-ref") return "local\0\0local-hash\n";
    active++; peak = Math.max(peak, active);
    try {
      await settle(); if (args[2] === "remote-3") throw new Error("authentication unavailable");
      return `hash\trefs/tags/${args[2]}\n`;
    } finally { active--; }
  };
  const statuses = await new GitTagService("/tag-workers-complete", runner).getTagStatuses();
  assert.equal(statuses.length, 9); assert.equal(peak, 4); assert.equal(active, 0);
  assert.equal(statuses.find(tag => tag.name === "local")?.localHash, "local-hash");
});

test("forced concurrent reads coalesce and caller mutations do not change completed tags", async () => {
  let reads = 0, release!: (value: string) => void;
  const runner: GitTagRunner = async args => args[0] === "remote" ? "origin\n" :
    (reads++, new Promise<string>(resolve => { release = resolve; }));
  const service = new GitTagService("/tag-force-pending", runner);
  const one = service.getRemoteTagRefs(); await settle();
  const two = service.getRemoteTagRefs({ forceRemote: true }); await settle();
  assert.equal(reads, 1); release("hash\trefs/tags/v1\n");
  const first = await one; first[0].hash = "caller-change";
  assert.equal((await two)[0].hash, "hash");
  assert.equal((await service.getRemoteTagRefs())[0].hash, "hash"); assert.equal(reads, 1);
});

test("cache pressure evicts old completed values while protecting an active shared consumer", async () => {
  let reads = 0, release!: (value: string) => void;
  const counts = new Map<string, number>();
  const runner: GitTagRunner = async (args, root) => {
    if (args[0] === "remote") return "origin\n";
    reads++; counts.set(root, (counts.get(root) ?? 0) + 1);
    if (root === "/tag-protected" && counts.get(root) === 1) return new Promise(resolve => { release = resolve; });
    return "hash\trefs/tags/v1\n";
  };
  const protectedService = new GitTagService("/tag-protected", runner), pending = protectedService.getRemoteTagRefs();
  await settle();
  for (let i = 0; i <= REMOTE_TAG_CACHE_LIMIT; i++) await new GitTagService(`/tag-pressure-${i}`, runner).getRemoteTagRefs();
  const another = protectedService.getRemoteTagRefs(); await settle();
  assert.equal(counts.get("/tag-protected"), 1); release("hash\trefs/tags/protected\n");
  assert.deepEqual(await pending, await another);
  await new GitTagService("/tag-pressure-0", runner).getRemoteTagRefs();
  assert.equal(counts.get("/tag-pressure-0"), 2);
  assert.ok(reads > REMOTE_TAG_CACHE_LIMIT);
});

test("TTL expiry and explicit invalidation still read fresh remote values", async t => {
  let now = Date.now(), reads = 0; t.mock.method(Date, "now", () => now);
  const runner: GitTagRunner = async args => args[0] === "remote" ? "origin\n" : `${++reads}\trefs/tags/v1\n`;
  const service = new GitTagService("/tag-ttl", runner);
  assert.equal((await service.getRemoteTagRefs())[0].hash, "1"); now += 300001;
  assert.equal((await service.getRemoteTagRefs())[0].hash, "2");
  invalidateRemoteTagCache("/tag-ttl"); assert.equal((await service.getRemoteTagRefs())[0].hash, "3");
});
