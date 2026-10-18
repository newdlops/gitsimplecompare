import assert from "node:assert/strict";
import test from "node:test";
import type { ConflictDocument, ConflictService } from "../src/git/conflictService";
import { ConflictEditorReadCoordinator } from "../src/providers/conflictEditorReadCoordinator";
import type { TrustedConflictEditorSession as Session } from "../src/providers/conflictEditorOverlayController";
import { applyConflictDocument } from "../src/providers/conflictEditorSessionState";

/** queue와 후속 게시를 진행하되 실제 지연 시간에는 의존하지 않는다. */
function settle(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }

/** 본문과 CAS identity가 구별되는 native 문서를 만든다. */
function document(rel: string, revision = "old"): ConflictDocument {
  const side = { exists: true, kind: "text" as const, content: "side", label: "Current", ref: "HEAD" };
  return { rel, operation: "rebase", context: { operation: "rebase" },
    base: { ...side, stage: 1 }, current: { ...side, stage: 2 }, incoming: { ...side, stage: 3 },
    result: `${revision}:${rel}`, resultState: { exists: true, kind: "text" }, sourceVersion: `source:${rel}`,
    resultVersion: `${revision}:version:${rel}`, both: "", bothAvailable: false, metadataState: "ready" };
}

/** 실제 coordinator에 지연 가능한 배치 서비스와 native session 상태를 연결한다. */
function fixture() {
  let complete!: (results: ReadonlyMap<string, PromiseSettledResult<ConflictDocument>>) => void;
  const pending = new Promise<ReadonlyMap<string, PromiseSettledResult<ConflictDocument>>>(resolve => { complete = resolve; });
  const state = { batches: 0, sessions: new Map<string, Session>(), dirty: new Set<Session>(),
    commits: [] as string[], resolved: [] as string[] };
  const service = { repoRoot: "/repo", getConflictDocuments: async () => { state.batches++; return pending; },
    getConflictDocument: async (rel: string) => document(rel, "fresh"),
    getConflictDocumentMetadata: async () => undefined,
  } as unknown as ConflictService;
  const sessions = ["first", "second", "third"].map(rel => {
    const initial = document(rel);
    const session = { id: rel, rel, uri: { toString: () => rel }, service, document: initial, content: initial.result,
      virtual: false, refreshGeneration: 0, revision: 1, busy: false, resolved: false, suspended: false,
      baselineStale: false } as unknown as Session;
    state.sessions.set(rel, session); return session;
  });
  const coordinator = new ConflictEditorReadCoordinator({
    isCurrent: session => state.sessions.get(session.rel) === session, isDirty: session => state.dirty.has(session),
    isVisible: () => false,
    commitDocument: (session, document) => { state.commits.push(session.rel); applyConflictDocument(session, document); },
    commitMetadata: () => assert.fail("ready metadata must be reused"),
    reopen: async () => assert.fail("text Result must keep its native editor"),
    publishResolvedResult: async () => true,
    markResolved: session => { session.resolved = true; state.resolved.push(session.rel); },
  });
  return { state, sessions, coordinator, complete: (resolved?: string) => complete(new Map(sessions.map(session => [session.rel,
    session.rel === resolved ? { status: "rejected", reason: new Error("This file is no longer conflicted.") }
      : { status: "fulfilled", value: document(session.rel, "fresh") }]))),
  };
}

test("typing during a shared read preserves that tab's buffer and CAS while siblings update", async () => {
  const f = fixture();
  const reads = f.sessions.map(session => f.coordinator.refresh(session, "indexChanged"));
  await settle();
  assert.equal(f.state.batches, 1);
  const editing = f.sessions[0];
  f.state.dirty.add(editing); editing.content = "unsaved typing";
  f.complete(); await Promise.all(reads);
  assert.equal(editing.content, "unsaved typing");
  assert.equal(editing.document.resultVersion, "old:version:first");
  assert.equal(editing.pendingRefreshReason, "indexChanged");
  assert.deepEqual(f.state.commits, ["second", "third"]);
});

for (const invalidation of ["close", "suspend", "replace", "action"] as const) {
  test(`a ${invalidation} during a batch blocks its stale result without suppressing sibling publication`, async () => {
    const f = fixture();
    const reads = f.sessions.map(session => f.coordinator.refresh(session, "indexChanged"));
    await settle();
    const target = f.sessions[0];
    if (invalidation === "close") { f.state.sessions.delete(target.rel); f.coordinator.cancel(target); }
    if (invalidation === "suspend") { target.suspended = true; f.coordinator.cancel(target); }
    if (invalidation === "replace") f.state.sessions.set(target.rel, { ...target });
    if (invalidation === "action") { target.busy = true; target.refreshGeneration++; }
    f.complete(); await Promise.all(reads);
    assert.equal(target.content, "old:first");
    assert.equal(target.document.resultVersion, "old:version:first");
    assert.deepEqual(f.state.commits, ["second", "third"]);
  });
}

test("one resolved path follows existing resolution publication while unresolved siblings retain their documents", async () => {
  const f = fixture();
  const reads = f.sessions.map(session => f.coordinator.refresh(session, "indexChanged"));
  await settle(); f.complete("first"); await Promise.all(reads);
  assert.deepEqual(f.state.resolved, ["first"]);
  assert.deepEqual(f.state.commits, ["second", "third"]);
  assert.equal(f.sessions[1].document.resultVersion, "fresh:version:second");
});
