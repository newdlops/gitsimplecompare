import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ConflictService, type ConflictDocument, type ConflictDocumentMetadata } from "../src/git/conflictService";
import type { TrustedConflictEditorSession as Session } from "../src/providers/conflictEditorOverlayController";
import { ConflictEditorReadCoordinator } from "../src/providers/conflictEditorReadCoordinator";
import { applyConflictMetadata } from "../src/providers/conflictEditorSessionState";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 이전 요청의 실제 완료 시점을 소유해 현재 탭이 그 요청을 기다리는지 확인한다. */
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
/** queue의 Promise와 UI 게시 callback이 처리될 때까지 한 event loop만 진행한다. */
function settle(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }
/** source에 고정된 설명이며 Result 본문/저장 version은 포함하지 않는다. */
function details(doc: ConflictDocument): ConflictDocumentMetadata {
  return { sourceVersion: doc.sourceVersion, context: { operation: "rebase", branch: "side" },
    sources: { operation: "rebase", current: { label: "Current", ref: "HEAD" }, incoming: { label: "Incoming", ref: "REBASE_HEAD" } } };
}
/** 서로 다른 native 문서를 같은 metadata queue에 넣을 최소 session이다. */
function session(rel: string): Session {
  const side = { stage: 2, label: "Current", ref: "index stage 2", exists: true, kind: "text", content: "side" };
  const document = { rel, operation: "rebase", context: { operation: "rebase" }, base: { ...side, stage: 1 }, current: side,
    incoming: { ...side, stage: 3 }, result: "untouched Result", resultState: { exists: true, kind: "text" },
    resultVersion: "result-version", sourceVersion: `source:${rel}`, metadataState: "pending", both: "", bothAvailable: false } as ConflictDocument;
  return { id: rel, rel, uri: { toString: () => rel }, document, content: document.result, busy: false, resolved: false,
    suspended: false, virtual: false, revision: 1, refreshGeneration: 0, service: { repoRoot: "/repo" } } as unknown as Session;
}

/** 여러 문서의 표시 전환과 metadata 게시만 관찰하고 Result mutation은 즉시 실패시킨다. */
function fixture(...sessions: Session[]) {
  const current = new Set(sessions), shown = new Set<Session>(), published: Session[] = [], errors: Session[] = [], done = deferred<void>();
  const coordinator = new ConflictEditorReadCoordinator({
    isCurrent: target => current.has(target), isDirty: () => true, isVisible: target => shown.has(target),
    commitDocument: () => assert.fail("metadata must preserve Result"),
    commitMetadata: (target, value) => { if (!value) errors.push(target); applyConflictMetadata(target, value); published.push(target); if (published.length === sessions.length) done.resolve(); },
    reopen: async () => assert.fail("unexpected reopen"), publishResolvedResult: async () => false,
    markResolved: () => assert.fail("metadata cannot resolve a file"),
  });
  return { current, shown, published, errors, done: done.promise, coordinator,
    close() { current.clear(); for (const target of sessions) coordinator.cancel(target); } };
}

