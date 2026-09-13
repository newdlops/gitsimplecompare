import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import * as vscode from "vscode";
import { cleanupStaleBranches } from "../src/commands/cleanupStaleBranches";
import { buildScmMenu, runScmAction } from "../src/commands/scmActions";
import { tryAcquireRepoMutation, type CommandDeps } from "../src/commands/shared";
import { runGit } from "../src/git/gitExec";
import type { StaleBranch, StaleBranchInspection } from "../src/git/staleBranchService";
import { StaleBranchPanel } from "../src/webview/staleBranchPanel";
import {
  __errorMessages, __executedCommands, __informationMessages, __outputLines,
  __resetOutputLines, __resetWindowMessages,
  __setWarningMessageResult, __warningMessages,
} from "./helpers/vscodeMock";
import { localBranches, staleBranchFixture, unmergedBranch } from "./helpers/staleBranchFixture";

const inspections: StaleBranchInspection[] = [];
let selection: ((inspection: StaleBranchInspection) => StaleBranch[] | undefined) | undefined;

/** 실제 Git 저장소와 네이티브 선택창 응답 대역을 결합해 명령의 삭제 범위를 검증한다. */
async function fixture(t: TestContext) {
  __resetWindowMessages(); __resetOutputLines();
  inspections.length = 0; selection = undefined;
  t.mock.method(StaleBranchPanel, "pick", async (_extensionUri, inspection: StaleBranchInspection) => {
    inspections.push(inspection);
    return selection?.(inspection);
  });
  t.after(() => { __resetWindowMessages(); __resetOutputLines(); });
  const repo = await staleBranchFixture(t);
  const deps = {
    changesView: { getActiveRepo: () => repo.root },
    registry: { get: (repoRoot: string) => ({ repoRoot }) },
  } as unknown as CommandDeps;
  return { ...repo, deps };
}

/** 실제 선택창이 제공한 행에서만 지정한 브랜치를 선택한다. */
function selectBranches(names: readonly string[]): void {
  selection = inspection => inspection.branches.filter(branch => !branch.inUse && names.includes(branch.name));
}

test("command shows every local branch with status, deletes only selected stale branches and refreshes", async t => {
  const repo = await fixture(t);
  for (const name of ["chosen", "keep"]) await runGit(["branch", name], repo.root);
  selectBranches(["chosen"]);
  __setWarningMessageResult("Delete Local Branches");
  await cleanupStaleBranches(repo.deps);
  assert.deepEqual(await localBranches(repo.root), ["keep", "main"]);
  assert.deepEqual(inspections[0].localBranches.map(row => [row.name, row.remoteState]), [["chosen", "absent"], ["keep", "absent"], ["main", "present"]]);
  assert.equal(inspections[0].branches.every(branch => branch.merged), true);
  assert.match(__warningMessages[0], /Delete 1 selected stale local branch/);
  assert.deepEqual(__executedCommands.map(command => command.id), ["gitSimpleCompare.refreshChanges"]);
  assert.deepEqual(__informationMessages, ["Deleted 1 stale local branch(es)."]);
  assert.equal(__outputLines.some(line => line.includes('"hash":"' + repo.hash + '"') && line.includes("stale branch deleted")), true);
});

test("cancelling either selection or confirmation leaves branches and working files intact", async t => {
  const repo = await fixture(t);
  await runGit(["branch", "keep"], repo.root);
  await cleanupStaleBranches(repo.deps);
  assert.equal(__warningMessages.length, 0);
  selectBranches(["keep"]);
  await cleanupStaleBranches(repo.deps);
  assert.deepEqual(await localBranches(repo.root), ["keep", "main"]);
  assert.equal(__executedCommands.length, 0);
  assert.equal(await readFile(join(repo.root, "file.txt"), "utf8"), "keep this file\n");
});

test("declining force deletion preserves unmerged history after merged selections are removed", async t => {
  const repo = await fixture(t);
  await runGit(["branch", "merged"], repo.root);
  await unmergedBranch(repo.root, "private");
  selectBranches(["merged", "private"]);
  __setWarningMessageResult("Delete Local Branches");
  await cleanupStaleBranches(repo.deps);
  assert.deepEqual(await localBranches(repo.root), ["main", "private"]);
  assert.match(__warningMessages[1], /Force delete 1 branch/);
  assert.match(__warningMessages[2], /Deleted 1.*kept 1/);
  assert.equal(__outputLines.some(line => line.includes('"reason":"not-merged"')), true);
});

