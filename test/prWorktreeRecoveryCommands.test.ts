import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { ConflictService } from "../src/git/conflictService";
import { PullRequestWorktreeRecoveryError } from "../src/git/pullRequestWorktreeRecovery";
import type { PullRequestWorktreeRecovery } from "../src/git/pullRequestWorktreeRecoveryState";
import {
  continuePullRequestWorktreeRecovery, leavePullRequestWorktreeRecovery,
  offerPullRequestWorktreeRecovery, openPullRequestWorktreeRecovery,
} from "../src/commands/prWorktreeRecovery";
import type { CommandDeps } from "../src/commands/shared";
import { git } from "./helpers/gitSafetyFixture";
import { prSafetyFixture } from "./helpers/prOperationSafetyFixture";
import * as vscode from "./helpers/vscodeMock";

/** 실제 Git 충돌과 최소 UI 경계를 연결해 명령이 원래 작업트리에 적용되는지 검사한다. */
async function fixture(t: TestContext) {
  vscode.__resetWindowMessages();
  const setup = await prSafetyFixture(t, true);
  let recovery: PullRequestWorktreeRecovery | undefined;
  try { await setup.service.squashCherryPick(setup.pr); }
  catch (error) { assert.ok(error instanceof PullRequestWorktreeRecoveryError); recovery = error.recovery; }
  assert.ok(recovery);
  const record = recovery;
  t.after(() => rm(record.worktreePath, { recursive: true, force: true }));
  let current: PullRequestWorktreeRecovery | undefined;
  const selections: Array<PullRequestWorktreeRecovery | undefined> = [];
  const deps = {
    changesView: { getActiveRepo: () => setup.root }, registry: { get: () => ({ repoRoot: setup.root }) },
    conflicts: {
      get currentRecovery() { return current; },
      async setPullRequestRecovery(value?: PullRequestWorktreeRecovery) { current = value; selections.push(value); },
    },
    conflictOverlay: { sessionForUri: () => undefined },
  } as unknown as CommandDeps;
  return { ...setup, record, deps, selections };
}

test("a structured PR pause offers the saved operation without putting raw stderr in the notification", async () => {
  vscode.__resetWindowMessages();
  const record = { originRoot: "/origin", id: "fixed-id", phase: "conflicts", pr: { number: 42 } } as PullRequestWorktreeRecovery;
  await offerPullRequestWorktreeRecovery(new PullRequestWorktreeRecoveryError(record, "error: could not apply private-file"));
  assert.deepEqual(vscode.__executedCommands[0], {
    id: "gitSimpleCompare.resumePrOperation", args: [{ originRoot: "/origin", id: "fixed-id" }],
  });
  assert.equal(vscode.__warningMessages.length, 1);
  assert.match(vscode.__warningMessages[0], /Conflicts view.*Continue PR Operation/);
  assert.doesNotMatch(vscode.__warningMessages[0], /private-file|error: could not apply/);
});

test("recovery selection survives a new command invocation and Return preserves the worktree", async t => {
  const { root, record, deps, selections } = await fixture(t);
  vscode.__setQuickPickResult((items: readonly any[]) => items[0]);
  await openPullRequestWorktreeRecovery(deps);
  assert.equal(selections[0]?.id, record.id);
  assert.equal(deps.conflicts.currentRecovery?.worktreePath, record.worktreePath);
  assert.ok(vscode.__executedCommands.some(command => command.id === "gitSimpleCompare.conflicts.focus"));
  await leavePullRequestWorktreeRecovery(deps);
  assert.equal(deps.conflicts.currentRecovery, undefined);
  assert.equal((await new ConflictService(record.worktreePath).listConflicts()).length, 1);
  assert.equal(await git(root, "rev-parse", "HEAD"), record.beforeHead);
});

test("unresolved Continue displays a useful error and leaves the same recovery selected", async t => {
  const { record, deps } = await fixture(t);
  await openPullRequestWorktreeRecovery(deps, { originRoot: record.originRoot, id: record.id });
  await continuePullRequestWorktreeRecovery(deps);
  assert.equal(vscode.__errorMessages.length, 1);
  assert.match(vscode.__errorMessages[0], /Could not continue PR operation: Resolve and stage/);
  assert.equal(deps.conflicts.currentRecovery?.id, record.id);
});

test("Continue applies resolved changes then returns to the original view and refreshes it", async t => {
  const { root, record, deps, selections } = await fixture(t);
  await openPullRequestWorktreeRecovery(deps, { originRoot: record.originRoot, id: record.id });
  await new ConflictService(record.worktreePath).acceptIncoming("tracked.txt");
  await continuePullRequestWorktreeRecovery(deps);
  assert.equal(vscode.__errorMessages.length, 0);
  assert.equal(selections.at(-1), undefined);
  assert.match(vscode.__informationMessages.at(-1)!, /PR #42 operation completed on 'main'/);
  assert.equal(await git(root, "show", "HEAD:tracked.txt"), "PR content");
  assert.ok(vscode.__executedCommands.some(command => command.id === "gitSimpleCompare.refreshChanges"));
});

for (const virtual of [false, true]) {
  test(`Continue refuses unsaved ${virtual ? "resolved virtual" : "file"} edits`, async t => {
    const { root, record, deps } = await fixture(t);
    await openPullRequestWorktreeRecovery(deps, { originRoot: record.originRoot, id: record.id });
    const document = { isDirty: true, uri: { scheme: virtual ? "gitsimplecompare-conflict" : "file",
      fsPath: `${record.worktreePath}/tracked.txt`, toString: () => "test-session" } };
    t.mock.method(deps.conflictOverlay, "sessionForUri", (_uri, includeResolved) => {
      assert.equal(includeResolved, true);
      return virtual ? { service: { repoRoot: record.worktreePath } } as any : undefined;
    });
    const original = vscode.workspace.textDocuments;
    (vscode.workspace as any).textDocuments = [document];
    t.after(() => { (vscode.workspace as any).textDocuments = original; });
    await continuePullRequestWorktreeRecovery(deps);
    assert.match(vscode.__errorMessages[0], /Save your conflict resolution files/);
    assert.equal(await git(root, "rev-parse", "HEAD"), record.beforeHead);
    assert.equal(deps.conflicts.currentRecovery?.id, record.id);
  });
}