test("visible conflict metadata can finish without waiting for a running hidden file", async t => {
  const hidden = session("hidden"), visible = session("visible"), shown = new Set<Session>();
  const first = deferred<ConflictDocumentMetadata>(), retry = deferred<ConflictDocumentMetadata>();
  const published: Session[] = []; let hiddenReads = 0, cancelled = false, visibleStarted = false;
  hidden.service.getConflictDocumentMetadata = async (_document, signal) => {
    if (++hiddenReads > 1) return retry.promise;
    return new Promise((resolve, reject) => {
      first.promise.then(resolve); signal!.addEventListener("abort", () => { cancelled = true; reject(signal!.reason); }, { once: true });
    });
  };
  visible.service.getConflictDocumentMetadata = async () => { visibleStarted = true; return details(visible.document); };
  let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
  const coordinator = new ConflictEditorReadCoordinator({
    isCurrent: () => true, isDirty: () => true, isVisible: target => shown.has(target),
    commitDocument: () => assert.fail("metadata must not replace Result"),
    commitMetadata: (target, value) => { assert.ok(value); applyConflictMetadata(target, value); published.push(target); if (published.length === 2) finish(); },
    reopen: async () => assert.fail("unexpected reopen"), publishResolvedResult: async () => false,
    markResolved: () => assert.fail("metadata cannot resolve a file"),
  });
  coordinator.enrich(hidden); await settle(); shown.add(visible); coordinator.enrich(visible); await settle();
  t.diagnostic(`Visible started before hidden completed=${visibleStarted}, hidden cancelled=${cancelled}`);
  assert.equal(visibleStarted, true); assert.equal(cancelled, true);
  first.resolve(details(hidden.document)); retry.resolve(details(hidden.document)); await done;
  assert.equal(visible.document.resultVersion, "result-version"); assert.equal(visible.document.result, "untouched Result");
  assert.equal(hidden.document.metadataState, "ready"); assert.equal(visible.document.metadataState, "ready");
});

test("a file already queued while hidden gains priority when the visible editor changes", async t => {
  const hidden = session("hidden"), visible = session("visible"), h = fixture(hidden, visible), retry = deferred<ConflictDocumentMetadata>();
  let reads = 0, cancelled = false, visibleStarted = false;
  t.after(() => h.close());
  hidden.service.getConflictDocumentMetadata = async (_doc, signal) => {
    if (++reads > 1) return retry.promise;
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => { cancelled = true; reject(signal!.reason); }, { once: true }));
  };
  visible.service.getConflictDocumentMetadata = async () => { visibleStarted = true; return details(visible.document); };
  h.coordinator.enrich(hidden); await settle(); h.coordinator.enrich(visible); await settle();
  assert.equal(cancelled, false); assert.equal(visibleStarted, false);
  h.shown.add(visible); h.coordinator.prioritizeVisibleMetadata(); await settle();
  assert.equal(cancelled, true); assert.equal(visibleStarted, true); assert.deepEqual(h.published, [visible]);
  for (let index = 0; index < 20; index++) h.coordinator.prioritizeVisibleMetadata();
  retry.resolve(details(hidden.document)); await h.done; assert.equal(reads, 2);
});

test("two visible split editors keep the running visible metadata request intact", async t => {
  const one = session("one"), two = session("two"), h = fixture(one, two), first = deferred<ConflictDocumentMetadata>();
  let cancelled = false, secondStarted = false;
  t.after(() => h.close()); h.shown.add(one); h.shown.add(two);
  one.service.getConflictDocumentMetadata = async (_doc, signal) => {
    signal!.addEventListener("abort", () => { cancelled = true; }, { once: true }); return first.promise;
  };
  two.service.getConflictDocumentMetadata = async () => { secondStarted = true; return details(two.document); };
  h.coordinator.enrich(one); await settle(); h.coordinator.enrich(two); h.coordinator.prioritizeVisibleMetadata(); await settle();
  assert.equal(cancelled, false); assert.equal(secondStarted, false);
  first.resolve(details(one.document)); await h.done; assert.deepEqual(h.published, [one, two]);
});

test("successive focus changes yield each obsolete lookup once and preserve the newest visible request", async t => {
  const one = session("one"), two = session("two"), three = session("three"), h = fixture(one, two, three);
  const retries = [deferred<ConflictDocumentMetadata>(), deferred<ConflictDocumentMetadata>()], reads = [0, 0], cancelled = [0, 0];
  t.after(() => h.close());
  for (const [index, target] of [one, two].entries()) target.service.getConflictDocumentMetadata = async (_doc, signal) => {
    if (++reads[index] > 1) return retries[index].promise;
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => { cancelled[index]++; reject(signal!.reason); }, { once: true }));
  };
  three.service.getConflictDocumentMetadata = async () => details(three.document);
  h.coordinator.enrich(one); await settle(); h.shown.add(two); h.coordinator.enrich(two); await settle();
  h.shown.clear(); h.shown.add(three); h.coordinator.enrich(three); await settle();
  assert.deepEqual(cancelled, [1, 1]); assert.deepEqual(h.published, [three]);
  retries[0].resolve(details(one.document)); retries[1].resolve(details(two.document)); await h.done;
  assert.deepEqual(reads, [2, 2]); assert.equal(three.document.resultVersion, "result-version");
});

