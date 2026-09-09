import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { ConflictService, type MergeOperation } from "../src/git/conflictService";
import { tryAcquireConflictMutation } from "../src/git/conflictMutationCoordinator";
import { GitLogService } from "../src/git/gitLogService";
import { RebaseService, type RebasePlanInfo } from "../src/git/rebaseService";
import { GitGraphPanel } from "../src/webview/graphPanel";
import { GraphPanelMessageRouter, type GraphPanelMessageRouterDeps } from "../src/webview/graphPanelMessageRouter";
import { GraphRefreshLifecycleCoordinator } from "../src/webview/graphRefreshCoordinator";
import { GraphRebaseSessionSync } from "../src/webview/graphRebaseSession";
import type { ToWebviewMessage } from "../src/webview/graphProtocol";
import { createGitMetadataRefreshHandler } from "../src/providers/refreshWatcher";
import { RepositoryRefreshSkipFence } from "../src/utils/extensionRefreshPolicy";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";
import { Uri, window } from "./helpers/vscodeMock";

/** 늦은 Git 응답과 후속 UI 메시지의 순서를 실제 timer 없이 고정한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

/** 현재 event loop의 예약 작업만 진행해 burst가 실행되도록 한다. */
function settle(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }

/**
 * 실제 UI 전송처럼 post 메시지를 다시 관찰하는 동기화 경계를 만든다.
 * @param t sync 수명을 종료할 테스트
 * @param read native 작업 조회 대역. 기본값은 종료된 저장소다.
 * @returns 실제 coordinator와 게시한 메시지
 */
function syncFixture(t: TestContext, read: (root: string) => Promise<MergeOperation> = async () => "none") {
  const messages: ToWebviewMessage[] = [];
  const sync = new GraphRebaseSessionSync(message => { sync.observe(message); messages.push(message); }, read);
  sync.setRepository("/repo/a");
  t.after(() => sync.dispose());
  return { sync, messages };
}

/** 실제 서비스로 edit 한 곳에서 정지한 rebase를 만들며 linked worktree도 같은 흐름을 쓴다. */
async function pausedFixture(t: TestContext, linked = false) {
  const fixture = await safetyFixture(t, "rebase-external-sync");
  let root = fixture.root;
  if (linked) {
    root = join(fixture.directory, "linked");
    await git(fixture.root, "worktree", "add", "-qb", "linked", root, fixture.head);
  }
  const head = await commitText(root, "edited commit\n", "edit pause");
  const result = await new RebaseService(root).start(fixture.head, false,
    [{ hash: head, action: "edit" }], resolve("media/rebase/rebaseEditor.js"));
  assert.equal(result.status, "paused");
  assert.ok(result.paused);
  return { root, head, paused: result.paused };
}

for (const action of ["continue", "abort"] as const) {
  test(`native terminal ${action} clears the paused UI without changing the completed Git result`, async t => {
    const { root, head, paused } = await pausedFixture(t);
    const { sync, messages } = syncFixture(t, repo => new ConflictService(repo).getOperation());
    sync.setRepository(root);
    messages.length = 0;
    sync.observe({ type: "graphRebasePaused", paused });
    await sync.refresh("beforeTerminal");
    assert.equal(messages.length, 0);
    await git(root, "rebase", `--${action}`);
    await sync.refresh("git:delete:stable-git-state");
    assert.deepEqual(messages, [{ type: "graphRebaseClear" }]);
    assert.equal(await git(root, "rev-parse", "HEAD"), head, "HEAD can stay unchanged when rebase ends");
    assert.equal(await new ConflictService(root).getOperation(), "none");
    await sync.refresh("duplicateWatcherEvent");
    assert.equal(messages.length, 1);
  });
}

