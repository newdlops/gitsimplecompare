import assert from "node:assert/strict";
import test from "node:test";
import { GitLogService } from "../src/git/gitLogService";
import { handlePullRequestAction } from "../src/webview/graphPullRequestActions";
import { commitText, git } from "./helpers/gitSafetyFixture";
import { prSafetyFixture, safetyPullRequest } from "./helpers/prOperationSafetyFixture";
import * as vscode from "./helpers/vscodeMock";
import { DeferredActionNotices } from "../src/ui/deferredActionNotices";
import { offerPullRequestOperationUndo } from "../src/webview/graphPullRequestUndo";

test("PR Undo confirmation pins the displayed branch and rejects a newly created operation", async (t) => {
  const { root, pr, service } = await prSafetyFixture(t);
  await service.squashCherryPick(pr);
  let newHead = "";
  let refreshes = 0;
  t.mock.method(vscode.window, "showWarningMessage", async (message: string) => {
    assert.match(message, /Undo the last PR operation on 'main'/);
    await git(root, "switch", "-qc", "second-source");
    const source = await commitText(root, "new PR result\n", "second PR");
    await git(root, "switch", "main");
    newHead = (await service.squashCherryPick(safetyPullRequest(source))).afterHead;
    return "Undo PR Operation";
  });
  await assert.rejects(() => handlePullRequestAction({
    logService: new GitLogService(root), pullRequests: () => [pr], refreshGraph: async () => { refreshes++; },
  }, pr.number, "undo"), /no longer matches/);
  assert.equal(await git(root, "rev-parse", "HEAD"), newHead);
  assert.equal(refreshes, 0);
});

for (const newer of [false, true]) test(`late PR notification Undo ${newer ? "preserves a newer Native PR operation" : "restores the original Native operation"}`, async t => {
  const { root, base, pr, service } = await prSafetyFixture(t);
  const result = await service.squashCherryPick(pr);
  let selected!: (value: string) => void, undoFinished!: () => void, refreshes = 0, runs = 0;
  const warnings: string[] = [];
  const finished = new Promise<void>(resolve => { undoFinished = resolve; });
  const owner = new DeferredActionNotices(error => { throw error; });
  t.after(() => owner.cancel());
  const notices = owner.scope(Promise.resolve(), () => true, async action => {
    runs++; try { await action(async () => { refreshes++; }); } finally { undoFinished(); }
  });
  t.mock.method(vscode.window, "showInformationMessage", () => new Promise<string>(resolve => { selected = resolve; }));
  t.mock.method(vscode.window, "showWarningMessage", async (message: string) => { warnings.push(message); return "Undo PR Operation"; });
  await offerPullRequestOperationUndo({ logService: new GitLogService(root), pullRequests: () => [pr],
    refreshGraph: async () => assert.fail("A late action must use its new refresh lifetime"), notices }, "Completed", result);
  let expected = base;
  if (newer) {
    await git(root, "switch", "-qc", "second-source");
    const source = await commitText(root, "new PR result\n", "second PR");
    await git(root, "switch", "main");
    expected = (await service.squashCherryPick(safetyPullRequest(source))).afterHead;
  }
  const chooseUndo = selected; chooseUndo("Undo PR Operation"); await finished;
  assert.equal(runs, 1); assert.equal(refreshes, newer ? 0 : 1);
  assert.equal(await git(root, "rev-parse", "HEAD"), expected);
  assert.equal(await service.hasUndoSnapshot(), newer);
  if (newer) assert.ok(warnings.some(message => /no longer the current saved operation/.test(message)));
});

for (const accept of [false, true]) {
  test(`PR Undo confirmation ${accept ? "accepts the original operation" : "cancels without changing Git"}`, async (t) => {
    const { root, base, pr, service } = await prSafetyFixture(t);
    const result = await service.squashCherryPick(pr);
    let refreshes = 0;
    t.mock.method(vscode.window, "showWarningMessage", async (message: string) => {
      assert.match(message, /'main'/);
      return accept ? "Undo PR Operation" : undefined;
    });
    await handlePullRequestAction({
      logService: new GitLogService(root), pullRequests: () => [pr], refreshGraph: async () => { refreshes++; },
    }, pr.number, "undo");
    assert.equal(await git(root, "rev-parse", "HEAD"), accept ? base : result.afterHead);
    assert.equal(refreshes, accept ? 1 : 0);
    assert.equal(await service.hasUndoSnapshot(), !accept);
  });
}

test("PR Undo shows the existing unavailable state when there is no owned snapshot", async (t) => {
  const { root, pr } = await prSafetyFixture(t);
  vscode.__resetWindowMessages();
  await handlePullRequestAction({
    logService: new GitLogService(root), pullRequests: () => [pr], refreshGraph: async () => assert.fail("No undo was performed"),
  }, pr.number, "undo");
  assert.deepEqual(vscode.__warningMessages, ["No PR operation snapshot is available for the current branch."]);
});