/** 느린 조회 프로세스를 실제로 종료한 뒤 다음 실제 Git metadata 조회가 시작되는지 검사한다. */
test("visible metadata starts after the obsolete owned process closes and preserves both Results", { timeout: 45_000 }, async t => {
  let phase = "fixture";
  t.after(() => t.diagnostic(`Metadata process test phase: ${phase}`));
  const { root } = await safetyFixture(t, "conflict-metadata-process");
  await writeFile(join(root, "other.txt"), "base\n"); await git(root, "add", "other.txt"); await git(root, "commit", "-qm", "two files");
  const base = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "other.txt"), "main\n"); await git(root, "add", "other.txt"); await commitText(root, "main\n", "main");
  await git(root, "switch", "-qc", "side", base);
  await writeFile(join(root, "other.txt"), "side\n"); await git(root, "add", "other.txt"); await commitText(root, "side\n", "side");
  await assert.rejects(git(root, "rebase", "main"));
  const service = new ConflictService(root), first = await service.getConflictDocument("tracked.txt", true, { deferMetadata: true });
  const second = await service.getConflictDocument("other.txt", true, { deferMetadata: true });
  phase = "documents ready";
  const hidden = { ...session(first.rel), service, document: first, content: first.result }, visible = { ...session(second.rel), service, document: second, content: second.result };
  const h = fixture(hidden, visible), started = deferred<void>(), spawn = childProcess.spawn;
  let blocked = true, blockedLog = true, closed = false, child: any, visibleStarted = false, startedBeforeClose = false;
  const owned: any[] = [], stopped = new Set<any>();
  t.after(() => { h.close(); for (const process of owned) if (!stopped.has(process)) process.kill(); });
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (blockedLog && args[0] === "git" && args[1][0] === "log" && args[1].includes("-1") && args[1].at(-1) === hidden.rel) {
      blockedLog = false;
      const fast = (spawn as Function)(process.execPath, ["-e", "setInterval(() => {}, 1000)"], args[2]);
      owned.push(fast); fast.once("close", () => stopped.add(fast)); return fast;
    }
    if (blocked && args[0] === "git" && args[1][0] === "ls-tree" && args[1].at(-1) === hidden.rel) {
      blocked = false;
      const script = "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)";
      child = (spawn as Function)(process.execPath, ["-e", script], args[2]); owned.push(child);
      child.stdout.once("data", () => started.resolve()); child.once("close", () => { closed = true; stopped.add(child); }); return child;
    }
    return (spawn as Function)(...args);
  });
  const original = service.getConflictDocumentMetadata.bind(service);
  t.mock.method(service, "getConflictDocumentMetadata", (document, signal) => {
    if (document.rel === visible.rel) { startedBeforeClose = !closed; visibleStarted = true; }
    return original(document, signal);
  });
  h.coordinator.enrich(hidden); phase = "waiting for owned process"; await started.promise;
  phase = "visible request queued"; h.shown.add(visible); h.coordinator.enrich(visible); await h.done;
  phase = "both metadata results published";
  assert.equal(visibleStarted, true); assert.equal(closed, true); assert.equal(h.published[0], visible);
  assert.deepEqual(h.errors, []); assert.equal(startedBeforeClose, false, "obsolete lookup must finish closing before the slot is reused");
  for (const target of [hidden, visible]) {
    assert.equal(target.document.result, await readFile(join(root, target.rel), "utf8"));
    assert.equal(target.document.resultVersion, target === hidden ? first.resultVersion : second.resultVersion);
    assert.equal(target.document.metadataState, "ready");
  }
});