test("an external linked-worktree Continue is reconciled from its own Git directory", async t => {
  const { root, paused } = await pausedFixture(t, true);
  const { sync, messages } = syncFixture(t, repo => new ConflictService(repo).getOperation());
  sync.setRepository(root);
  messages.length = 0;
  sync.observe({ type: "graphRebasePaused", paused });
  await git(root, "rebase", "--continue");
  await sync.refresh("windowFocusedReconcile");
  assert.deepEqual(messages, [{ type: "graphRebaseClear" }]);
});

test("inactive plans and local-change recovery guidance do not perform rebase reads or get cleared", async t => {
  let reads = 0;
  const { sync, messages } = syncFixture(t, async () => { reads++; return "none"; });
  sync.observe({ type: "graphRebasePlan", plan: {} as RebasePlanInfo });
  await sync.refresh("watcher");
  sync.observe({ type: "graphRebaseOperation", active: false, restoringLocalChanges: true });
  await sync.refresh("watcher");
  assert.equal(reads, 0);
  assert.deepEqual(messages, []);
});

test("new plans and native operation messages invalidate old completion reads", async t => {
  const first = deferred<MergeOperation>();
  const { sync, messages } = syncFixture(t, () => first.promise);
  sync.observe({ type: "graphRebaseOperation", active: true });
  const pending = sync.refresh("watcher");
  await settle();
  sync.observe({ type: "graphRebasePlan", plan: {} as RebasePlanInfo });
  first.resolve("none");
  await pending;
  assert.deepEqual(messages, []);
});

test("own Start or Continue progress and mutation leases cannot be mistaken for external completion", async t => {
  let reads = 0;
  const { sync, messages } = syncFixture(t, async () => { reads++; return "none"; });
  sync.observe({ type: "graphRebaseProgress", progress: {
    phase: "running", action: "run", title: "Starting rebase", active: true,
  } });
  await sync.refresh("beforeGitStarted");
  sync.observe({ type: "graphRebaseOperation", active: true });
  const release = tryAcquireConflictMutation("/repo/a");
  assert.ok(release);
  try { await sync.refresh("duringContinue"); }
  finally { release(); }
  assert.equal(reads, 0);
  assert.deepEqual(messages, []);
  await sync.refresh("afterContinue");
  assert.equal(messages.length, 1);
});

test("read failures retain active UI and the next metadata event retries", async t => {
  let reads = 0;
  const { sync, messages } = syncFixture(t, async () => {
    if (++reads === 1) throw new Error("repository temporarily unavailable");
    return "none";
  });
  sync.observe({ type: "graphRebaseOperation", active: true });
  await sync.refresh("first");
  assert.deepEqual(messages, []);
  await sync.refresh("retry");
  assert.deepEqual(messages, [{ type: "graphRebaseClear" }]);
});

test("a metadata burst waits for the latest operation instead of clearing from an obsolete result", async t => {
  const old = deferred<MergeOperation>();
  let reads = 0;
  const { sync, messages } = syncFixture(t, async () => ++reads === 1 ? old.promise : "rebase");
  sync.observe({ type: "graphRebaseOperation", active: true });
  const pending = sync.refresh("old");
  await settle();
  const burst = Array.from({ length: 20 }, () => sync.refresh("latest"));
  old.resolve("none");
  await Promise.all([pending, ...burst]);
  assert.equal(reads, 2);
  assert.deepEqual(messages, []);
});

for (const boundary of ["hide", "dispose", "repository"] as const) {
  test(`a late completion read cannot publish across ${boundary}`, async t => {
    const operation = deferred<MergeOperation>();
    const { sync, messages } = syncFixture(t, () => operation.promise);
    sync.observe({ type: "graphRebaseOperation", active: true });
    const pending = sync.refresh("old");
    await settle();
    if (boundary === "hide") sync.invalidate();
    if (boundary === "dispose") sync.dispose();
    if (boundary === "repository") {
      sync.setRepository("/repo/b");
      sync.observe({ type: "graphRebasePlan", plan: {} as RebasePlanInfo });
      messages.length = 0;
    }
    operation.resolve("none");
    await pending;
    assert.deepEqual(messages, []);
  });
}

