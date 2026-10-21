import assert from "node:assert/strict";
import test from "node:test";
import { window } from "vscode";
import type { GitLogService } from "../src/git/gitLogService";
import { PullRequestOperationService } from "../src/git/pullRequestOperationService";
import { GraphPullRequestPager } from "../src/webview/graphPullRequests";
import { GraphPanelMessageRouter, type GraphPanelMessageRouterDeps } from "../src/webview/graphPanelMessageRouter";
import { withGraphBusy } from "../src/webview/graphPanelRendering";
import { safetyPullRequest } from "./helpers/prOperationSafetyFixture";
import { PullRequestDependencyService } from "../src/git/pullRequestDependencyService";
import { PullRequestWorktreeRecoveryError } from "../src/git/pullRequestWorktreeRecovery";
import type { PullRequestWorktreeRecovery } from "../src/git/pullRequestWorktreeRecoveryState";

/** 테스트가 직접 해제할 때까지 알림/실제 작업을 구분해 보류하며 임의 timeout으로 완료를 추정하지 않는다. */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

for (const mode of ["conflicts", "worktreeConflicts", "worktreeFailure", "error"] as const) {
  test(`PR ${mode} releases busy before diagnostics and an unanswered notice`, { timeout: 5000 }, async t => {
    const events: string[] = [], notice = deferred<string | undefined>(), analysis = deferred<void>();
    const pr = safetyPullRequest("a".repeat(40)), service = { repoRoot: "/notice-fixture" } as GitLogService;
    const conflict = mode === "conflicts" || mode === "worktreeConflicts";
    let analysisSignal: AbortSignal | undefined;
    t.mock.getter(GraphPullRequestPager.prototype, "items", () => [pr]);
    t.mock.method(window, "showWarningMessage", (_message: string, ...choices: unknown[]) =>
      choices.some(choice => !!choice && typeof choice === "object" && "modal" in choice)
        ? Promise.resolve(choices.find(choice => typeof choice === "string")) : notice.promise);
    t.mock.method(window, "showErrorMessage", () => notice.promise);
    t.mock.method(PullRequestOperationService.prototype, "prepareUndo", async () => { throw new Error("No snapshot"); });
    t.mock.method(PullRequestOperationService.prototype, "squashCherryPick", async () => {
      if (mode === "error") throw new Error("Git failed");
      if (mode.startsWith("worktree")) throw new PullRequestWorktreeRecoveryError({
        id: "fixture-recovery", originRoot: service.repoRoot, pr, command: "squash", branch: "main", beforeHead: pr.headHash,
        phase: conflict ? "conflicts" : "ready",
      } as PullRequestWorktreeRecovery, "Preserved result");
      return { status: "conflicts" as const, branch: "main", beforeHead: pr.headHash!, afterHead: pr.headHash!, snapshotRef: "refs/fixture/saved" };
    });
    t.mock.method(PullRequestDependencyService.prototype, "analyze", async input => {
      analysisSignal = input.signal; events.push("inspect"); await analysis.promise;
      return { prNumber: pr.number, beforeHead: pr.headHash!, branch: "main", conflicts: [], candidates: [], limitations: [] };
    });
    const router = new GraphPanelMessageRouter({ logService: () => service, post: () => {},
      withBusy: (key, run) => withGraphBusy(key, run, message => { if (message.type === "graphBusy") events.push(`busy:${message.busy}`); }),
      refreshAfterGraphAction: async () => { events.push("refresh"); },
    } as GraphPanelMessageRouterDeps);
    const running = router.handle({ type: "pullRequestAction", number: pr.number, action: "squash", busyId: "pr-op-42-squash" });
    t.after(async () => { router.cancelPullRequestLoading("dispose"); notice.resolve(undefined); analysis.resolve(undefined); await running; await turn(); });
    await running; await turn();
    assert.deepEqual([...events], ["busy:true", "busy:false", "refresh", ...(conflict ? ["inspect"] : [])]);
    if (conflict) {
      router.cancelPullRequestLoading("repositoryChanged");
      assert.equal(analysisSignal?.aborted, true, "The dependency UI must preserve the router's AbortSignal");
    }
  });
}

