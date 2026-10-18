import assert from "node:assert/strict";
import test from "node:test";
import type { ConflictWorkingResult } from "../src/git/conflictContentService";
import type { ConflictDocument, ConflictService } from "../src/git/conflictService";
import type { TrustedConflictEditorSession as Session } from "../src/providers/conflictEditorOverlayController";
import { applyConflictWorkingResult } from "../src/providers/conflictEditorSessionState";
import { ConflictResolvedRefreshCoordinator } from "../src/providers/conflictResolvedRefreshCoordinator";

type Results = ReadonlyMap<string, PromiseSettledResult<ConflictWorkingResult>>;

/** 조회를 끝내는 시점을 테스트가 정해 실제 사용자 전환과 index 변경의 순서를 고정한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
/** queue의 현재 microtask들만 처리해 시간 상한 대신 실제 시작/게시 순서를 검사한다. */
function settle(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }

/** 파일별 전체 본문과 독립적인 CAS version을 가진 Git 서비스 응답이다. */
function results(rels: readonly string[], suffix = "fresh"): Results {
  return new Map(rels.map(rel => [rel, { status: "fulfilled" as const,
    value: { content: `${rel}:${suffix}`, state: { exists: true, kind: "text" as const }, version: `${rel}:version:${suffix}` } }]));
}

/** 실제 session 상태 변환을 사용하면서 조회/게시/재충돌 요청을 관찰할 host다. */
function fixture() {
  const current = new Set<Session>(), visible = new Set<Session>(), services = new Map<string, ConflictService>();
  const state = { published: [] as Session[], resolved: [] as Session[], reload: [] as Session[], lists: 0 };
  const coordinator = new ConflictResolvedRefreshCoordinator({
    isCurrent: session => current.has(session), isVisible: session => visible.has(session),
    publish: (session, result) => { state.published.push(session); applyConflictWorkingResult(session, result); },
    markResolved: session => { session.resolved = true; state.resolved.push(session); },
    refreshUnresolved: session => { state.reload.push(session); },
  });
  /** 같은 저장소 session은 같은 서비스 인스턴스를 공유한다. */
  function create(rel: string, root = "/repo"): Session {
    let service = services.get(root);
    if (!service) {
      service = { repoRoot: root, getWorkingResults: async (rels: readonly string[]) => results(rels),
        listConflicts: async () => { state.lists++; return []; } } as unknown as ConflictService;
      services.set(root, service);
    }
    const side = { exists: true, kind: "text", content: "side", label: "Current", ref: "HEAD" };
    const document = { rel, operation: "rebase", context: { operation: "rebase" },
      base: { ...side, stage: 1 }, current: { ...side, stage: 2 }, incoming: { ...side, stage: 3 },
      result: "old buffer baseline", resultState: { exists: true, kind: "text" }, resultVersion: "old-version",
      sourceVersion: "source", both: "", bothAvailable: false, metadataState: "ready" } as ConflictDocument;
    const session = { id: `${root}:${rel}`, rel, service, document, content: document.result, revision: 1,
      refreshGeneration: 0, busy: false, resolved: false, suspended: false, virtual: false,
      uri: { toString: () => `${root}:${rel}` } } as unknown as Session;
    current.add(session); return session;
  }
  return { coordinator, create, current, visible, state };
}

test("visible resolved tabs publish before hidden batches and keep at most two reads active", async () => {
  const h = fixture(), hidden = Array.from({ length: 40 }, (_, index) => h.create(`hidden-${index}`));
  const shown = h.create("shown"); h.visible.add(shown);
  const calls: Array<{ rels: readonly string[]; pending: ReturnType<typeof deferred<Results>>; done: boolean }> = [];
  let active = 0, peak = 0;
  shown.service.getWorkingResults = async rels => {
    active++; peak = Math.max(peak, active);
    const pending = deferred<Results>(); calls.push({ rels, pending, done: false });
    try { return await pending.promise; } finally { active--; }
  };
  const refresh = h.coordinator.refresh("/repo", [...hidden, shown], "external"); await settle();
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].rels, ["shown"]);
  assert.equal(calls[1].rels.length, 16);
  calls[0].done = true; calls[0].pending.resolve(results(calls[0].rels)); await settle();
  assert.deepEqual(h.state.resolved, [shown]); assert.equal(hidden.some(session => session.resolved), false);
  for (let turn = 0; turn < 10 && h.state.resolved.length < 41; turn++) {
    for (const call of calls) if (!call.done) { call.done = true; call.pending.resolve(results(call.rels)); }
    await settle();
  }
  await refresh;
  assert.equal(calls.length, 4); assert.equal(h.state.resolved.length, 41); assert.equal(peak, 2);
  assert.equal(shown.document.resultVersion, "shown:version:fresh");
});

test("index is checked after Result reads and a newly conflicted path is reloaded rather than resolved", async () => {
  const h = fixture(), one = h.create("one"), two = h.create("two"); let readFinished = false;
  one.service.getWorkingResults = async rels => { readFinished = true; return results(rels); };
  one.service.listConflicts = async () => { assert.equal(readFinished, true); return ["one"]; };
  await h.coordinator.refresh("/repo", [one, two], "external");
  assert.deepEqual(h.state.reload, [one]); assert.deepEqual(h.state.resolved, [two]);
  assert.equal(one.document.resultVersion, "old-version"); assert.equal(two.document.result, "two:fresh");
});

