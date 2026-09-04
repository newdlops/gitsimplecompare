import assert from "node:assert/strict";
import test from "node:test";
import { GraphBranchCatalog } from "../src/git/graphBranchCatalog";
import {
  GraphBranchLoadingCoordinator,
  graphBranchFilterNeedsReconcile,
  isCurrentGraphLoad,
  loadGraphLocalBranchData,
  mergeGraphBranchRefs,
  resolveGraphBranchFilter,
  settleDeferredGraphPage,
} from "../src/webview/graphBranchLoading";
import { normalizeBranchFilterState } from "../src/webview/graphBranchFilter";

const FS = "\x1f";
const remoteLine = (hash: string, name: string) => [hash, name, `refs/remotes/${name}`].join(FS);
const settleAsyncRead = () => new Promise<void>((resolve) => setImmediate(resolve));

test("local branch data does not start a separate local refs scan", async () => {
  const calls: string[] = [];
  const local = await loadGraphLocalBranchData(
    "/repo",
    async () => { calls.push("local-status"); return [{ name: "main", hash: "tip", current: true, upstream: undefined, ahead: 0, behind: 0, gone: false, dateIso: "", subject: "" }]; },
    async () => { calls.push("worktrees"); return []; }
  );
  assert.deepEqual(calls.sort(), ["local-status", "worktrees"]);
  assert.deepEqual(local.refs, [{ name: "main", kind: "local" }]);
  assert.deepEqual(local.invalidRefs, []);
});

test("local branch snapshot carries damaged refs while exposing only healthy filter refs", async () => {
  const local = await loadGraphLocalBranchData(
    "/repo",
    async () => ({
      branches: [{ name: "main", hash: "tip", current: true, upstream: undefined, ahead: 0, behind: 0, gone: false, dateIso: "", subject: "" }],
      invalidRefs: [{ name: "broken", fullRef: "refs/heads/broken", hash: "missing", kind: "local" }],
    }),
    async () => []
  );
  assert.deepEqual(local.refs, [{ name: "main", kind: "local" }]);
  assert.equal(local.invalidRefs[0]?.name, "broken");
  const filter = resolveGraphBranchFilter(
    normalizeBranchFilterState("all"),
    [...local.refs, { name: "origin/main", kind: "remote" }],
    "ready",
    true
  );
  assert.deepEqual(filter.refs, ["main", "origin/main"]);
  assert.equal(filter.filtersRefs, true);
});

test("linked worktrees share one common-dir remote read while retaining consumer results", async () => {
  const calls: string[][] = [];
  let release: ((value: string) => void) | undefined;
  const catalog = new GraphBranchCatalog(async (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") return "/repos/project/.git\n";
    return await new Promise<string>((resolve) => { release = resolve; });
  });
  const first = catalog.getRemoteTips("/repos/project");
  const second = catalog.getRemoteTips("/repos/project-worktree");
  await settleAsyncRead();
  assert.equal(calls.filter((args) => args[0] === "for-each-ref").length, 1);
  release!(remoteLine("remote-tip", "origin/main"));
  const [one, two] = await Promise.all([first, second]);
  assert.deepEqual(one, two);
  assert.deepEqual(one, [{ hash: "remote-tip", name: "origin/main", fullRef: "refs/remotes/origin/main", kind: "remote" }]);
});

test("one subscriber cancellation keeps a shared remote read alive; the last cancellation aborts it", async () => {
  let aborts = 0;
  let release: ((value: string) => void) | undefined;
  const catalog = new GraphBranchCatalog(async (args, _root, options) => {
    if (args[0] === "rev-parse") return "/common/.git\n";
    return await new Promise<string>((resolve, reject) => {
      release = resolve;
      options?.signal?.addEventListener("abort", () => { aborts++; reject(new DOMException("cancelled", "AbortError")); }, { once: true });
    });
  });
  const left = new AbortController(); const right = new AbortController();
  const first = catalog.getRemoteTips("/one", left.signal);
  const second = catalog.getRemoteTips("/two", right.signal);
  await settleAsyncRead(); left.abort();
  await assert.rejects(first, /cancelled/);
  assert.equal(aborts, 0);
  release!(remoteLine("tip", "origin/main"));
  assert.equal((await second)[0].name, "origin/main");

  catalog.invalidate("/one");
  const only = new AbortController();
  const last = catalog.getRemoteTips("/three", only.signal);
  await settleAsyncRead(); only.abort();
  await assert.rejects(last, /cancelled/);
  await settleAsyncRead();
  assert.equal(aborts, 1);
});