for (const reason of ["repositoryChanged", "dispose"] as const) test(`a success notice cannot start Undo after ${reason}`, async t => {
  const notice = deferred<string | undefined>(), events: string[] = [], pr = safetyPullRequest("a".repeat(40));
  t.mock.getter(GraphPullRequestPager.prototype, "items", () => [pr]);
  t.mock.method(window, "showWarningMessage", async () => "Squash Cherry-pick");
  t.mock.method(window, "showInformationMessage", () => notice.promise);
  t.mock.method(PullRequestOperationService.prototype, "squashCherryPick", async () => ({ status: "completed" as const,
    branch: "main", beforeHead: pr.headHash!, afterHead: "b".repeat(40), snapshotRef: "refs/fixture/saved" }));
  t.mock.method(PullRequestOperationService.prototype, "prepareUndo", async () => assert.fail("Old notification must not inspect or mutate another scope"));
  const router = new GraphPanelMessageRouter({ logService: () => ({ repoRoot: "/notice-fixture" } as GitLogService), post: () => {},
    withBusy: (key, run) => withGraphBusy(key, run, message => { if (message.type === "graphBusy") events.push(`busy:${message.busy}`); }),
    refreshAfterGraphAction: async () => { events.push("refresh"); },
  } as GraphPanelMessageRouterDeps);
  await router.handle({ type: "pullRequestAction", number: pr.number, action: "squash", busyId: "pr-op-42-squash" });
  router.cancelPullRequestLoading(reason); notice.resolve("Undo PR Operation"); await turn();
  assert.deepEqual(events, ["busy:true", "busy:false", "refresh"]); router.cancelPullRequestLoading("dispose");
});

test("late Undo owns a new busy lifetime and another Graph Git action cannot overlap it", async t => {
  const notice = deferred<string | undefined>(), writing = deferred<void>(), undoDone = deferred<void>();
  const events: string[] = [], pr = safetyPullRequest("a".repeat(40));
  let fetches = 0, notices = 0;
  const service = { repoRoot: "/notice-fixture", fetchAll: async () => { fetches++; } } as unknown as GitLogService;
  t.mock.getter(GraphPullRequestPager.prototype, "items", () => [pr]);
  t.mock.method(window, "showWarningMessage", async (_message: string, ...choices: unknown[]) => choices.find(choice => typeof choice === "string"));
  t.mock.method(window, "showInformationMessage", () => ++notices === 1 ? notice.promise : Promise.resolve(undefined));
  t.mock.method(PullRequestOperationService.prototype, "squashCherryPick", async () => ({ status: "completed" as const,
    branch: "main", beforeHead: pr.headHash!, afterHead: "b".repeat(40), snapshotRef: "refs/fixture/saved" }));
  t.mock.method(PullRequestOperationService.prototype, "prepareUndo", async () => ({ id: "original", branch: "main", snapshotRef: "refs/fixture/saved",
    restoredHead: pr.headHash!, expectedHead: "b".repeat(40), phase: "completed" as const, operation: "none" as const, worktreeBranch: "main", worktreeHead: "b".repeat(40) }));
  t.mock.method(PullRequestOperationService.prototype, "undoLastOperation", async () => {
    writing.resolve(undefined); await undoDone.promise; return { branch: "main", restoredHead: pr.headHash! };
  });
  const router = new GraphPanelMessageRouter({ logService: () => service, post: () => {},
    withBusy: (key, run) => withGraphBusy(key, run, message => { if (message.type === "graphBusy") events.push(`busy:${message.busy}`); }),
    refreshAfterGraphAction: async () => { events.push("refresh"); },
  } as GraphPanelMessageRouterDeps);
  t.after(async () => { undoDone.resolve(undefined); await turn(); router.cancelPullRequestLoading("dispose"); });
  await router.handle({ type: "pullRequestAction", number: pr.number, action: "squash", busyId: "pr-op-42-squash" });
  notice.resolve("Undo PR Operation"); await writing.promise;
  assert.deepEqual([...events], ["busy:true", "busy:false", "refresh", "busy:true"]);
  await router.handle({ type: "fetch" }); assert.equal(fetches, 0);
  undoDone.resolve(undefined); await turn();
  assert.deepEqual(events, ["busy:true", "busy:false", "refresh", "busy:true", "busy:false", "refresh"]);
});

