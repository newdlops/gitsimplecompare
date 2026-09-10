import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import * as vscode from "vscode";
import { cleanupStaleBranches } from "../src/commands/cleanupStaleBranches";
import { buildScmMenu, runScmAction } from "../src/commands/scmActions";
import { tryAcquireRepoMutation, type CommandDeps } from "../src/commands/shared";
import { runGit } from "../src/git/gitExec";
import {
  __errorMessages, __executedCommands, __informationMessages, __outputLines,
  __quickPickItems, __resetOutputLines, __resetWindowMessages, __setQuickPickResult,
  __setWarningMessageResult, __warningMessages,
} from "./helpers/vscodeMock";
import { localBranches, staleBranchFixture, unmergedBranch } from "./helpers/staleBranchFixture";

/** 실제 Git 저장소와 네이티브 선택창 응답 대역을 결합해 명령의 삭제 범위를 검증한다. */
async function fixture(t: TestContext) {
  __resetWindowMessages(); __resetOutputLines();
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
  __setQuickPickResult(items => items.filter(item => names.includes((item as { branch: { name: string } }).branch.name)));
}

test("command shows unselected candidates with merge status, deletes only selected branches and refreshes", async t => {
  const repo = await fixture(t);
  for (const name of ["chosen", "keep"]) await runGit(["branch", name], repo.root);
  selectBranches(["chosen"]);
  __setWarningMessageResult("Delete Local Branches");
  await cleanupStaleBranches(repo.deps);
  assert.deepEqual(await localBranches(repo.root), ["keep", "main"]);
  const rows = __quickPickItems[0] as { label: string; description: string; picked: boolean }[];
  assert.deepEqual(rows.map(row => row.label), ["chosen", "keep"]);
  assert.equal(rows.every(row => !row.picked && row.description === "Merged into current HEAD"), true);
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
  __setQuickPickResult(items => {
    repo.deps.changesView.getActiveRepo = () => "/unrelated-repository";
    return items;
  });
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

test("no remotes, no stale branches and protected-only candidates have specific empty states", async t => {
  const repo = await fixture(t);
  await cleanupStaleBranches(repo.deps);
  assert.match(__informationMessages.at(-1)!, /No stale local branches/);
  await runGit(["update-ref", "-d", "refs/heads/main"], repo.remote);
  await cleanupStaleBranches(repo.deps);
  assert.match(__informationMessages.at(-1)!, /1 local-only branch.*in use by worktrees/);
  await runGit(["remote", "remove", "origin"], repo.root);
  await cleanupStaleBranches(repo.deps);
  assert.match(__informationMessages.at(-1)!, /No remotes are configured/);
  assert.equal(__quickPickItems.length, 0);
  assert.equal(__warningMessages.length, 0);
});

test("an unreachable remote shows an actionable error and never opens a deletion picker", async t => {
  const repo = await fixture(t);
  await runGit(["branch", "keep"], repo.root);
  await runGit(["remote", "add", "offline", join(repo.directory, "missing.git")], repo.root);
  await cleanupStaleBranches(repo.deps);
  assert.match(__errorMessages[0], /Could not check remote 'offline'.*Check the connection/);
  assert.equal(__quickPickItems.length, 0);
  assert.deepEqual(await localBranches(repo.root), ["keep", "main"]);
});

test("the Changes Branch menu routes its cleanup action to the registered extension command", async t => {
  const repo = await fixture(t);
  const branchMenu = buildScmMenu().find(node => node.label === "Branch");
  assert.ok(branchMenu?.submenu?.find(node => node.id === "cleanupStaleBranches"));
  await runScmAction(repo.deps, "cleanupStaleBranches");
  assert.deepEqual(__executedCommands.map(command => command.id), ["gitSimpleCompare.cleanupStaleBranches"]);
});