test("force deletion requires a distinct affirmative answer with the exact remaining branch list", async t => {
  const repo = await fixture(t);
  const hash = await unmergedBranch(repo.root, "private");
  selectBranches(["private"]);
  const confirmations: { message: string; detail?: string; actions: unknown[] }[] = [];
  t.mock.method(vscode.window, "showWarningMessage", async (message: string, options: { detail?: string }, ...actions: string[]) => {
    confirmations.push({ message, detail: options?.detail, actions });
    return actions[0];
  });
  await cleanupStaleBranches(repo.deps);
  assert.deepEqual(await localBranches(repo.root), ["main"]);
  assert.equal(confirmations.length, 2);
  assert.deepEqual(confirmations.map(confirmation => confirmation.actions), [["Delete Local Branches"], ["Force Delete"]]);
  assert.match(confirmations[1].detail ?? "", /can lose commits/);
  assert.ok(confirmations[1].detail?.includes(`private (${hash.slice(0, 10)})`));
  assert.ok(confirmations[1].detail?.includes(repo.root));
  assert.equal(__outputLines.some(line => line.includes('"force":true') && line.includes("stale branch deleted")), true);
});

test("a repository selection change while the picker is open keeps deletion bound to its displayed repository", async t => {
  const repo = await fixture(t);
  await runGit(["branch", "selected"], repo.root);
  selection = inspection => {
    repo.deps.changesView.getActiveRepo = () => "/unrelated-repository";
    return inspection.branches.filter(branch => !branch.inUse);
  };
  __setWarningMessageResult("Delete Local Branches");
  await cleanupStaleBranches(repo.deps);
  assert.deepEqual(await localBranches(repo.root), ["main"]);
  assert.deepEqual(__errorMessages, []);
});

test("a concurrent Git operation prevents mutation and releasing it allows the next cleanup", async t => {
  const repo = await fixture(t);
  await runGit(["branch", "selected"], repo.root);
  selectBranches(["selected"]);
  __setWarningMessageResult("Delete Local Branches");
  const lease = tryAcquireRepoMutation(repo.root, "test-operation")!;
  try {
    await cleanupStaleBranches(repo.deps);
    assert.deepEqual(await localBranches(repo.root), ["main", "selected"]);
    assert.equal(__warningMessages.some(message => message.includes("Another Git operation")), true);
  } finally { lease.release(); }
  await cleanupStaleBranches(repo.deps);
  assert.deepEqual(await localBranches(repo.root), ["main"]);
});

test("no remotes, no stale branches and protected-only candidates still open the complete local status view", async t => {
  const repo = await fixture(t);
  await cleanupStaleBranches(repo.deps);
  assert.deepEqual(inspections.at(-1)!.localBranches.map(branch => [branch.name, branch.remoteState]), [["main", "present"]]);
  await runGit(["update-ref", "-d", "refs/heads/main"], repo.remote);
  await cleanupStaleBranches(repo.deps);
  assert.deepEqual(inspections.at(-1)!.localBranches.map(branch => [branch.name, branch.remoteState, branch.inUse]), [["main", "absent", true]]);
  await runGit(["remote", "remove", "origin"], repo.root);
  await cleanupStaleBranches(repo.deps);
  assert.deepEqual(inspections.at(-1)!.localBranches.map(branch => [branch.name, branch.remoteState]), [["main", "unconfigured"]]);
  assert.equal(inspections.length, 3);
  assert.equal(__warningMessages.length, 0);
});

test("an unreachable remote shows an actionable error and never opens a deletion picker", async t => {
  const repo = await fixture(t);
  await runGit(["branch", "keep"], repo.root);
  await runGit(["remote", "add", "offline", join(repo.directory, "missing.git")], repo.root);
  await cleanupStaleBranches(repo.deps);
  assert.match(__errorMessages[0], /Could not check remote 'offline'.*Check the connection/);
  assert.equal(inspections.length, 0);
  assert.deepEqual(await localBranches(repo.root), ["keep", "main"]);
});

test("the Changes Branch menu routes its cleanup action to the registered extension command", async t => {
  const repo = await fixture(t);
  const branchMenu = buildScmMenu().find(node => node.label === "Branch");
  assert.ok(branchMenu?.submenu?.find(node => node.id === "cleanupStaleBranches"));
  await runScmAction(repo.deps, "cleanupStaleBranches");
  assert.deepEqual(__executedCommands.map(command => command.id), ["gitSimpleCompare.cleanupStaleBranches"]);
});
