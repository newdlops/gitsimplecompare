import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ConflictEditorOverlayController, TrustedConflictEditorSession as Session } from "../src/providers/conflictEditorOverlayController";
import { ConflictResultSaveCoordinator } from "../src/providers/conflictResultSaveCoordinator";
import { isConflictMutationActive, tryAcquireConflictMutation } from "../src/git/conflictMutationCoordinator";
import { applyConflictWorkingResult, applyStaleSavedBaseline } from "../src/providers/conflictEditorSessionState";
import * as vscode from "./helpers/vscodeMock";

/** 저장과 후속 조회를 따로 멈춰 게시한 기준선과 mutation 잠금의 수명을 관찰한다. */
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

/** Save coordinator의 실제 기준선 변환과 외부 action lease를 검사하는 최소 host다. */
function fixture(t: TestContext) {
  vscode.__resetWindowMessages();
  const root = `/save-fixture/${t.name}`;
  const state = { current: true, writes: [] as any[][], results: 0, refreshes: 0, updates: 0, stale: 0,
    refresh: async (): Promise<boolean> => true, result: async () => ({ content: "saved", state: { exists: true, kind: "text" as const }, version: "new-result" }) };
  const service = { repoRoot: root,
    writeResolvedContent: async (...args: any[]) => { assert.equal(isConflictMutationActive(root), true); state.writes.push(args); return undefined; },
    writeWorkingContent: async (...args: any[]) => { assert.equal(isConflictMutationActive(root), true); state.writes.push(args); return undefined; },
    getWorkingResult: async () => { state.results++; assert.equal(isConflictMutationActive(root), false); return state.result(); } };
  const session = { id: "session", uri: { toString: () => "conflict:save" }, service, rel: "file.txt",
    document: { result: "before", resultVersion: "old-result", sourceVersion: "old-source", resultState: { exists: true, kind: "text" } },
    content: "before", revision: 1, refreshGeneration: 0, virtual: false, suspended: false, busy: false,
    resolved: false, allowBusySave: false, baselineStale: false } as unknown as Session;
  const overlay = { resourceForUri: () => state.current ? session : undefined,
    isCurrent: () => state.current,
    setBusy: (_session: Session, value: boolean) => { session.busy = value; },
    refreshSession: async () => { state.refreshes++; assert.equal(isConflictMutationActive(root), false); return state.refresh(); },
    updateWorkingResult: (_session: Session, result: any) => { state.updates++; applyConflictWorkingResult(session, result); },
    markSaveBaselineStale: (_session: Session, content: string) => { state.stale++; applyStaleSavedBaseline(session, content); },
  } as unknown as ConflictEditorOverlayController;
  state.refresh = async () => { applyConflictWorkingResult(session, await state.result()); return true; };
  return { state, session, service, coordinator: new ConflictResultSaveCoordinator(overlay), root };
}

test("unresolved Save publishes one full refresh and keeps the original immutable write fences", async t => {
  const h = fixture(t);
  await h.coordinator.writeResource(h.session, "saved");
  assert.deepEqual(h.state.writes, [["file.txt", "saved", false, "old-result", "old-source"]]);
  assert.equal(h.state.refreshes, 1); assert.equal(h.state.results, 0); assert.equal(h.session.busy, false);
  assert.equal(h.session.document.resultVersion, "new-result");
  assert.equal(isConflictMutationActive(h.root), false);
});

test("a discarded content refresh falls back to one fresh working Result baseline", async t => {
  const h = fixture(t); h.state.refresh = async () => false;
  await h.coordinator.writeResource(h.session, "saved");
  assert.equal(h.state.refreshes, 1); assert.equal(h.state.results, 1); assert.equal(h.state.updates, 1);
  assert.equal(h.session.document.resultVersion, "new-result"); assert.equal(h.session.baselineStale, false);
});

test("resolved documents save with only the working-tree fence and skip conflict history", async t => {
  const h = fixture(t); h.session.resolved = true;
  await h.coordinator.writeResource(h.session, "saved");
  assert.deepEqual(h.state.writes, [["file.txt", "saved", "old-result"]]);
  assert.equal(h.state.refreshes, 0); assert.equal(h.state.results, 1);
});

test("another file can hold a new lease during slow post-save reads and retains it after Save finishes", async t => {
  const h = fixture(t), pending = deferred<boolean>(), started = deferred<void>();
  let other: (() => void) | undefined;
  t.after(() => other?.());
  h.state.refresh = async () => {
    other = tryAcquireConflictMutation(h.root); assert.ok(other); started.resolve(); return pending.promise;
  };
  const save = h.coordinator.writeResource(h.session, "saved"); await started.promise;
  assert.equal(h.session.busy, true); assert.equal(isConflictMutationActive(h.root), true);
  pending.resolve(true); await save;
  assert.equal(isConflictMutationActive(h.root), true); other!();
  assert.equal(isConflictMutationActive(h.root), false);
});

test("post-save read failure reports a saved but stale baseline and prevents another write", async t => {
  const h = fixture(t); h.state.refresh = async () => { throw new Error("read failed"); };
  await h.coordinator.writeResource(h.session, "saved");
  assert.equal(h.state.writes.length, 1); assert.equal(h.session.content, "saved");
  assert.equal(h.state.stale, 1); assert.equal(h.session.baselineStale, true); assert.equal(h.session.busy, false);
  assert.match(vscode.__warningMessages.at(-1)!, /saved safely/);
  await assert.rejects(h.coordinator.writeResource(h.session, "second write"), /cannot be saved/);
  assert.equal(h.state.writes.length, 1); assert.equal(isConflictMutationActive(h.root), false);
});

test("an actual write failure releases the lease and never starts baseline reads", async t => {
  const h = fixture(t); h.service.writeResolvedContent = async () => { throw new Error("source changed"); };
  await assert.rejects(h.coordinator.writeResource(h.session, "saved"), /source changed/);
  assert.equal(h.state.refreshes, 0); assert.equal(h.state.results, 0); assert.equal(h.state.stale, 0);
  assert.equal(isConflictMutationActive(h.root), false); assert.equal(h.session.busy, false);
});

test("closed or suspended documents cannot start extra post-save reads", async t => {
  for (const change of ["closed", "suspended"] as const) {
    const h = fixture(t);
    h.service.writeResolvedContent = async () => { if (change === "closed") h.state.current = false; else h.session.suspended = true; return undefined; };
    await h.coordinator.writeResource(h.session, "saved");
    assert.equal(h.state.refreshes, 0); assert.equal(h.state.results, 0); assert.equal(h.state.updates, 0);
    assert.equal(isConflictMutationActive(h.root), false);
  }
});

test("a refresh that already resolved the session does not read the same Result again", async t => {
  const h = fixture(t); h.state.refresh = async () => { h.session.resolved = true; return false; };
  await h.coordinator.writeResource(h.session, "saved");
  assert.equal(h.state.results, 0); assert.equal(h.state.updates, 0);
});

test("nested action saves retain their owner's busy state and explicit click fences", async t => {
  const h = fixture(t); h.session.busy = true; h.session.allowBusySave = true;
  h.session.pendingSaveFence = { sourceVersion: "click-source", resultVersion: "click-result" };
  await h.coordinator.writeResource(h.session, "saved");
  assert.equal(h.session.busy, true);
  assert.deepEqual(h.state.writes[0], ["file.txt", "saved", false, "click-result", "click-source"]);
});
