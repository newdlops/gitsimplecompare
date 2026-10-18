import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ConflictService } from "../src/git/conflictService";
import type { GitLogService } from "../src/git/gitLogService";
import { PullRequestService, type PullRequestOverview } from "../src/git/pullRequestService";
import { PullRequestStackService } from "../src/git/pullRequestStackService";
import { GraphPanelMessageRouter, type GraphPanelMessageRouterDeps } from "../src/webview/graphPanelMessageRouter";
import { GitGraphPanel } from "../src/webview/graphPanel";
import type { ToWebviewMessage } from "../src/webview/graphProtocol";
import { safetyFixture } from "./helpers/gitSafetyFixture";

/** 외부 조회의 완료 시점을 벽시계 지연 없이 지정하는 단방향 barrier를 만든다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

/** 파일 metadata 비동기 검사가 끝날 여유를 주되 실패한 시작 조건을 무기한 기다리지 않는다. */
async function observeStart(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
  finally { clearTimeout(timer); }
}

/** 실제 router/pager를 유지하고 외부 PR 응답·로컬 snapshot·rebase 조회만 수동 해제한다. */
function startupHarness(t: TestContext) {
  const rebase = deferred<"none">(), rebaseStarted = deferred<void>();
  const local = deferred<void>(), remote = deferred<PullRequestOverview>(), remoteStarted = deferred<void>();
  const messages: ToWebviewMessage[] = [], signals: AbortSignal[] = [], stackSignals: AbortSignal[] = [];
  const tasks: Promise<unknown>[] = [];
  /** fire-and-forget 후속 조회까지 teardown이 기다리게 하여 다음 테스트의 외부경계를 오염시키지 않는다. */
  function track<T>(task: Promise<T>): Promise<T> { tasks.push(task); return task; }
  let root = "/repo/first", reads = 0;
  const router = new GraphPanelMessageRouter({
    logService: () => ({ repoRoot: root } as GitLogService), localBranches: () => [],
    post: message => { messages.push(message); }, withBusy: (_key, action) => track(action()),
    reloadGraph: async () => true,
  } as GraphPanelMessageRouterDeps);
  t.mock.method(router, "synchronizeRebaseSession", async () => undefined);
  t.mock.method(ConflictService.prototype, "getOperation", async () => {
    rebaseStarted.resolve(); return rebase.promise;
  });
  t.mock.method(PullRequestService.prototype, "getOverview", async (_branches, _cursor, signal) => {
    signals.push(signal!); remoteStarted.resolve(); return remote.promise;
  });
  t.mock.method(PullRequestStackService.prototype, "getGraphSnapshot", async (_prs, repository = "", defaultBranch = "", signal) => {
    stackSignals.push(signal!);
    reads++; if (reads === 1) await local.promise;
    return { repository, defaultBranch, stacks: [], layers: [] };
  });
  t.after(async () => {
    router.cancelPullRequestLoading("dispose"); rebase.resolve("none"); local.resolve(); remote.resolve(overview());
    let completed = -1;
    while (completed !== tasks.length) { completed = tasks.length; await Promise.allSettled(tasks); }
    router.cancelPullRequestLoading("dispose");
  });
  return { router, messages, signals, stackSignals, rebase, rebaseStarted, local, remote, remoteStarted,
    track, startReady: () => track(router.handle({ type: "ready" })),
    setRoot: (value: string) => { root = value; }, stackReads: () => reads };
}

/** 원격 응답이 완료된 저장소 힌트를 제공해 마지막 stack snapshot을 독립적으로 판별한다. */
function overview(): PullRequestOverview {
  return { available: true, repository: "owner/repo", defaultBranch: "main", hasMore: false, pullRequests: [] };
}

test("ready starts the PR read before slow rebase restoration and local stack completion", { timeout: 5000 }, async t => {
  const h = startupHarness(t);
  const ready = h.startReady();
  await h.rebaseStarted.promise;
  await observeStart(h.remoteStarted.promise);
  assert.equal(h.signals.length, 1, "rebase restoration must not block the first PR network read");
  assert.equal(h.signals[0].aborted, false, "starting the local stack must preserve the PR consumer");
  assert.equal(h.stackSignals[0].aborted, false);
  assert.equal(h.stackReads(), 1, "the initial local stack should progress alongside the network");
  h.rebase.resolve("none"); h.local.resolve(); h.remote.resolve(overview());
  await ready;
});

