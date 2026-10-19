import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Uri } from "vscode";
import { GitGraphPanel } from "../src/webview/graphPanel";
import type { Commit } from "../src/graph/graphTypes";
import type { ToWebviewMessage } from "../src/webview/graphProtocol";

/** 완료 순서를 테스트가 결정해 느린 status와 빠른 log를 시간 지연 없이 재현한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** 실제 GraphPanel paging과 layout을 실행하되 Git 조회와 웹뷰 transport만 대체한다. */
function fixture(t: TestContext) {
  // 기존 최소 Uri 대역에 HTML 리소스 버전 주입이 사용하는 with 계약만 시험 범위에서 보충한다.
  t.mock.method(Uri, "joinPath", (...parts: unknown[]) => {
    const uri = { query: "", with: () => uri, toString: () => parts.join("/") }; return uri;
  });
  const status = deferred<Commit[]>();
  const statusSignals: AbortSignal[] = [];
  const messages: ToWebviewMessage[] = [];
  const commits: Commit[] = Array.from({ length: 601 }, (_, index) => ({
    hash: `commit-${index}`, parents: index < 600 ? [`commit-${index + 1}`] : [],
    refs: index === 0 ? ["HEAD", "main"] : [], authorName: "Graph Test",
    authorEmail: "graph@example.invalid", dateIso: "2026-10-18T00:00:00Z", subject: `Commit ${index}`,
  }));
  const service = {
    repoRoot: "/fixture/initial-graph",
    getCommitPage: async (limit: number, skip: number) => commits.slice(skip, skip + limit),
    getVirtualCommits: (signal?: AbortSignal) => { if (signal) statusSignals.push(signal); return status.promise; },
    applyWarmLocalOnlyBranches: () => true,
    cancelGraphBranchContainment: () => undefined,
    resetGraphBranchIndex: () => undefined,
  };
  const surface = { visible: true, disposed: false, dispose: () => { surface.disposed = true; },
    onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
    webview: { html: "", cspSource: "fixture:", asWebviewUri: (uri: unknown) => {
        const resource = { query: "", with: () => resource, toString: () => String(uri) }; return resource;
      },
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: (message: ToWebviewMessage) => {
        if (surface.disposed) throw new Error("Webview is disposed");
        messages.push(JSON.parse(JSON.stringify(message))); return Promise.resolve(true);
      },
    },
  };
  const panel: any = new (GitGraphPanel as any)(surface, Uri.file("/fixture/extension"), service);
  panel.lastLocalBranches = [{ name: "main", current: true }];
  t.after(() => { status.resolve([]); panel.dispose(); });
  return { panel, service, status, statusSignals, messages, commits, surface };
}

/** 실제 Git 서비스와 같은 ongoing/staged 부모 연결을 가진 가상 상태를 만든다. */
function virtualCommits(): Commit[] {
  const common = { authorName: "", authorEmail: "", dateIso: "", refs: [] };
  return [
    { ...common, hash: "__gsc_virtual_ongoing__", parents: ["__gsc_virtual_staged__"], subject: "Working tree", kind: "ongoing" },
    { ...common, hash: "__gsc_virtual_staged__", parents: ["commit-0"], subject: "Staged", kind: "staged" },
  ];
}

/** Promise 연결과 상태 게시를 끝까지 소비하되 실제 시간 경과에 의존하지 않는다. */
async function settle(): Promise<void> { for (let index = 0; index < 12; index++) await Promise.resolve(); }

/** 첫 paint payload가 준비되는지만 짧게 기다려 status 완료에 종속된 회귀를 판별한다. */
async function firstGraph(messages: ToWebviewMessage[]): Promise<Extract<ToWebviewMessage, { type: "graph" }>> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const graph = messages.find((message): message is Extract<ToWebviewMessage, { type: "graph" }> => message.type === "graph");
    if (graph) return graph;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Commit history must be published before the suspended working-tree status finishes");
}

test("initial commit history and the next page stay usable while working-tree status is suspended", { timeout: 5000 }, async t => {
  const f = fixture(t);
  const initial = f.panel.loadNextPage(true);
  const graph = await firstGraph(f.messages);
  assert.equal(graph.data.rows.length, 300);
  assert.equal(graph.state.loading, false);
  assert.equal(graph.state.hasMore, true);
  assert.equal(graph.state.workingTree?.loading, true);
  await initial;
  await f.panel.loadNextPage(false, "older");
  assert.equal(f.panel.commits.length, 600);
  assert.equal(f.statusSignals.length, 1);
  assert.equal(f.statusSignals[0].aborted, false, "pagination must not cancel the initial working-tree consumer");
  f.status.resolve([]);
});

