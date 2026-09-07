import assert from "node:assert/strict";
import test from "node:test";
import { GitLogService } from "../src/git/gitLogService";
import { handlePullRequestAction } from "../src/webview/graphPullRequestActions";
import { commitText, git } from "./helpers/gitSafetyFixture";
import { prSafetyFixture, safetyPullRequest } from "./helpers/prOperationSafetyFixture";
import * as vscode from "./helpers/vscodeMock";

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