test("one file read error does not prevent other resolved tabs from receiving fresh baselines", async () => {
  const h = fixture(), one = h.create("one"), two = h.create("two");
  one.service.getWorkingResults = async rels => new Map([...results(rels), ["one", { status: "rejected", reason: new Error("permission denied") }]]);
  await h.coordinator.refresh("/repo", [one, two], "external");
  assert.deepEqual(h.state.resolved, [two]); assert.equal(one.resolved, false);
  assert.equal(one.document.resultVersion, "old-version");
});

for (const change of ["closed", "edited", "suspended", "busy"] as const) {
  test(`a ${change} session cannot receive a late resolved baseline`, async () => {
    const h = fixture(), session = h.create("one"), pending = deferred<Results>();
    session.service.getWorkingResults = async () => pending.promise;
    const refresh = h.coordinator.refresh("/repo", [session], "external"); await settle();
    if (change === "closed") h.current.delete(session);
    if (change === "edited") session.refreshGeneration++;
    if (change === "suspended") session.suspended = true;
    if (change === "busy") session.busy = true;
    pending.resolve(results([session.rel])); await refresh;
    assert.equal(h.state.published.length, 0); assert.equal(h.state.lists, 0);
    assert.equal(session.document.resultVersion, "old-version");
  });
}

test("thirty newer refreshes cancel the obsolete read and publish only one latest result", async () => {
  const h = fixture(), session = h.create("one"); let reads = 0, aborted = false;
  session.service.getWorkingResults = async (rels, _full, signal) => {
    if (++reads > 1) return results(rels, "latest");
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => { aborted = true; reject(signal!.reason); }, { once: true }));
  };
  const first = h.coordinator.refresh("/repo", [session], "first"); await settle();
  const newer = Array.from({ length: 30 }, () => { session.refreshGeneration++; return h.coordinator.refresh("/repo", [session], "latest"); });
  await Promise.all([first, ...newer]);
  assert.equal(aborted, true); assert.equal(reads, 2); assert.equal(h.state.lists, 1);
  assert.deepEqual(h.state.published, [session]); assert.equal(session.document.result, "one:latest");
});

test("a newer snapshot with no resolved candidates cancels the pending old snapshot", async () => {
  const h = fixture(), session = h.create("one"); let aborted = false;
  session.service.getWorkingResults = async (_rels, _full, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => { aborted = true; reject(signal!.reason); }, { once: true });
  });
  const first = h.coordinator.refresh("/repo", [session], "external"); await settle();
  await h.coordinator.refresh("/repo", [], "conflicted-again"); await first;
  assert.equal(aborted, true); assert.equal(h.state.published.length, 0);
});

test("cancelling one repository leaves another repository's pending resolved reads intact", async () => {
  const h = fixture(), one = h.create("one"), two = h.create("two", "/other");
  const other = deferred<Results>(); let otherSignal!: AbortSignal, reads = 0;
  one.service.getWorkingResults = async (rels, _full, signal) => {
    if (++reads > 1) return results(rels, "latest");
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  };
  two.service.getWorkingResults = async (_rels, _full, signal) => { otherSignal = signal!; return other.promise; };
  const first = h.coordinator.refresh("/repo", [one], "external");
  const second = h.coordinator.refresh("/other", [two], "external"); await settle();
  one.refreshGeneration++; const latest = h.coordinator.refresh("/repo", [one], "latest"); await settle();
  assert.equal(otherSignal.aborted, false); other.resolve(results(["two"]));
  await Promise.all([first, latest, second]);
  assert.equal(one.document.result, "one:latest"); assert.equal(two.document.result, "two:fresh");
});

test("dispose closes active reads and prevents later refreshes from starting", async () => {
  const h = fixture(), session = h.create("one"); let reads = 0, cancelled = false;
  session.service.getWorkingResults = async (_rels, _full, signal) => {
    reads++;
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => { cancelled = true; reject(signal!.reason); }, { once: true }));
  };
  const refresh = h.coordinator.refresh("/repo", [session], "external"); await settle(); h.coordinator.dispose();
  await refresh; await h.coordinator.refresh("/repo", [session], "after-dispose");
  assert.equal(cancelled, true); assert.equal(reads, 1); assert.equal(h.state.published.length, 0);
});

test("closing the last pending resolved tab cancels its owned IO immediately", async () => {
  const h = fixture(), session = h.create("one"); let cancelled = false;
  session.service.getWorkingResults = async (_rels, _full, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => { cancelled = true; reject(signal!.reason); }, { once: true });
  });
  const refresh = h.coordinator.refresh("/repo", [session], "external"); await settle();
  h.current.delete(session); h.coordinator.cancel(session); await refresh;
  assert.equal(cancelled, true); assert.equal(h.state.published.length, 0); assert.equal(h.state.lists, 0);
});

test("closing one tab preserves the shared batch needed by another open tab", async () => {
  const h = fixture(), one = h.create("one"), two = h.create("two"), pending = deferred<Results>();
  let signal!: AbortSignal;
  one.service.getWorkingResults = async (_rels, _full, ownedSignal) => { signal = ownedSignal!; return pending.promise; };
  const refresh = h.coordinator.refresh("/repo", [one, two], "external"); await settle();
  h.current.delete(one); h.coordinator.cancel(one); assert.equal(signal.aborted, false);
  pending.resolve(results(["one", "two"])); await refresh;
  assert.deepEqual(h.state.resolved, [two]); assert.equal(one.document.resultVersion, "old-version");
});
