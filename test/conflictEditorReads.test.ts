import assert from "node:assert/strict";
import test from "node:test";
import { ConflictEditorReadCoordinator } from "../src/providers/conflictEditorReadCoordinator";
import { applyConflictDocument, applyConflictMetadata } from "../src/providers/conflictEditorSessionState";
import type { ConflictDocument, ConflictDocumentMetadata } from "../src/git/conflictService";
import type { TrustedConflictEditorSession } from "../src/providers/conflictEditorOverlayController";
import { buildConflictOverlayPresentation } from "../src/ui/conflictOverlayPresentation";

/** 조회 완료 시점을 소유해 refresh/편집/close가 끼어드는 실제 순서를 재현한다. */
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
/** 현재 microtask에서 예약한 조회만 진행하고 실제 시간 지연 없이 결과를 검사한다. */
function settle(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }

/** 비동기 읽기가 바꿔도 되는 설명과 바꾸면 안 되는 Result/CAS 값을 구분한 fixture다. */
function document(metadataState: ConflictDocument["metadataState"] = "ready"): ConflictDocument {
  const side = { exists: true, kind: "text" as const, content: "side", label: "Current", ref: "HEAD" };
  return { rel: "file.txt", operation: "rebase", context: { operation: "rebase" },
    base: { ...side, stage: 1 }, current: { ...side, stage: 2 }, incoming: { ...side, stage: 3 },
    result: "original", resultState: { exists: true, kind: "text" }, sourceVersion: "source-1",
    resultVersion: "result-1", both: "", bothAvailable: false, metadataState };
}

/** 서비스와 host의 조회/게시를 기록하는 최소 native session을 만든다. */
function fixture(initial = document()) {
  const state = { current: true, dirty: false, commits: [] as ConflictDocument[], metadata: 0 };
  const session = { id: "session", rel: initial.rel, uri: { toString: () => "conflict:file" }, document: initial,
    content: initial.result, virtual: false, refreshGeneration: 0, revision: 1, busy: false,
    resolved: false, suspended: false, baselineStale: false,
    service: { repoRoot: "/repo", getConflictDocument: async () => initial,
      getConflictDocumentMetadata: async () => undefined },
  } as unknown as TrustedConflictEditorSession;
  const coordinator = new ConflictEditorReadCoordinator({
    isCurrent: target => state.current && target === session, isDirty: () => state.dirty,
    commitDocument: (target, doc) => { state.commits.push(doc); applyConflictDocument(target, doc); },
    commitMetadata: (target, details) => { state.metadata++; applyConflictMetadata(target, details); },
    reopen: async () => { assert.fail("unexpected Result type change"); },
    publishResolvedResult: async () => false, markResolved: target => { target.resolved = true; },
  });
  return { state, session, coordinator };
}

/** 서비스가 검증한 source identity만 붙여 Result 없는 설명 응답을 만든다. */
function metadata(doc: ConflictDocument): ConflictDocumentMetadata {
  return { sourceVersion: doc.sourceVersion, context: { operation: doc.operation, branch: "feature" },
    sources: { operation: doc.operation, current: { label: "Current", ref: "HEAD", commit: "current-oid" },
      incoming: { label: "Incoming", ref: "REBASE_HEAD", commit: "incoming-oid" } } };
}

test("thirty refresh events during a read become one latest follow-up and never publish the stale result", async () => {
  const { state, session, coordinator } = fixture();
  const pending: Array<ReturnType<typeof deferred<ConflictDocument>>> = [];
  session.service.getConflictDocument = async () => { const next = deferred<ConflictDocument>(); pending.push(next); return next.promise; };
  const first = coordinator.refresh(session, "first");
  await settle();
  const burst = Array.from({ length: 30 }, () => coordinator.refresh(session, "indexChanged"));
  assert.equal(pending.length, 1);
  pending[0].resolve({ ...document(), result: "stale", resultVersion: "stale" });
  await settle();
  assert.equal(state.commits.length, 0);
  assert.equal(pending.length, 2);
  pending[1].resolve({ ...document(), result: "latest", resultVersion: "latest" });
  assert.deepEqual(await Promise.all([first, ...burst]), Array(31).fill(true));
  assert.equal(state.commits.length, 1);
  assert.equal(session.content, "latest");
});

