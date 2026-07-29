import assert from "node:assert/strict";
import test from "node:test";
import { createGraphRefreshFingerprint } from "../src/git/graphRefreshFingerprint";
import { GraphRefreshContext, GraphRefreshLifecycleCoordinator, GraphRefreshMode } from "../src/webview/graphRefreshCoordinator";

/** 테스트가 reload/fingerprint 완료 시점을 시간 대기 없이 직접 제어할 수 있는 promise를 만든다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

/** 비동기 coordinator가 background transaction을 시작/완료할 때까지 microtask만 비운다. */
async function settle(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

/** production callback 경계를 기록하는 작은 coordinator harness를 만든다. */
function createHarness(fingerprints: string[]) {
  const reloads: GraphRefreshContext[] = [];
  const publications: Array<{ context: GraphRefreshContext; mode: GraphRefreshMode }> = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const reload = deferred<void>();
  let reloadGate: Promise<void> | undefined;
  const coordinator = new GraphRefreshLifecycleCoordinator({
    readFingerprint: async () => fingerprints.shift() ?? "same",
    reloadGraph: async (context) => { reloads.push(context); await (reloadGate ?? Promise.resolve()); },
    publishAfterReload: async (context, mode) => { publications.push({ context, mode }); },
    invalidateReload: () => undefined,
    info: (event, fields) => logs.push({ event, fields }),
    error: (event, _error, fields) => logs.push({ event, fields }),
  });
  return {
    coordinator, reloads, publications, logs,
    holdReload: () => { reloadGate = reload.promise; },
    releaseReload: () => reload.resolve(),
  };
}

test("direct 초기 load 뒤 동일 delete/focus burst는 Graph transaction을 추가하지 않는다", async () => {
  const harness = createHarness(["stable", "stable", "stable"]);
  await harness.coordinator.runDirect({ repoRoot: "/repo", cause: "ready" });
  await harness.coordinator.request({ repoRoot: "/repo", cause: "git:delete:stable-git-state", mode: "stacks" });
  await harness.coordinator.request({ repoRoot: "/repo", cause: "windowFocusedReconcile", mode: "stacks" });
  await settle();
  assert.equal(harness.reloads.length, 1);
  assert.equal(harness.publications.length, 0);
  assert.deepEqual(harness.logs.map(({ event }) => event), [
    "graph refresh start", "graph refresh complete",
    "graph refresh schedule", "graph refresh skip",
    "graph refresh schedule", "graph refresh skip",
  ]);
  for (const { fields } of harness.logs) {
    assert.equal(fields.repoRoot, "/repo");
    assert.equal(typeof fields.cause, "string");
    assert.equal(typeof fields.generation, "number");
    assert.equal(typeof fields.fingerprint, "string");
  }
});

test("실행 중 실제 변경과 force/PR 원인은 newest fingerprint와 strongest mode 한 건으로 병합한다", async () => {
  const harness = createHarness(["base", "changed", "newest"]);
  await harness.coordinator.runDirect({ repoRoot: "/repo", cause: "ready" });
  harness.holdReload();
  await harness.coordinator.request({ repoRoot: "/repo", cause: "vscodeGit:head", mode: "stacks" });
  await settle();
  await harness.coordinator.request({ repoRoot: "/repo", cause: "stackSubmitted", mode: "pullRequests", force: true });
  harness.releaseReload();
  await settle();
  assert.equal(harness.reloads.length, 3, "direct load + current transaction + one pending transaction");
  assert.equal(harness.publications.length, 1, "superseded generation must not publish");
  assert.equal(harness.publications[0].mode, "pullRequests");
  assert.equal(harness.reloads[2].cause, "stackSubmitted");
  assert.match(harness.logs.map(({ event }) => event).join(","), /schedule,graph refresh coalesce/);
});

test("hide/focus/repository switch/dispose는 stale completion을 게시하지 않고 reveal은 한 요청만 소비한다", async () => {
  const fingerprint = deferred<string>();
  const reload = deferred<void>();
  const publications: GraphRefreshMode[] = [];
  const coordinator = new GraphRefreshLifecycleCoordinator({
    readFingerprint: () => fingerprint.promise,
    reloadGraph: () => reload.promise,
    publishAfterReload: async (_context, mode) => { publications.push(mode); },
    invalidateReload: () => undefined,
    info: () => undefined,
    error: () => undefined,
  });
  const request = coordinator.request({ repoRoot: "/repo", cause: "head", mode: "stacks" });
  coordinator.setVisible(false);
  fingerprint.resolve("changed");
  await request;
  coordinator.setVisible(true);
  coordinator.setRepository("/other");
  reload.resolve();
  await settle();
  assert.deepEqual(publications, []);
  coordinator.dispose();
});

test("실패한 fingerprint는 재시도 가능하고 성공 뒤 동일 자동 요청은 skip되며 manual direct는 항상 한 번 실행한다", async () => {
  let failures = 1;
  let reloads = 0;
  const coordinator = new GraphRefreshLifecycleCoordinator({
    readFingerprint: async () => "same",
    reloadGraph: async () => { reloads++; if (failures--) throw new Error("reload failed"); },
    publishAfterReload: async () => undefined,
    invalidateReload: () => undefined,
    info: () => undefined,
    error: () => undefined,
  });
  await coordinator.request({ repoRoot: "/repo", cause: "head", mode: "stacks" });
  await settle();
  await coordinator.request({ repoRoot: "/repo", cause: "head", mode: "stacks" });
  await settle();
  await coordinator.request({ repoRoot: "/repo", cause: "head", mode: "stacks" });
  await settle();
  await coordinator.runDirect({ repoRoot: "/repo", cause: "refresh" });
  assert.equal(reloads, 3);
});

test("동일 lifecycle에서 뒤 요청의 fingerprint가 먼저 끝나도 이전 read는 newest pending을 덮어쓰지 않는다", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const reloads: GraphRefreshContext[] = [];
  let reads = 0;
  const coordinator = new GraphRefreshLifecycleCoordinator({
    readFingerprint: () => (++reads === 1 ? first.promise : second.promise),
    reloadGraph: async (context) => { reloads.push(context); },
    publishAfterReload: async () => undefined,
    invalidateReload: () => undefined,
    info: () => undefined,
    error: () => undefined,
  });
  const older = coordinator.request({ repoRoot: "/repo", cause: "old", mode: "stacks" });
  const newer = coordinator.request({ repoRoot: "/repo", cause: "new", mode: "pullRequests" });
  second.resolve("newest");
  await newer;
  first.resolve("older");
  await older;
  await settle();
  assert.deepEqual(reloads.map(({ cause }) => cause), ["new"]);
});

