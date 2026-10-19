import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { commands, window } from "vscode";
import { checkoutBranch } from "../src/commands/checkoutBranch";
import { branchRebaseMerge, branchSquashMerge } from "../src/commands/branchOperations";
import type { CommandDeps } from "../src/commands/shared";
import { GitLogService } from "../src/git/gitLogService";
import { BranchOperationService } from "../src/git/branchOperationService";
import { ConflictService } from "../src/git/conflictService";
import { GitGraphPanel } from "../src/webview/graphPanel";
import { isForcedGraphRefreshCause } from "../src/webview/graphRefreshCoordinator";

/** 명령 UI만 대체해 watcher 없이도 작업한 정확한 root를 Graph에 즉시 알리는지 확인한다. */
function fixture(t: TestContext) {
  const root = "/fixture/linked-worktree", events: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const branches = [{ name: "main", kind: "local", isCurrent: true }, { name: "topic", kind: "local", isCurrent: false }];
  const service = { repoRoot: root, listBranches: async () => branches, invalidateStatusCache() {}, invalidateBranchCache() {} };
  t.mock.method(window, "showQuickPick", async (items: any) => items.find((item: any) => item.branch.name === "topic"));
  t.mock.method(window, "showWarningMessage", async (_message: any, _options: any, label: any) => label);
  t.mock.method(GitGraphPanel, "refreshOpen", (repoRoot, reason) => {
    assert.equal(repoRoot, root); assert.equal(isForcedGraphRefreshCause(reason), true);
    events.push("graph"); return true;
  });
  t.mock.method(commands, "executeCommand", async (id: string) => {
    if (id === "gitSimpleCompare.refreshChanges") { events.push("changes"); await waiting; }
    return undefined;
  });
  const deps = { changesView: { getActiveRepo: () => root }, registry: { get: () => service } } as unknown as CommandDeps;
  t.after(release);
  return { root, events, deps, release };
}

test("Changes checkout directly notifies Graph before a suspended Changes refresh", async t => {
  const f = fixture(t);
  t.mock.method(GitLogService.prototype, "checkoutLocalBranch", async () => { f.events.push("write"); });
  await checkoutBranch(f.deps);
  assert.deepEqual(f.events, ["write", "graph", "changes"]);
});

test("a checkout failure reconciles Graph without waiting for metadata watchers", async t => {
  const f = fixture(t);
  t.mock.method(GitLogService.prototype, "checkoutLocalBranch", async () => { throw new Error("fixture checkout failed"); });
  await checkoutBranch(f.deps);
  assert.deepEqual(f.events, ["graph"]);
});

test("a successful checkout retry requests Graph once before its conflict check and side refresh", async t => {
  const f = fixture(t); let attempts = 0;
  t.mock.method(GitLogService.prototype, "checkoutLocalBranch", async () => {
    if (++attempts === 1) throw new Error("Local changes would be overwritten");
    f.events.push("write");
  });
  t.mock.method(ConflictService.prototype, "listConflicts", async () => { f.events.push("conflicts"); return []; });
  await checkoutBranch(f.deps);
  assert.deepEqual(f.events, ["write", "graph", "conflicts", "changes"]);
  assert.equal(attempts, 2);
});

for (const operation of ["squash", "rebase"] as const) for (const outcome of ["completed", "conflicts", "failed"] as const) {
  test(`${operation} ${outcome} notifies Graph before slow side views`, { timeout: 5000 }, async t => {
    const f = fixture(t);
    t.mock.method(BranchOperationService.prototype, operation === "squash" ? "squashMerge" : "rebaseMerge", async () => {
      f.events.push("write");
      if (outcome === "failed") throw new Error("fixture operation failed after a partial update");
      return { status: outcome, branch: "main", sourceBranch: "topic", beforeHead: "a".repeat(40), afterHead: "b".repeat(40),
        snapshotRef: "refs/fixture/snapshot" } as any;
    });
    const pending = operation === "squash" ? branchSquashMerge(f.deps) : branchRebaseMerge(f.deps);
    for (let turn = 0; turn < 30 && !f.events.includes("graph"); turn++) await Promise.resolve();
    assert.ok(f.events.includes("graph"));
    assert.ok(!f.events.includes("changes") || f.events.indexOf("graph") < f.events.indexOf("changes"));
    f.release(); await pending;
  });
}
