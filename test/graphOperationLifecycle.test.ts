import assert from "node:assert/strict";
import test from "node:test";
import { GraphRefreshLifecycleCoordinator } from "../src/webview/graphRefreshCoordinator";
import { deferGraphActionRefresh, GraphActionRefreshQueue } from "../src/webview/graphActionRefresh";

/** 자동 transaction의 완료까지 실제 시간 지연 없이 소비한다. */
async function settle() { await new Promise<void>(resolve => setImmediate(resolve)); }

test("a fast action adopts its exact fingerprint so the matching watcher does not reload again", async () => {
  let fingerprint = "before", fullReads = 0, fastReads = 0;
  const coordinator = new GraphRefreshLifecycleCoordinator({
    readFingerprint: async () => ({ fingerprint }), reloadGraph: async () => { fullReads++; },
    publishAfterReload: async () => undefined, invalidateReload: () => undefined, info: () => undefined, error: error => { throw error; },
  });
  await coordinator.runDirect({ repoRoot: "/repo", cause: "ready" });
  fingerprint = "after";
  assert.equal(await coordinator.runDirect({ repoRoot: "/repo", cause: "checkout" }, async context => {
    assert.equal(context.previous?.fingerprint, "before"); assert.equal(context.fingerprint, "after"); fastReads++;
  }), true);
  await coordinator.request({ repoRoot: "/repo", cause: "watcher", mode: "none" }); await settle();
  assert.equal(fastReads, 1); assert.equal(fullReads, 1);
  coordinator.dispose();
});

test("hidden command completion defers one current reconciliation instead of starting invisible Git reads", async () => {
  let reads = 0, reloads = 0;
  const coordinator = new GraphRefreshLifecycleCoordinator({
    readFingerprint: async () => { reads++; return "current"; }, reloadGraph: async () => { reloads++; },
    publishAfterReload: async () => undefined, invalidateReload: () => undefined, info: () => undefined, error: error => { throw error; },
  });
  coordinator.setVisible(false);
  assert.equal(await coordinator.runDirect({ repoRoot: "/repo", cause: "checkout" }), false);
  assert.equal(reads, 0);
  coordinator.setVisible(true); await settle();
  assert.equal(reads, 1); assert.equal(reloads, 1);
  coordinator.dispose();
});

test("coalescing push references and checkout preserves a required full refresh for a following merge", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const queue = new GraphActionRefreshQueue({ currentRepository: () => "/repo", info: () => undefined, error: error => { throw error; },
    refresh: async kind => { calls.push(kind); if (calls.length === 1) await waiting; } });
  const push = deferGraphActionRefresh(queue, "/repo", "references");
  await push.refreshGraph(); push.complete();
  queue.request("/repo", "references"); queue.request("/repo", "checkout"); queue.request("/repo", "graph"); queue.request("/repo", "checkout");
  assert.deepEqual(calls, ["references"]);
  release(); await settle();
  assert.deepEqual(calls, ["references", "graph"]);
  queue.dispose();
});