test("automatic panel refresh clears an ended rebase even when the graph fingerprint is unchanged", async t => {
  const { root, paused } = await pausedFixture(t);
  const messages: ToWebviewMessage[] = [];
  const router = new GraphPanelMessageRouter({
    logService: () => new GitLogService(root),
    post: message => { router.observeRebaseMessage(message); messages.push(message); },
  } as GraphPanelMessageRouterDeps);
  t.after(() => router.cancelPullRequestLoading("dispose"));
  let graphReads = 0;
  const coordinator = new GraphRefreshLifecycleCoordinator({
    readFingerprint: async () => "unchanged graph", reloadGraph: async () => { graphReads++; },
    publishAfterReload: async () => {}, invalidateReload: () => {}, info: () => {}, error: () => {},
  });
  t.after(() => coordinator.dispose());
  await coordinator.runDirect({ repoRoot: root, cause: "ready" });
  router.observeRebaseMessage({ type: "graphRebasePaused", paused });
  await git(root, "rebase", "--continue");
  const previousState = window.state;
  window.state = { focused: true };
  t.after(() => { window.state = previousState; });
  // 실제 panel 메서드를 transport/lifecycle 경계만 주입해 실행한다.
  const panel = Object.assign(Object.create(GitGraphPanel.prototype), {
    messages: router, panel: { visible: true }, refreshCoordinator: coordinator,
  });
  await panel.requestExternalRefresh(root, "git:delete:stable-git-state");
  assert.deepEqual(messages, [{ type: "graphRebaseClear" }]);
  assert.equal(graphReads, 1, "Rebase synchronization must not force a full graph reload");
});

for (const trigger of ["manual", "focus", "reveal"] as const) {
  test(`${trigger} reconciles active rebase UI without waiting for graph data`, async t => {
    t.mock.method(ConflictService.prototype, "getOperation", async () => "none");
    const messages: ToWebviewMessage[] = [];
    const router = new GraphPanelMessageRouter({
      logService: () => new GitLogService("/repo/a"),
      post: message => { router.observeRebaseMessage(message); messages.push(message); },
      withBusy: async (_key, task) => task(),
      reloadGraph: async () => false,
    } as GraphPanelMessageRouterDeps);
    t.after(() => router.cancelPullRequestLoading("dispose"));
    router.observeRebaseMessage({ type: "graphRebaseOperation", active: true });
    const previousState = window.state;
    window.state = { focused: true };
    t.after(() => { window.state = previousState; });
    const panel = Object.assign(Object.create(GitGraphPanel.prototype), {
      messages: router, panel: { visible: true }, remoteCatalogStatus: "ready",
      refreshCoordinator: { setFocused: () => false, setVisible: () => false },
    });
    if (trigger === "manual") await router.handle({ type: "refresh" });
    if (trigger === "focus") panel.handleWindowFocusChange(true);
    if (trigger === "reveal") panel.handleViewStateChange({ webviewPanel: { visible: true } });
    await settle();
    assert.deepEqual(messages, [{ type: "graphRebaseClear" }]);
  });
}

for (const backend of ["rebase-merge", "rebase-apply"] as const) {
  test(`deleting the ${backend} directory itself routes the terminal completion to the graph`, () => {
    const queued: string[] = [];
    const reasons: string[] = [];
    const handler = createGitMetadataRefreshHandler({
      relevantRoots: () => [], graphRoot: () => "/repo", skipLog: new RepositoryRefreshSkipFence(),
      invalidateStatus: () => {}, queueRepository: () => {}, queueGraph: root => queued.push(root),
      scheduleRefresh: reason => reasons.push(reason),
    });
    handler("delete", Uri.file(`/repo/.git/${backend}`) as never);
    assert.deepEqual(queued, ["/repo"]);
    assert.deepEqual(reasons, ["graph:git:delete:stable-git-state"]);
  });
}