test("delayed linked common-dir resolution keeps a zero-subscriber read alive for the arriving consumer", async () => {
  let releaseCommon: ((value: string) => void) | undefined;
  let releaseRemote: ((value: string) => void) | undefined;
  let aborts = 0;
  const catalog = new GraphBranchCatalog(async (args, root, options) => {
    if (args[0] === "rev-parse") return root === "/two" ? await new Promise<string>((resolve) => { releaseCommon = resolve; }) : "/common/.git\n";
    return await new Promise<string>((resolve, reject) => {
      releaseRemote = resolve;
      options?.signal?.addEventListener("abort", () => { aborts++; reject(new DOMException("cancelled", "AbortError")); }, { once: true });
    });
  });
  const firstController = new AbortController();
  const first = catalog.getRemoteTips("/one", firstController.signal);
  await settleAsyncRead();
  const second = catalog.getRemoteTips("/two");
  firstController.abort();
  await assert.rejects(first, /cancelled/);
  releaseCommon!("/common/.git\n");
  await settleAsyncRead();
  assert.equal(aborts, 0);
  releaseRemote!(remoteLine("tip", "origin/main"));
  assert.equal((await second)[0].name, "origin/main");
});

test("catalog epoch ignores an invalidated in-flight completion and caches only the new read", async () => {
  const releases: ((value: string) => void)[] = [];
  let remoteReads = 0;
  const catalog = new GraphBranchCatalog(async (args) => {
    if (args[0] === "rev-parse") return "/common/.git\n";
    remoteReads++;
    return await new Promise<string>((resolve) => releases.push(resolve));
  });
  const stale = catalog.getRemoteTips("/one");
  await settleAsyncRead();
  catalog.invalidate("/one");
  const current = catalog.getRemoteTips("/one");
  await settleAsyncRead();
  releases[0](remoteLine("old", "origin/old"));
  releases[1](remoteLine("new", "origin/main"));
  await Promise.all([stale, current]);
  assert.equal((await catalog.getRemoteTips("/one"))[0].name, "origin/main");
  assert.equal(remoteReads, 2);
});

test("remote hydration reconciles filters only when its log scope changes", () => {
  const state = normalizeBranchFilterState("all");
  const pending = resolveGraphBranchFilter(state, [{ name: "main", kind: "local" }], "pending");
  const ready = resolveGraphBranchFilter(state, mergeGraphBranchRefs([{ name: "main", kind: "local" }], [{ name: "origin/main", kind: "remote" }]), "ready");
  assert.equal(graphBranchFilterNeedsReconcile(pending, ready), true);
  assert.equal(graphBranchFilterNeedsReconcile(ready, ready), false);
});

test("repository switch and disposal cancel only the initiating delayed page service without late posts", async () => {
  for (const mode of ["switch", "dispose"] as const) {
    const oldService = { cancels: 0 }; const newService = { cancels: 0 };
    let current = oldService; let disposed = false; let resolvePage: (() => void) | undefined;
    let pagePosts = 0; let loadingPosts = 0;
    const delayed = new Promise<void>((resolve) => { resolvePage = resolve; });
    const settled = settleDeferredGraphPage({
      initiatingService: oldService, currentService: () => current, generation: 4, currentGeneration: () => 4,
      disposed: () => disposed, page: () => delayed, cancelInitiating: (service) => service.cancels++,
      postPage: () => pagePosts++, postLoadState: () => loadingPosts++,
    });
    oldService.cancels++; // GraphPanel.createOrShow/dispose가 교체 전에 old service를 취소하는 효과
    if (mode === "switch") current = newService; else disposed = true;
    resolvePage!();
    await settled;
    assert.ok(oldService.cancels >= 1);
    assert.equal(newService.cancels, 0);
    assert.equal(pagePosts, 0);
    assert.equal(loadingPosts, 0);
  }
});