test("a late initial local stack is followed by the hydrated stack without delaying PR publication", { timeout: 5000 }, async t => {
  const h = startupHarness(t);
  const ready = h.startReady();
  await h.rebaseStarted.promise;
  h.rebase.resolve("none");
  await observeStart(h.remoteStarted.promise);
  assert.equal(h.signals.length, 1, "the local stack must not block the first PR network read");
  h.remote.resolve(overview());
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.messages.filter(message => message.type === "pullRequestOverview").length, 1);
  assert.equal(h.messages.filter(message => message.type === "pullRequestStackSnapshot").length, 0);
  h.local.resolve(); await ready;
  await new Promise<void>(resolve => setImmediate(resolve));
  const repositories = h.messages.flatMap(message => message.type === "pullRequestStackSnapshot" ? [message.snapshot.repository] : []);
  assert.deepEqual(repositories, ["", "owner/repo"], "a late empty snapshot must never replace the hydrated result");
});

for (const reason of ["repositoryChanged", "dispose"] as const) {
  test(`${reason} cancels the overlapping PR and local stack without late publication`, { timeout: 5000 }, async t => {
    const h = startupHarness(t);
    const ready = h.startReady();
    await h.rebaseStarted.promise;
    await observeStart(h.remoteStarted.promise);
    assert.equal(h.signals.length, 1);
    h.router.cancelPullRequestLoading(reason); h.setRoot("/repo/second");
    const before = h.messages.length;
    h.remote.resolve(overview()); h.local.resolve(); h.rebase.resolve("none");
    await ready; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.signals[0].aborted, true);
    assert.equal(h.stackSignals[0].aborted, true, "the same lifecycle must cancel the local stack consumer");
    assert.deepEqual(h.messages.slice(before).filter(message => message.type === "pullRequestOverview"
      || message.type === "pullRequestStackSnapshot"), []);
    assert.equal(h.signals.length, 1, "a late restore must not start a second repository's PR read");
  });
}

test("repository replacement during graph reload cannot launch a PR read for the replacement", async t => {
  const h = startupHarness(t), reload = deferred<boolean>();
  const reloadStarted = deferred<void>();
  t.mock.method((h.router as any).deps, "reloadGraph", async () => { reloadStarted.resolve(); return reload.promise; });
  const ready = h.startReady();
  await reloadStarted.promise;
  h.router.cancelPullRequestLoading("repositoryChanged"); h.setRoot("/repo/second");
  reload.resolve(true); h.rebase.resolve("none"); h.local.resolve(); h.remote.resolve(overview());
  await ready; await observeStart(h.remoteStarted.promise);
  assert.equal(h.signals.length, 0, "the old reload completion must not initiate work in a new repository");
});

test("repository reload starts the same PR pipeline before its initial local stack completes", { timeout: 5000 }, async t => {
  const h = startupHarness(t);
  const panel = Object.assign(Object.create(GitGraphPanel.prototype), {
    messages: h.router, disposed: false, runDirectGraph: async () => true,
  });
  const ready = h.track(panel.reloadRepository());
  await observeStart(h.remoteStarted.promise);
  assert.equal(h.signals.length, 1, "repository reload must not serialize local stack work before the PR query");
  h.local.resolve(); h.remote.resolve(overview());
  await ready;
});

/** 실제 세션 파일을 읽은 복원이 catch 없는 local-changes 충돌 조회 분기에 들어가게 한다. */
async function restoringLocalChangesFixture(t: TestContext): Promise<string> {
  const { root } = await safetyFixture(t, "startup-rebase-restore-error");
  const directory = join(root, ".git", "gitsimplecompare");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "rebase-session.json"), JSON.stringify({ version: 1, kind: "graph-rebase",
    operationId: "restore-error-fixture", plan: {}, restoringLocalChanges: true }));
  return root;
}

for (const reason of ["repositoryChanged", "dispose", "current"] as const) {
  test(`a throwing rebase restoration conflict read ${reason === "current" ? "reports its current error" : `cannot publish after ${reason}`}`,
    { timeout: 10000 }, async t => {
      const root = await restoringLocalChangesFixture(t), h = startupHarness(t);
      const conflictRead = deferred<never>(), conflictStarted = deferred<void>();
      let conflictReads = 0;
      t.mock.method(ConflictService.prototype, "listConflicts", async () => {
        conflictReads++; conflictStarted.resolve(); return conflictRead.promise;
      });
      h.setRoot(root); h.rebase.resolve("none"); h.local.resolve(); h.remote.resolve(overview());
      const ready = h.startReady();
      await conflictStarted.promise;
      assert.equal(conflictReads, 1, "the actual restore must reach the uncaught conflict-read boundary");
      if (reason !== "current") {
        h.router.cancelPullRequestLoading(reason);
        if (reason === "repositoryChanged") h.setRoot("/repo/second");
      }
      const before = h.messages.length;
      conflictRead.reject(new Error("The old repository's rebase changed while its state was being read."));
      await ready;
      const errors = h.messages.slice(before).filter(message => message.type === "error");
      assert.equal(errors.length, reason === "current" ? 1 : 0);
    });
}