test("content refresh completes before slow metadata; later metadata preserves dirty Result and CAS baseline", async () => {
  const { state, session, coordinator } = fixture();
  const details = deferred<ConflictDocumentMetadata | undefined>();
  session.service.getConflictDocument = async () => ({ ...document("pending"), result: "on disk", resultVersion: "new-result", sourceVersion: "source-2" });
  session.service.getConflictDocumentMetadata = async () => details.promise;
  assert.equal(await coordinator.refresh(session, "external"), true);
  assert.equal(session.content, "on disk");
  assert.equal(state.metadata, 0);
  state.dirty = true;
  session.content = "user typing";
  session.refreshGeneration++;
  details.resolve(metadata(session.document));
  await settle();
  assert.equal(session.content, "user typing");
  assert.equal(session.document.resultVersion, "new-result");
  assert.equal(session.document.metadataState, "ready");
  assert.equal(session.document.incoming.commit, "incoming-oid");
});

for (const invalidated of ["closed", "resolved", "replaced", "suspended"] as const) {
  test(`late metadata cannot publish into a ${invalidated} session`, async () => {
    const { state, session, coordinator } = fixture(document("pending"));
    const initial = session.document, details = deferred<ConflictDocumentMetadata | undefined>();
    session.service.getConflictDocumentMetadata = async () => details.promise;
    coordinator.enrich(session);
    if (invalidated === "closed") state.current = false;
    if (invalidated === "resolved") session.resolved = true;
    if (invalidated === "suspended") session.suspended = true;
    if (invalidated === "replaced") session.document = { ...document(), sourceVersion: "new-source" };
    details.resolve(metadata(initial));
    await settle();
    assert.equal(state.metadata, 0);
  });
}

test("metadata failures keep editing available and an explicit reload retries safely", async () => {
  const { state, session, coordinator } = fixture(document("pending"));
  session.service.getConflictDocumentMetadata = async () => { throw new Error("history unavailable"); };
  coordinator.enrich(session);
  await settle();
  assert.equal(session.document.metadataState, "error");
  assert.equal(session.content, "original");
  assert.equal(buildConflictOverlayPresentation(session.document).impact.tone, "warning");
  session.service.getConflictDocument = async () => document("pending");
  session.service.getConflictDocumentMetadata = async doc => metadata(doc);
  await coordinator.refresh(session, "reload", true);
  await settle();
  assert.equal(session.document.metadataState, "ready");
  assert.equal(state.metadata, 2);
});

test("unchanged automatic reads skip repaint while explicit reload still replaces a dirty buffer", async () => {
  const { state, session, coordinator } = fixture();
  assert.equal(await coordinator.refresh(session, "conflictsRefresh"), true);
  assert.equal(state.commits.length, 0);
  state.dirty = true; session.content = "unsaved edits";
  await coordinator.refresh(session, "automatic");
  assert.equal(session.content, "unsaved edits");
  session.busy = true;
  await coordinator.refresh(session, "reload", true);
  assert.equal(state.commits.length, 1);
  assert.equal(session.content, "original");
});

test("metadata completed during a content read cannot regress to pending or replace new bytes", async () => {
  const { session, coordinator } = fixture(document("pending"));
  const read = deferred<ConflictDocument>();
  session.service.getConflictDocument = async () => read.promise;
  const refresh = coordinator.refresh(session, "external");
  await settle();
  applyConflictMetadata(session, metadata(session.document));
  read.resolve({ ...document("pending"), result: "new disk bytes", resultVersion: "new-result" });
  await refresh;
  assert.equal(session.document.metadataState, "ready");
  assert.equal(session.document.incoming.commit, "incoming-oid");
  assert.equal(session.content, "new disk bytes");
});

test("busy actions defer metadata publication until their owned refresh can retry", async () => {
  const { state, session, coordinator } = fixture(document("pending"));
  const details = deferred<ConflictDocumentMetadata | undefined>();
  session.service.getConflictDocumentMetadata = async () => details.promise;
  coordinator.enrich(session); session.busy = true;
  details.resolve(metadata(session.document)); await settle();
  assert.equal(state.metadata, 0);
  assert.equal(session.pendingRefreshReason, "conflictMetadataDeferred");
  session.busy = false;
  await coordinator.refresh(session, session.pendingRefreshReason!); await settle();
  assert.equal(session.document.metadataState, "ready");
});
