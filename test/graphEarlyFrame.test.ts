import assert from "node:assert/strict";
import test from "node:test";
import type { Commit, LocalBranchStatus } from "../src/graph/graphTypes";
import type { GitLogService } from "../src/git/gitLogService";
import type { GraphRefreshContext } from "../src/webview/graphRefreshCoordinator";
import { createOperationGraphPanel } from "./helpers/graphOperationPanel";

const A = "a".repeat(40), B = "b".repeat(40);

/** sleep 없이 브랜치 상세의 완료 시점을 제어하는 단일 gate다. */
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** 실제 fingerprint의 HEAD·전체 ref와 같은 최소 로그 페이지를 만든다. */
function commits(): Commit[] {
  return [{ hash: A, parents: [B], refs: ["HEAD", "main"], authorName: "Fixture", authorEmail: "fixture@example.invalid",
    dateIso: "2026-10-20T00:00:00Z", subject: "latest" },
  { hash: B, parents: [], refs: ["topic", "origin/main"], authorName: "Fixture", authorEmail: "fixture@example.invalid",
    dateIso: "2026-10-19T00:00:00Z", subject: "base" }];
}

/** Native 조회 결과와 같은 실제 값만 만들며, unknown 수치의 가짜 대체값으로 사용하지 않는다. */
function branches(current = "main"): LocalBranchStatus[] {
  return [["main", A], ["topic", B]].map(([name, hash]) => ({ name, hash, current: name === current,
    upstream: "origin/main", ahead: name === "main" ? 1 : 0, behind: 0, gone: false, dateIso: "2026-10-20T00:00:00Z", subject: name }));
}

/** 커밋 읽기와 상세 읽기를 분리해 first-frame 의존성과 중복 조회를 관찰한다. */
function fixture(current = "main") {
  const details = gate(), pageReady = gate(), counts = { raw: 0, fallback: 0, indexed: 0 };
  const page = commits();
  const service = {
    repoRoot: "/fixture", usesNativeBranchSnapshot: () => true,
    readUnindexedCommitPage: async () => { counts.raw++; pageReady.resolve(); return page; },
    readUnindexedCommitPageSnapshot: async () => { counts.raw++; pageReady.resolve(); return { page, headRef: "refs/heads/main" }; },
    getCommitPage: async () => { counts.fallback++; return page; }, indexGraphCommitPage: () => { counts.indexed++; },
    getLocalBranchSnapshot: async () => { await details.promise; return { branches: branches(current), invalidRefs: [] }; },
    getVirtualCommits: async () => [], seedGraphBranchTips: () => undefined,
    seedGraphReferenceIdentities: () => undefined, invalidateCaches: () => undefined,
    cancelGraphBranchContainment: () => undefined, resetGraphBranchIndex: () => undefined,
    applyWarmLocalOnlyBranches: () => true, attachLocalOnlyBranches: async () => 0,
    reindexGraphBranchContainment: async () => undefined,
  } as unknown as GitLogService;
  return { service, page, details, pageReady, counts };
}

/** 같은 Native ref 집합에서 checkout만 바꾼 새/이전 snapshot을 만든다. */
function context(current = "main", previous = false): GraphRefreshContext {
  const fingerprint = (name: string) => `${name === "main" ? A : B}\nrefs/heads/${name}\nrefs/heads/main ${A}\nrefs/heads/topic ${B}\nrefs/remotes/origin/main ${B}\n--worktrees--`;
  return { repoRoot: "/fixture", generation: 1, cause: previous ? "checkout" : "ready", fingerprint: fingerprint(current),
    historyIdentity: "fixture", remoteTips: [{ name: "origin/main", hash: B, fullRef: "refs/remotes/origin/main" }], worktrees: [],
    ...(previous ? { previous: { fingerprint: fingerprint("main"), historyIdentity: "fixture" } } : {}) };
}

/** 현재 turn의 모든 Promise 후속 처리를 소비해 타이밍 추측 없이 게시 여부를 확인한다. */
async function settle(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }

test("verified initial history reaches the Graph before slow branch details without another log read", async t => {
  const f = fixture(), { panel, messages } = createOperationGraphPanel(t, f.service);
  const pending = panel.reloadGraph(context());
  try {
    await f.pageReady.promise; await settle();
    const graph = messages.find(message => message.type === "graph");
    assert.ok(graph, "First history still waits for branch details");
    assert.equal(graph.state.branchDetails?.loading, true);
    assert.deepEqual(graph.data.rows.map(row => row.hash), [A, B]);
    assert.equal(f.counts.raw, 1); assert.equal(f.counts.fallback, 0);
  } finally { f.details.resolve(); await pending; panel.dispose(); }
  assert.equal(f.counts.indexed, 1); assert.equal(f.counts.fallback, 0);
  assert.equal(messages.filter(message => message.type === "graph").length, 1);
  assert.equal(panel.branchDetails.state, undefined);
});