test("rejected delayed page after disposal emits neither page nor finally loading post", async () => {
  const service = { cancels: 0 }; let disposed = false; let rejectPage: ((error: Error) => void) | undefined;
  let pagePosts = 0; let loadingPosts = 0;
  const delayed = new Promise<void>((_resolve, reject) => { rejectPage = reject; });
  const settled = settleDeferredGraphPage({
    initiatingService: service, currentService: () => service, generation: 5, currentGeneration: () => 5,
    disposed: () => disposed, page: () => delayed, cancelInitiating: (target) => target.cancels++,
    postPage: () => pagePosts++, postLoadState: () => loadingPosts++,
  });
  service.cancels++; disposed = true; rejectPage!(new Error("late page failed"));
  await assert.rejects(settled, /late page failed/);
  assert.equal(service.cancels, 1);
  assert.equal(pagePosts, 0);
  assert.equal(loadingPosts, 0);
});

test("coordinator skips inactive reads and suppresses a stale remote result", async () => {
  const requests: { resolve: (value: string) => void }[] = [];
  const catalog = new GraphBranchCatalog(async (args) => {
    if (args[0] === "rev-parse") return "/common/.git\n";
    return await new Promise<string>((resolve) => requests.push({ resolve }));
  });
  const coordinator = new GraphBranchLoadingCoordinator(catalog);
  const hidden = coordinator.begin("/one");
  assert.equal(await coordinator.loadRemote("/one", hidden, "v1", () => false), undefined);
  await settleAsyncRead();
  assert.equal(requests.length, 0);

  const active = coordinator.begin("/one");
  const pending = coordinator.loadRemote("/one", active, "v1", () => true);
  await settleAsyncRead();
  coordinator.begin("/two");
  requests[0].resolve(remoteLine("tip", "origin/main"));
  assert.equal(await pending, undefined);
});

test("local and remote snapshots start together and gate one final graph render", async () => {
  const ledger: string[] = [];
  let releaseLocal: (() => void) | undefined;
  let releaseRemote: (() => void) | undefined;
  const local = loadGraphLocalBranchData(
    "/repo",
    async () => { ledger.push("local-status"); await new Promise<void>((resolve) => { releaseLocal = resolve; }); return []; },
    async () => []
  );
  const catalog = new GraphBranchCatalog(async (args) => {
    ledger.push(args[0]);
    if (args[0] === "rev-parse") return "/common/.git\n";
    await new Promise<void>((resolve) => { releaseRemote = resolve; });
    return "";
  });
  const generation = new GraphBranchLoadingCoordinator(catalog);
  const token = generation.begin("/repo");
  const remote = generation.loadRemote("/repo", token, "v1", () => true);
  await settleAsyncRead();
  assert.deepEqual(ledger, ["local-status", "rev-parse", "for-each-ref"]);
  assert.equal(ledger.includes("graph"), false);
  releaseLocal!(); releaseRemote!();
  await Promise.all([local, remote]);
  ledger.push("graph");
  assert.equal(ledger.filter((event) => event === "graph").length, 1);
});

test("remote catalog reuses one semantic version and rereads only after the version changes", async () => {
  let remoteReads = 0;
  let commonDirReads = 0;
  const catalog = new GraphBranchCatalog(async (args) => {
    if (args[0] === "rev-parse") {
      commonDirReads++;
      return "/common/.git\n";
    }
    remoteReads++;
    return remoteLine(`tip-${remoteReads}`, "origin/main");
  });
  assert.equal((await catalog.getRemoteTips("/repo", undefined, "v1"))[0].hash, "tip-1");
  assert.equal((await catalog.getRemoteTips("/repo", undefined, "v1"))[0].hash, "tip-1");
  assert.equal((await catalog.getRemoteTips("/repo", undefined, "v2"))[0].hash, "tip-2");
  assert.equal(remoteReads, 2);
  assert.equal(commonDirReads, 1);
});
