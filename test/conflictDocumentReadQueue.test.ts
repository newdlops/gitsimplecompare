import assert from "node:assert/strict";
import test from "node:test";
import type { ConflictDocument, ConflictService } from "../src/git/conflictService";
import { ConflictDocumentReadQueue } from "../src/providers/conflictDocumentReadQueue";

type Results = ReadonlyMap<string, PromiseSettledResult<ConflictDocument>>;

/** 실제 시간 대신 읽기 완료 시점을 테스트가 소유한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
/** 예약된 queue와 후속 읽기만 진행한다. */
function settle(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }
/** 경로마다 독립적인 결과 식별자를 가진 서비스 응답을 만든다. */
function results(paths: readonly string[]): Results {
  return new Map(paths.map(rel => [rel, { status: "fulfilled", value: { rel } as ConflictDocument }]));
}

/** Git 경계 대역으로 공통 조회의 경로·신호·순서와 개별 응답을 제어한다. */
function fixture(root = "/repo") {
  const state = {
    calls: [] as Array<{ paths: string[]; signal: AbortSignal; batch: boolean; isNeeded?: (rel: string) => boolean }>,
    read: async (paths: readonly string[], _signal: AbortSignal): Promise<Results> => results(paths),
  };
  const service = {
    repoRoot: root,
    async getConflictDocument(rel: string, _full: boolean, options: { signal: AbortSignal }) {
      state.calls.push({ paths: [rel], signal: options.signal, batch: false });
      const result = (await state.read([rel], options.signal)).get(rel)!;
      if (result.status === "rejected") throw result.reason;
      return result.value;
    },
    async getConflictDocuments(paths: readonly string[], _full: boolean, options: { signal: AbortSignal; isNeeded?: (rel: string) => boolean }) {
      state.calls.push({ paths: [...paths], signal: options.signal, batch: true, isNeeded: options.isNeeded });
      return state.read(paths, options.signal);
    },
  } as unknown as ConflictService;
  return { state, service };
}

/** 소비자별 signal을 가진 실제 queue 요청을 만들어 취소를 명시적으로 제어한다. */
function request(queue: ConflictDocumentReadQueue, service: ConflictService, rel: string,
  priority = () => 1, beforeRead = () => true) {
  const controller = new AbortController();
  return { controller, promise: queue.read(service, rel, undefined, controller.signal, priority, beforeRead) };
}

test("visible reads start individually before bounded hidden batches and preserve per-file results", async () => {
  const queue = new ConflictDocumentReadQueue(), f = fixture();
  const hidden = Array.from({ length: 35 }, (_, index) => request(queue, f.service, `hidden-${index}`));
  const visible = request(queue, f.service, "visible", () => 0);
  const documents = await Promise.all([...hidden.map(entry => entry.promise), visible.promise]);
  assert.equal(f.state.calls[0].batch, false);
  assert.deepEqual(f.state.calls[0].paths, ["visible"]);
  assert.ok(f.state.calls.every(call => call.paths.length <= 16));
  assert.equal(f.state.calls.filter(call => call.batch).length, 3);
  assert.deepEqual(documents.map(document => document?.rel), [...hidden.map((_, index) => `hidden-${index}`), "visible"]);
});

test("a tab cancelled inside a shared read cannot abort the remaining consumer", async () => {
  const queue = new ConflictDocumentReadQueue(), f = fixture();
  const pending = deferred<Results>();
  f.state.read = () => pending.promise;
  const first = request(queue, f.service, "first"), second = request(queue, f.service, "second");
  await settle();
  assert.equal(f.state.calls.length, 1);
  const rejected = assert.rejects(first.promise, { name: "AbortError" });
  first.controller.abort();
  assert.equal(f.state.calls[0].signal.aborted, false);
  assert.equal(f.state.calls[0].isNeeded?.("first"), false);
  assert.equal(f.state.calls[0].isNeeded?.("second"), true);
  pending.resolve(results(["first", "second"]));
  await rejected;
  assert.equal((await second.promise)?.rel, "second");
});