test("without same-log symbolic HEAD proof the existing single-page adoption still waits for details", async t => {
  const f = fixture(), original = f.service.readUnindexedCommitPageSnapshot.bind(f.service);
  t.mock.method(f.service, "readUnindexedCommitPageSnapshot", async (...args: Parameters<typeof original>) => ({ page: (await original(...args)).page }));
  const { panel, messages } = createOperationGraphPanel(t, f.service), pending = panel.reloadGraph(context());
  try {
    await f.pageReady.promise; await settle();
    assert.equal(messages.some(message => message.type === "graph"), false);
  } finally { f.details.resolve(); await pending; panel.dispose(); }
  assert.equal(f.counts.raw, 1); assert.equal(f.counts.fallback, 0); assert.equal(f.counts.indexed, 1);
});

test("HEAD outside the first page waits for metadata and consumes the original log once", async t => {
  const f = fixture(), original = f.service.readUnindexedCommitPageSnapshot.bind(f.service);
  t.mock.method(f.service, "readUnindexedCommitPageSnapshot", async (...args: Parameters<typeof original>) => ({ page: (await original(...args)).page.slice(1) }));
  const { panel, messages } = createOperationGraphPanel(t, f.service), pending = panel.reloadGraph(context());
  try {
    await f.pageReady.promise; await settle();
    assert.equal(messages.some(message => message.type === "graph"), false);
    f.details.resolve(); await pending;
    assert.deepEqual(panel.commits.map((commit: Commit) => commit.hash), [B]);
    assert.equal(f.counts.raw, 1); assert.equal(f.counts.fallback, 0); assert.equal(f.counts.indexed, 1);
  } finally { f.details.resolve(); await pending; panel.dispose(); }
});

test("pausing an early frame retains history and ignores late metadata with no stuck spinner", async t => {
  const f = fixture(), { panel, messages } = createOperationGraphPanel(t, f.service), pending = panel.reloadGraph(context());
  try {
    await f.pageReady.promise; await settle(); panel.pauseLoadedGraph();
    assert.equal(panel.loading, false); assert.equal(panel.branchDetails.state.loading, false);
    assert.deepEqual(panel.commits.map((commit: Commit) => commit.hash), [A, B]);
    const before = messages.length;
    f.details.resolve(); await pending;
    assert.equal(messages.length, before, "A paused generation published late details");
  } finally { f.details.resolve(); await pending; panel.dispose(); }
});

test("metadata from a changed checkout cannot overwrite an early frame", async t => {
  const f = fixture("topic"), { panel, messages } = createOperationGraphPanel(t, f.service);
  const reconcile = t.mock.method(panel, "runDirectGraph", async () => true), pending = panel.reloadGraph(context());
  try {
    await f.pageReady.promise; await settle(); f.details.resolve(); await pending;
    assert.equal(messages.some(message => message.type === "branchStatus"), false);
    assert.equal(panel.loading, false); assert.equal(panel.branchDetails.state.loading, false);
    assert.equal(reconcile.mock.callCount(), 1);
    assert.deepEqual(panel.commits.filter((commit: Commit) => commit.refs.includes("HEAD")).map((commit: Commit) => commit.hash), [A]);
  } finally { f.details.resolve(); await pending; panel.dispose(); }
});

test("reference refresh preserves existing local-only markers until full details are ready", async t => {
  const f = fixture("topic"), { panel, messages } = createOperationGraphPanel(t, f.service);
  panel.commits = commits(); panel.commits[0].localOnlyBranches = ["main"]; panel.lastLocalBranches = branches();
  const pending = panel.refreshGraphReferences(context("topic", true));
  try {
    await settle(); assert.equal(messages.some(message => message.type === "branchIdentities"), false);
    assert.deepEqual(panel.commits[0].localOnlyBranches, ["main"]);
  } finally { f.details.resolve(); await pending; panel.dispose(); }
});

test("branch read failure keeps a verified early page and releases loading", async t => {
  const f = fixture(), failure = new Error("branch details deadline");
  t.mock.method(f.service, "getLocalBranchSnapshot", async () => { await f.details.promise; throw failure; });
  const { panel } = createOperationGraphPanel(t, f.service), pending = panel.reloadGraph(context());
  try {
    await f.pageReady.promise; await settle(); f.details.resolve();
    await assert.rejects(pending, error => error === failure);
    assert.equal(panel.commits.length, 2); assert.equal(panel.loading, false);
    assert.equal(panel.branchDetails.state.loading, false); assert.equal(panel.branchDetails.state.detail, failure.message);
  } finally { f.details.resolve(); await pending.catch(() => undefined); panel.dispose(); }
});

test("reused history keeps the existing reference path and updates HEAD after fresh branch details", async t => {
  const f = fixture("topic"), { panel, messages } = createOperationGraphPanel(t, f.service);
  panel.commits = commits(); panel.lastLocalBranches = branches();
  const pending = panel.refreshGraphReferences(context("topic", true));
  try {
    await settle();
    assert.equal(messages.some(message => message.type === "graph" || message.type === "branchIdentities"), false);
    assert.equal(f.counts.raw, 0); assert.equal(f.counts.fallback, 0);
  } finally { f.details.resolve(); await pending; panel.dispose(); }
  const graph = messages.find(message => message.type === "graph");
  assert.ok(graph);
  assert.deepEqual(graph.data.rows.filter(row => row.refs.includes("HEAD")).map(row => row.hash), [B]);
});
