import assert from "node:assert/strict";
import test from "node:test";
import { GraphActionRefreshQueue, deferGraphActionRefresh } from "../src/webview/graphActionRefresh";
import { withGraphBusy } from "../src/webview/graphPanelRendering";
import { GraphPanelMessageRouter, type GraphPanelMessageRouterDeps } from "../src/webview/graphPanelMessageRouter";
import type { GitLogService } from "../src/git/gitLogService";
import type { ToWebviewMessage } from "../src/webview/graphProtocol";
import { __errorMessages } from "./helpers/vscodeMock";

/** 수동 해제 전에는 끝나지 않는 조회로 실제 대기 순서와 병합 동작을 검증한다. */
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
/** 현재 turn의 비동기 drain을 완료해 임의의 긴 대기 없이 결과를 관찰한다. */
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("Git completion releases busy before a slow display refresh and late Undo refreshes still work", async () => {
  const gate = barrier(), events: string[] = [];
  const queue = new GraphActionRefreshQueue({ currentRepository: () => "/repo", info: () => {}, error: error => { throw error; },
    refresh: async kind => { events.push(kind); await gate.promise; } });
  const deferred = deferGraphActionRefresh(queue, "/repo");
  await withGraphBusy("push-graph", async () => { await deferred.refreshCheckout(); await deferred.refreshGraph(); }, message => {
    if (message.type === "graphBusy") events.push(`busy:${message.busy}`);
  });
  assert.deepEqual(events, ["busy:true", "busy:false"]);
  deferred.complete();
  assert.deepEqual(events, ["busy:true", "busy:false", "graph"]);
  gate.release(); await turn();
  await deferred.refreshCheckout(); await turn();
  assert.deepEqual(events, ["busy:true", "busy:false", "graph", "checkout"]);
  queue.dispose();
});

test("a burst during display refresh reads only one latest follow-up and preserves full graph intent", async () => {
  const gate = barrier(), reads: string[] = [];
  const queue = new GraphActionRefreshQueue({ currentRepository: () => "/repo", info: () => {}, error: error => { throw error; },
    refresh: async kind => { reads.push(kind); if (reads.length === 1) await gate.promise; } });
  queue.request("/repo", "checkout");
  queue.request("/repo", "graph");
  for (let index = 0; index < 100; index++) queue.request("/repo", "checkout");
  assert.deepEqual(reads, ["checkout"]);
  gate.release(); await turn();
  assert.deepEqual(reads, ["checkout", "graph"]);
  queue.dispose();
});

test("repository switches and disposal discard stale queued reads without preventing the next repository", async () => {
  let current = "/first";
  const gate = barrier(), reads: string[] = [];
  const queue = new GraphActionRefreshQueue({ currentRepository: () => current, info: () => {}, error: error => { throw error; },
    refresh: async kind => { reads.push(`${current}:${kind}`); if (reads.length === 1) await gate.promise; } });
  queue.request(current, "graph"); queue.request(current, "checkout");
  current = "/second";
  queue.request("/first", "graph"); queue.request(current, "checkout");
  gate.release(); await turn();
  assert.deepEqual(reads, ["/first:graph", "/second:checkout"]);
  queue.dispose(); queue.request(current, "graph"); await turn();
  assert.equal(reads.length, 2);
});

test("a failed refresh reports its error and a later action can refresh again", async () => {
  const errors: unknown[] = [];
  let reads = 0;
  const queue = new GraphActionRefreshQueue({ currentRepository: () => "/repo", info: () => {}, error: error => { errors.push(error); },
    refresh: async () => { if (++reads === 1) throw new Error("display read unavailable"); } });
  queue.request("/repo", "graph"); await turn(); queue.request("/repo", "checkout"); await turn();
  assert.equal(reads, 2); assert.equal(errors.length, 1); queue.dispose();
});

for (const fail of [false, true]) {
  test(`fetch pipeline deduplicates duplicate IPC and completes before the graph refresh (failure: ${fail})`, { timeout: 5000 }, async t => {
    const network = barrier(), display = barrier();
    const previousErrors = __errorMessages.length;
    const messages: ToWebviewMessage[] = [], events: string[] = [];
    let fetches = 0;
    const service = { repoRoot: "/repo", fetchAll: async () => {
      fetches++; await network.promise; if (fail) throw new Error("fetch failed after a partial update");
    } } as unknown as GitLogService;
    const router = new GraphPanelMessageRouter({ logService: () => service, post: message => { messages.push(message); },
      withBusy: (key, action) => withGraphBusy(key, action, message => {
        messages.push(message); if (message.type === "graphBusy") events.push(`busy:${message.busy}`);
      }),
      refreshAfterGraphAction: async () => { events.push("refresh"); await display.promise; },
    } as GraphPanelMessageRouterDeps);
    t.after(() => { network.release(); display.release(); router.cancelPullRequestLoading("dispose"); });
    const action = router.handle({ type: "fetch" });
    await turn(); await router.handle({ type: "fetch" });
    assert.equal(fetches, 1); assert.deepEqual(events, ["busy:true"]);
    network.release(); await action;
    assert.deepEqual(events, ["busy:true", "busy:false", "refresh"]);
    assert.equal(__errorMessages.length - previousErrors, fail ? 1 : 0);
    if (fail) assert.match(__errorMessages.at(-1)!, /fetch failed after a partial update/);
    display.release(); await turn();
  });
}

test("an early refresh reconciliation error clears immediate pending feedback without starting a graph read", async t => {
  const messages: ToWebviewMessage[] = [];
  let reads = 0;
  const router = new GraphPanelMessageRouter({ logService: () => ({ repoRoot: "/repo" } as GitLogService),
    post: message => { messages.push(message); },
    withBusy: (key, action) => withGraphBusy(key, action, message => { messages.push(message); }),
    reloadGraph: async () => { reads++; return true; },
  } as GraphPanelMessageRouterDeps);
  t.after(() => router.cancelPullRequestLoading("dispose"));
  t.mock.method(router, "synchronizeRebaseSession", async () => { throw new Error("early rebase read unavailable"); });
  await router.handle({ type: "refresh" });
  assert.equal(reads, 0);
  assert.deepEqual(messages.filter(message => message.type === "graphBusy"), [
    { type: "graphBusy", key: "refresh-graph", busy: true }, { type: "graphBusy", key: "refresh-graph", busy: false },
  ]);
  assert.equal(messages.some(message => message.type === "error"), true);
});