test("강한 stack intent read가 늦게 끝나도 뒤 watcher의 최신 fingerprint에는 force와 PR mode가 보존된다", async () => {
  const strong = deferred<string>();
  const weak = deferred<string>();
  const reloads: string[] = [];
  const publications: GraphRefreshMode[] = [];
  let reads = 0;
  const coordinator = new GraphRefreshLifecycleCoordinator({
    readFingerprint: () => [Promise.resolve("stable"), strong.promise, weak.promise][reads++]!,
    reloadGraph: async ({ cause }) => { reloads.push(cause); },
    publishAfterReload: async (_context, mode) => { publications.push(mode); },
    invalidateReload: () => undefined,
    info: () => undefined,
    error: () => undefined,
  });
  await coordinator.runDirect({ repoRoot: "/repo", cause: "ready" });
  const first = coordinator.request({ repoRoot: "/repo", cause: "stackSubmitted", mode: "pullRequests" });
  const second = coordinator.request({ repoRoot: "/repo", cause: "stable-git-state", mode: "stacks" });
  weak.resolve("stable");
  await second;
  strong.resolve("stable");
  await first;
  await settle();
  assert.deepEqual(reloads, ["ready", "stable-git-state"]);
  assert.deepEqual(publications, ["pullRequests"]);
});

test("같은 fingerprint의 강한 PR mode는 실행 중 reload에 합쳐 한 번 게시한다", async () => {
  const harness = createHarness(["base", "changed", "changed"]);
  await harness.coordinator.runDirect({ repoRoot: "/repo", cause: "ready" });
  harness.holdReload();
  await harness.coordinator.request({ repoRoot: "/repo", cause: "head", mode: "stacks" });
  await harness.coordinator.request({ repoRoot: "/repo", cause: "manualPr", mode: "pullRequests" });
  harness.releaseReload();
  await settle();
  assert.equal(harness.reloads.length, 2);
  assert.deepEqual(harness.publications.map(({ mode }) => mode), ["pullRequests"]);
});