test("last-consumer cancellation retains the slot until owned shared reads have actually settled", async () => {
  const queue = new ConflictDocumentReadQueue(), a = fixture("/a"), b = fixture("/b"), c = fixture("/c");
  const pendingA = deferred<Results>(), pendingB = deferred<Results>();
  a.state.read = () => pendingA.promise;
  b.state.read = () => pendingB.promise;
  const first = [request(queue, a.service, "a1"), request(queue, a.service, "a2")];
  const second = [request(queue, b.service, "b1", () => 0)];
  const outcomes = Promise.allSettled([...first, ...second].map(entry => entry.promise));
  await settle();
  const latest = request(queue, c.service, "visible", () => 0);
  first.forEach(entry => entry.controller.abort());
  await settle();
  assert.equal(a.state.calls[0].signal.aborted, true);
  assert.equal(c.state.calls.length, 0, "Aborted consumers do not imply that their Git processes have closed");
  pendingA.resolve(results(["a1", "a2"]));
  await settle();
  assert.equal(c.state.calls.length, 1);
  assert.equal((await latest.promise)?.rel, "visible");
  pendingB.resolve(results(["b1"]));
  assert.deepEqual((await outcomes).map(result => result.status), ["rejected", "rejected", "fulfilled"]);
});

test("dirty and cancelled queued documents start no service IO", async () => {
  const queue = new ConflictDocumentReadQueue(), f = fixture();
  let clean = true;
  const dirty = request(queue, f.service, "dirty", () => 1, () => clean);
  const closed = request(queue, f.service, "closed");
  const rejection = assert.rejects(closed.promise, { name: "AbortError" });
  clean = false;
  closed.controller.abort();
  const remaining = request(queue, f.service, "clean");
  assert.equal(await dirty.promise, undefined);
  await rejection;
  assert.equal((await remaining.promise)?.rel, "clean");
  assert.deepEqual(f.state.calls.flatMap(call => call.paths), ["clean"]);
});

test("per-file failures and a missing response cannot suppress successful siblings", async () => {
  const queue = new ConflictDocumentReadQueue(), f = fixture();
  const failure = new Error("no longer conflicted");
  f.state.read = async () => new Map([
    ["failed", { status: "rejected", reason: failure }],
    ["ready", { status: "fulfilled", value: { rel: "ready" } as ConflictDocument }],
  ]);
  const failed = request(queue, f.service, "failed"), ready = request(queue, f.service, "ready"), missing = request(queue, f.service, "missing");
  const rejected = assert.rejects(failed.promise, error => error === failure);
  const absent = assert.rejects(missing.promise, /Missing conflict document/);
  assert.equal((await ready.promise)?.rel, "ready");
  await Promise.all([rejected, absent]);
});

test("priority is evaluated when a slot is available after the user changes tabs", async () => {
  const queue = new ConflictDocumentReadQueue(), f = fixture();
  const pending = deferred<Results>();
  f.state.read = paths => paths[0].startsWith("block") ? pending.promise.then(() => results(paths)) : Promise.resolve(results(paths));
  const blocks = [request(queue, f.service, "block0", () => 0), request(queue, f.service, "block1", () => 0)];
  await settle();
  let selected = false;
  const hidden = request(queue, f.service, "hidden"), active = request(queue, f.service, "now-visible", () => selected ? 0 : 1);
  selected = true;
  pending.resolve(results([]));
  await Promise.all([...blocks.map(entry => entry.promise), hidden.promise, active.promise]);
  assert.deepEqual(f.state.calls[2].paths, ["now-visible"]);
  assert.equal(f.state.calls[2].batch, false);
});

test("large Result bodies split background batches before their retained text exceeds the budget", async () => {
  const queue = new ConflictDocumentReadQueue(), f = fixture();
  const side = { content: "" };
  const documents = Array.from({ length: 3 }, (_, index) => ({ rel: `large-${index}`, result: "x".repeat(2_200_000),
    base: side, current: side, incoming: side, both: "" } as ConflictDocument));
  await Promise.all(documents.map(document => queue.read(f.service, document.rel, document,
    new AbortController().signal, () => 1)));
  assert.equal(f.state.calls.length, 3);
  assert.ok(f.state.calls.every(call => call.paths.length === 1));
});

test("a new foreground request keeps a slot while a long background batch is reading", async () => {
  const queue = new ConflictDocumentReadQueue(), f = fixture();
  const pending = deferred<Results>();
  f.state.read = paths => paths[0] === "foreground" ? Promise.resolve(results(paths)) : pending.promise.then(() => results(paths));
  const background = Array.from({ length: 32 }, (_, index) => request(queue, f.service, `background-${index}`));
  await settle();
  const foreground = request(queue, f.service, "foreground", () => -1);
  await settle();
  assert.equal(f.state.calls.some(call => call.paths[0] === "foreground"), true);
  assert.equal((await foreground.promise)?.rel, "foreground");
  pending.resolve(results([]));
  await Promise.all([...background.map(entry => entry.promise), foreground.promise]);
});