test("a quick working-tree result joins the first history payload without an extra render", { timeout: 5000 }, async t => {
  const f = fixture(t), log = deferred<Commit[]>();
  f.service.getCommitPage = () => log.promise;
  const initial = f.panel.loadNextPage(true);
  f.status.resolve(virtualCommits());
  await settle();
  log.resolve(f.commits.slice(0, 301));
  await initial;
  const graph = await firstGraph(f.messages);
  assert.equal(graph.data.rows.length, 302);
  assert.equal(graph.state.workingTree, null);
  assert.equal(f.messages.filter(message => message.type === "graph" || message.type === "graphDelta").length, 1);
});

test("paging after ref reuse reconciles a changed topo order without dropping or duplicating commits", { timeout: 5000 }, async t => {
  const f = fixture(t);
  await f.panel.loadNextPage(true);
  f.panel.reconcilePageOrder = true;
  const reordered = [...f.commits.slice(250, 350), ...f.commits.slice(0, 250), ...f.commits.slice(350)];
  const reads: number[][] = [];
  f.service.getCommitPage = async (limit: number, skip: number) => { reads.push([limit, skip]); return reordered.slice(skip, skip + limit); };
  await f.panel.loadNextPage(false, "older");
  assert.deepEqual(reads, [[601, 0]]);
  assert.deepEqual(f.panel.commits.map((commit: Commit) => commit.hash), reordered.slice(0, 600).map(commit => commit.hash));
  assert.equal(new Set(f.panel.commits.map((commit: Commit) => commit.hash)).size, 600);
  assert.equal(f.panel.reconcilePageOrder, false);
  await f.panel.loadNextPage(false, "older");
  assert.deepEqual(reads.at(-1), [301, 600]);
  assert.equal(f.panel.commits.length, 601);
  assert.equal(f.panel.exhausted, true);
});

test("a late working-tree result preserves all loaded pages and explicitly clears serialized pending state", { timeout: 5000 }, async t => {
  const f = fixture(t);
  await f.panel.loadNextPage(true);
  await f.panel.loadNextPage(false, "older");
  f.status.resolve(virtualCommits());
  await settle();
  const graph = f.messages.findLast((message): message is Extract<ToWebviewMessage, { type: "graph" }> => message.type === "graph");
  assert.equal(graph?.data.rows.length, 602);
  assert.deepEqual(graph.data.rows.slice(2).map(row => row.hash), f.commits.slice(0, 600).map(commit => commit.hash));
  assert.equal(graph.state.reset, false);
  assert.equal(graph.state.loadDirection, "newer", "inserting virtual rows must preserve the visible commit anchor");
  assert.equal(graph.state.workingTree, null);
  assert.equal(graph.state.loading, false);
});

test("working-tree failure retains visible history and reports a separate localized status", { timeout: 5000 }, async t => {
  const f = fixture(t);
  await f.panel.loadNextPage(true);
  const payloadCount = f.messages.filter(message => message.type === "graph" || message.type === "graphDelta").length;
  f.status.reject(new Error("status deadline"));
  await settle();
  assert.equal(f.panel.commits.length, 300);
  const state = f.messages.findLast((message): message is Extract<ToWebviewMessage, { type: "graphLoadState" }> => message.type === "graphLoadState")?.state;
  assert.equal(state?.loading, false);
  assert.equal(state?.workingTree?.loading, false);
  assert.match(state?.workingTree?.detail ?? "", /status deadline/);
  assert.equal(f.messages.filter(message => message.type === "graph" || message.type === "graphDelta").length, payloadCount);
  assert.equal(f.messages.some(message => message.type === "graphHealth"), false, "a status failure must not clear graph health or erase history");
});

for (const change of ["repository", "generation", "dispose"] as const) {
  test(`a late working-tree result cannot publish after ${change}`, { timeout: 5000 }, async t => {
    const f = fixture(t);
    await f.panel.loadNextPage(true);
    const previous = f.messages.length;
    if (change === "repository") f.panel.logService = { ...f.service, repoRoot: "/fixture/other" };
    else if (change === "generation") f.panel.loadGeneration++;
    else f.panel.disposed = true;
    f.status.resolve(virtualCommits());
    await settle();
    assert.equal(f.messages.length, previous);
    assert.deepEqual(f.panel.virtualCommits, []);
  });
}

test("reset cancels the old status and accepts only the fresh generation", { timeout: 5000 }, async t => {
  const f = fixture(t), latest = deferred<Commit[]>();
  t.after(() => latest.resolve([]));
  await f.panel.loadNextPage(true);
  f.panel.resetLoadedGraph();
  assert.equal(f.statusSignals[0].aborted, true);
  f.service.getVirtualCommits = () => latest.promise;
  await f.panel.loadNextPage(true);
  f.status.resolve(virtualCommits());
  await settle();
  assert.deepEqual(f.panel.virtualCommits, []);
  assert.equal(f.panel.workingTree.state.loading, true);
  latest.resolve([]);
  await settle();
  assert.equal(f.panel.workingTree.state, undefined);
});