test("실패한 active reload 뒤 대기한 최신 요청은 새 transaction으로 계속된다", async () => {
  const firstReload = deferred<void>();
  const reloads: string[] = [];
  const coordinator = new GraphRefreshLifecycleCoordinator({
    readFingerprint: async () => reloads.length === 0 ? "first" : "second",
    reloadGraph: async ({ cause }) => {
      reloads.push(cause);
      if (cause === "first") await firstReload.promise;
    },
    publishAfterReload: async () => undefined,
    invalidateReload: () => undefined,
    info: () => undefined,
    error: () => undefined,
  });
  await coordinator.request({ repoRoot: "/repo", cause: "first", mode: "stacks" });
  await coordinator.request({ repoRoot: "/repo", cause: "second", mode: "pullRequests" });
  firstReload.reject(new Error("first failed"));
  await settle();
  assert.deepEqual(reloads, ["first", "second"]);
});

test("focus 해제 중 active reconcile은 deferred로 보존하고 focus 복귀에서 한 번만 재시작한다", async () => {
  const activeReload = deferred<void>();
  const reloads: string[] = [];
  let reads = 0;
  const coordinator = new GraphRefreshLifecycleCoordinator({
    readFingerprint: async () => ["base", "changed", "changed"][reads++]!,
    reloadGraph: async ({ cause }) => {
      reloads.push(cause);
      if (reloads.length === 2) await activeReload.promise;
    },
    publishAfterReload: async () => undefined,
    invalidateReload: () => undefined,
    info: () => undefined,
    error: () => undefined,
  });
  await coordinator.runDirect({ repoRoot: "/repo", cause: "ready" });
  await coordinator.request({ repoRoot: "/repo", cause: "head", mode: "stacks" });
  coordinator.setFocused(false);
  activeReload.resolve();
  assert.equal(coordinator.setFocused(true), true);
  await settle();
  assert.deepEqual(reloads, ["ready", "head", "head"]);
});

test("automatic schedule과 start는 같은 generation 및 fingerprint digest를 기록한다", async () => {
  const harness = createHarness(["base", "changed"]);
  await harness.coordinator.runDirect({ repoRoot: "/repo", cause: "ready" });
  await harness.coordinator.request({ repoRoot: "/repo", cause: "head", mode: "stacks" });
  await settle();
  const schedule = harness.logs.find(({ event }) => event === "graph refresh schedule")!;
  const start = harness.logs.filter(({ event }) => event === "graph refresh start")[1]!;
  assert.deepEqual(schedule.fields, start.fields);
});

test("동일 repository의 늦은 direct 완료와 repository switch/direct 실패는 current success를 반환하지 않는다", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const reloads: string[] = [];
  const coordinator = new GraphRefreshLifecycleCoordinator({
    readFingerprint: async () => "newest",
    reloadGraph: async ({ cause }) => {
      reloads.push(cause);
      if (cause === "first") await first.promise;
      if (cause === "second") await second.promise;
      if (cause === "failed") throw new Error("failed");
    },
    publishAfterReload: async () => undefined,
    invalidateReload: () => undefined,
    info: () => undefined,
    error: () => undefined,
  });
  const oldDirect = coordinator.runDirect({ repoRoot: "/repo", cause: "first" });
  const currentDirect = coordinator.runDirect({ repoRoot: "/repo", cause: "second" });
  second.resolve();
  assert.equal(await currentDirect, true);
  first.resolve();
  assert.equal(await oldDirect, false);
  const switched = coordinator.runDirect({ repoRoot: "/repo", cause: "first" });
  coordinator.setRepository("/other");
  assert.equal(await switched, false);
  assert.equal(await coordinator.runDirect({ repoRoot: "/other", cause: "failed" }), false);
  assert.deepEqual(reloads, ["first", "second", "first", "failed"]);
});

test("ref와 worktree 출력 순서는 fingerprint에 영향을 주지 않는다", () => {
  assert.equal(
    createGraphRefreshFingerprint({ head: "abc", symbolicHead: "refs/heads/main", refs: ["b", "a"], worktrees: ["two", "one"] }),
    createGraphRefreshFingerprint({ head: "abc", symbolicHead: "refs/heads/main", refs: ["a", "b", "a"], worktrees: ["one", "two"] })
  );
});