/** 현재 event loop의 완료 처리를 진행해 알림 응답 없이도 busy/follow-up이 끝나는지 검사한다. */
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

for (const action of ["squash", "rebase", "squashRevert", "rebaseRevert"] as const) {
  test(`PR ${action} releases busy and refreshes Graph while its success notification remains unanswered`, { timeout: 5000 }, async t => {
    const core = deferred<void>(), notice = deferred<string | undefined>(), shown = deferred<void>();
    const events: string[] = [], pr = safetyPullRequest("a".repeat(40));
    const service = { repoRoot: "/notice-fixture" } as GitLogService;
    t.mock.getter(GraphPullRequestPager.prototype, "items", () => [pr]);
    t.mock.method(window, "showWarningMessage", async (_message: string, ...choices: unknown[]) => choices.find(choice => typeof choice === "string"));
    t.mock.method(window, "showInformationMessage", () => { shown.resolve(undefined); return notice.promise; });
    t.mock.method(PullRequestOperationService.prototype, "preparePullRequestRevert", async () => ({ commits: [], outsideCurrentBranch: 0 }));
    const method = { squash: "squashCherryPick", rebase: "rebasePullRequest", squashRevert: "squashRevertPullRequest", rebaseRevert: "rebaseRevertPullRequest" } as const;
    t.mock.method(PullRequestOperationService.prototype, method[action], async () => {
      await core.promise;
      return { status: "completed" as const, branch: "main", beforeHead: "a".repeat(40), afterHead: "b".repeat(40), snapshotRef: "refs/fixture/pr-snapshot" };
    });
    const router = new GraphPanelMessageRouter({ logService: () => service, post: () => {},
      withBusy: (key, run) => withGraphBusy(key, run, message => { if (message.type === "graphBusy") events.push(`busy:${message.busy}`); }),
      refreshAfterGraphAction: async () => { events.push("refresh"); },
    } as GraphPanelMessageRouterDeps);
    const running = router.handle({ type: "pullRequestAction", number: pr.number, action, busyId: `pr-op-${pr.number}-${action}` });
    t.after(async () => { core.resolve(undefined); notice.resolve(undefined); await running; router.cancelPullRequestLoading("dispose"); });
    await turn(); assert.deepEqual([...events], ["busy:true"], "The actual operation must remain busy");
    core.resolve(undefined); await shown.promise; await turn();
    assert.deepEqual([...events], ["busy:true", "busy:false", "refresh"], "A pending notification must not hold either busy or the deferred Graph refresh");
    await running;
  });
}

test("a PR revert preflight error does not wait for its error notification or read a new Graph", async t => {
  const notice = deferred<string | undefined>(), pr = safetyPullRequest("a".repeat(40)), events: string[] = [];
  t.mock.getter(GraphPullRequestPager.prototype, "items", () => [pr]);
  t.mock.method(PullRequestOperationService.prototype, "preparePullRequestRevert", async () => { throw new Error("Missing source"); });
  t.mock.method(window, "showErrorMessage", () => notice.promise);
  const router = new GraphPanelMessageRouter({ logService: () => ({ repoRoot: "/notice-fixture" } as GitLogService), post: () => {},
    withBusy: (key, run) => withGraphBusy(key, run, message => { if (message.type === "graphBusy") events.push(`busy:${message.busy}`); }),
    refreshAfterGraphAction: async () => assert.fail("Preflight did not mutate Git"),
  } as GraphPanelMessageRouterDeps);
  t.after(() => { router.cancelPullRequestLoading("dispose"); notice.resolve(undefined); });
  await router.handle({ type: "pullRequestAction", number: pr.number, action: "squashRevert", busyId: "pr-op-42-squashRevert" });
  assert.deepEqual(events, ["busy:true", "busy:false"]);
});