test("pause and resume reload only the incomplete working-tree state while preserving 600 history rows", { timeout: 5000 }, async t => {
  const f = fixture(t), resumed = deferred<Commit[]>();
  t.after(() => resumed.resolve([]));
  await f.panel.loadNextPage(true);
  await f.panel.loadNextPage(false, "older");
  f.panel.pauseLoadedGraph();
  assert.equal(f.statusSignals[0].aborted, true);
  assert.equal(f.panel.commits.length, 600);
  assert.equal(f.panel.resumeReloadOnFocus, false);
  f.service.getVirtualCommits = () => resumed.promise;
  f.panel.workingTree.resume();
  f.status.resolve(virtualCommits());
  await settle();
  assert.deepEqual(f.panel.virtualCommits, []);
  resumed.resolve(virtualCommits());
  await settle();
  assert.equal(f.panel.commits.length, 600);
  assert.equal(f.panel.virtualCommits.length, 2);
  assert.equal(f.panel.workingTree.state, undefined);
});

test("history read failure cancels the independent status consumer", { timeout: 5000 }, async t => {
  const f = fixture(t), failure = new Error("log failed");
  f.service.getCommitPage = async () => { await settle(); throw failure; };
  await assert.rejects(f.panel.loadNextPage(true), error => error === failure);
  assert.equal(f.statusSignals[0].aborted, true);
  assert.equal(f.panel.workingTree.state, undefined);
});

test("a branch filter excluding HEAD does not start working-tree status", { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.panel.currentBranchFilter = () => ({ mode: "selected", refs: ["other"], visibleRefs: new Set(["other"]), filtersRefs: true, empty: false });
  await f.panel.loadNextPage(true);
  assert.equal(f.statusSignals.length, 0);
  assert.equal(f.panel.workingTree.state, undefined);
});

test("an empty history still receives later uncommitted virtual rows", { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.service.getCommitPage = async () => [];
  await f.panel.loadNextPage(true);
  assert.equal((await firstGraph(f.messages)).data.rows.length, 0);
  f.status.resolve(virtualCommits());
  await settle();
  assert.equal(f.panel.virtualCommits.length, 2);
  const last = f.messages.findLast((message): message is Extract<ToWebviewMessage, { type: "graph" }> => message.type === "graph");
  assert.equal(last?.data.rows.length, 2);
  assert.equal(last.state.workingTree, null);
});

for (const outcome of ["missing", "failed"] as const) {
  test(`a ${outcome} commit-window jump resumes pending status and retains the current history`, { timeout: 5000 }, async t => {
    const f = fixture(t), resumed = deferred<Commit[]>();
    t.after(() => resumed.resolve([]));
    await f.panel.loadNextPage(true);
    let reads = 0;
    f.service.getVirtualCommits = () => { reads++; return resumed.promise; };
    const failure = new Error("window failed");
    const jumping = f.panel.showCommitWindow("commitWindow", async () => {
      if (outcome === "failed") throw failure;
      return undefined;
    });
    if (outcome === "failed") await assert.rejects(jumping, error => error === failure);
    else assert.equal(await jumping, undefined);
    await settle();
    assert.equal(reads, 1, "keeping the existing graph must resume its incomplete working-tree read");
    assert.equal(f.panel.commits.length, 300);
    assert.equal(f.panel.loading, false);
    assert.equal(f.statusSignals[0].aborted, true);
    resumed.resolve(virtualCommits());
    await settle();
    assert.equal(f.panel.virtualCommits.length, 2);
    assert.equal(f.panel.workingTree.state, undefined);
  });
}

test("a completed working-tree failure remains visible after pause and resume until a successful retry", { timeout: 5000 }, async t => {
  const f = fixture(t);
  await f.panel.loadNextPage(true);
  f.status.reject(new Error("status failed"));
  await settle();
  const unavailable = f.panel.workingTree.state;
  f.panel.pauseLoadedGraph();
  f.panel.workingTree.resume();
  assert.deepEqual(f.panel.workingTree.state, unavailable);
  await f.panel.loadNextPage(false, "older");
  const latest = f.messages.findLast((message): message is Extract<ToWebviewMessage, { type: "graphDelta" }> => message.type === "graphDelta");
  assert.deepEqual(latest?.state.workingTree, unavailable);
});

test("closing a real disposed webview cancels status without posting cleanup messages to it", { timeout: 5000 }, async t => {
  const f = fixture(t);
  await f.panel.loadNextPage(true);
  f.surface.dispose();
  assert.doesNotThrow(() => f.panel.dispose());
  assert.equal(f.statusSignals[0].aborted, true);
});
