import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import type * as vscode from "vscode";
import { abortOperation, continueOperation, skipOperation } from "../src/commands/conflicts";
import { BranchOperationService } from "../src/git/branchOperationService";
import { ConflictService, detectOperation } from "../src/git/conflictService";
import { isConflictMutationActive } from "../src/git/conflictMutationCoordinator";
import { GitLogService } from "../src/git/gitLogService";
import { createRebaseEditTempFile } from "../src/git/rebaseEditSession";
import { readRebaseSessionState, rebaseSessionStatePath } from "../src/git/rebaseSessionState";
import { RebaseService, type RebaseItem } from "../src/git/rebaseService";
import { PullRequestStackMetadataService } from "../src/git/pullRequestStackMetadata";
import { PullRequestStackRestackService } from "../src/git/pullRequestStackRestack";
import type { ConflictsController } from "../src/providers/conflictsController";
import { abortGraphRebase, continueGraphRebase, skipGraphRebase } from "../src/webview/graphRebaseActions";
import { beginGraphRebaseSession, recordGraphRebaseSessionResult, restoreGraphRebaseSession } from "../src/webview/graphRebaseSession";
import { commitText, git } from "./helpers/gitSafetyFixture";
import { prSafetyFixture } from "./helpers/prOperationSafetyFixture";
import { Uri, workspace, window, __errorMessages } from "./helpers/vscodeMock";

const editor = resolve("media/rebase/rebaseEditor.js");

test("graph Continue releases its mutation lease before a slow graph refresh completes", { timeout: 15_000 }, async t => {
  const { root, deps } = await pausedFixture(t);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  let refreshing = false;
  const result = await continueGraphRebase({ ...deps, refreshGraph: () => { refreshing = true; return pending; } });
  assert.equal(result.status, "completed");
  assert.equal(refreshing, true);
  assert.equal(isConflictMutationActive(root), false);
  assert.equal(await detectOperation(root), "none");
});

/** 실제 Git 서비스를 쓰면서 VS Code 표시만 대체한 일반 명령 컨트롤러다. */
function controller(root: string): ConflictsController {
  return { current: new ConflictService(root), currentOperation: "rebase", refresh: async () => {} } as unknown as ConflictsController;
}

/** 그래프 handler에 실제 저장소를 전달하고 Uri.joinPath는 실제 VS Code와 같은 경로를 반환한다. */
function graphDeps(t: TestContext, root: string) {
  t.mock.method(Uri, "joinPath", (uri, ...parts) => Uri.file(join(uri.fsPath, ...parts)));
  return { extensionUri: Uri.file(resolve(".")) as unknown as vscode.Uri, logService: new GitLogService(root), refreshGraph: async () => {} };
}

/** 하나 또는 두 edit 정지 지점을 만들고 필요하면 실제 그래프 디스크 세션도 기록한다. */
async function pausedFixture(t: TestContext, second = false, graphSession = false) {
  const fixture = await prSafetyFixture(t);
  const { root, base } = fixture;
  const first = await commitText(root, "first\n", "first edit");
  const items: RebaseItem[] = [{ hash: first, action: "edit" }];
  if (second) items.push({ hash: await commitText(root, "second\n", "second edit"), action: "edit" });
  const deps = graphDeps(t, root);
  if (graphSession) await beginGraphRebaseSession({ base, root: false, items }, deps);
  const service = new RebaseService(root);
  const result = await service.start(base, false, items, editor);
  assert.equal(result.status, "paused");
  assert.ok(result.paused);
  if (graphSession) await recordGraphRebaseSessionResult(root, "run", result, items);
  return { ...fixture, service, paused: result.paused, items, deps };
}

/** 테스트에서 열린 임시 문서만 VS Code 문서 목록에 넣고 종료 시 목록을 되돌린다. */
function openDirtyDocument(t: TestContext, tempPath: string, save: () => Promise<boolean>) {
  const doc = { isDirty: true, uri: Uri.file(tempPath), save };
  const previous = workspace.textDocuments;
  Object.assign(workspace, { textDocuments: [doc] });
  t.after(() => { workspace.textDocuments = previous; });
  return doc;
}

for (const entry of ["general", "graph"] as const) {
  for (const failure of ["false", "throw", "dirty-again"] as const) {
    test(`${entry} Continue keeps rebase paused when saving returns ${failure}`, async t => {
      const { root, service, paused, deps } = await pausedFixture(t);
      const temporary = await createRebaseEditTempFile(root, paused, paused.files[0]);
      openDirtyDocument(t, temporary.tempPath, async () => {
        if (failure === "throw") throw new Error("injected editor save error");
        return failure === "dirty-again";
      });
      if (entry === "general") {
        await continueOperation(controller(root));
        assert.match(__errorMessages.at(-1) || "", /could not be saved/);
      } else await assert.rejects(continueGraphRebase(deps), /could not be saved/);
      assert.equal(await detectOperation(root), "rebase");
      assert.equal((await service.getPausedEditState())?.hash, paused.hash);
      assert.equal(await git(root, "show", "HEAD:tracked.txt"), "first");
      assert.equal(await readFile(temporary.tempPath, "utf8"), "first\n");
    });
  }

  test(`${entry} Continue saves and amends a valid edit before completing`, async t => {
    const { root, paused, deps } = await pausedFixture(t);
    const temporary = await createRebaseEditTempFile(root, paused, paused.files[0]);
    const doc = openDirtyDocument(t, temporary.tempPath, async () => {
      await writeFile(temporary.tempPath, "saved amendment\n");
      doc.isDirty = false;
      return true;
    });
    if (entry === "general") await continueOperation(controller(root));
    else assert.equal((await continueGraphRebase(deps)).status, "completed");
    assert.equal(await detectOperation(root), "none");
    assert.equal(await git(root, "show", "HEAD:tracked.txt"), "saved amendment");
  });

  test(`${entry} Continue rejects an external advance while the editor save is pending`, async t => {
    const { root, paused, deps } = await pausedFixture(t, true);
    const temporary = await createRebaseEditTempFile(root, paused, paused.files[0]);
    const doc = openDirtyDocument(t, temporary.tempPath, async () => {
      await git(root, "rebase", "--continue");
      await writeFile(join(root, "tracked.txt"), "another operation's new edit\n");
      doc.isDirty = false;
      return true;
    });
    if (entry === "general") {
      await continueOperation(controller(root));
      assert.match(__errorMessages.at(-1) || "", /operation changed/);
    } else await assert.rejects(continueGraphRebase(deps), /operation changed/);
    assert.equal(await detectOperation(root), "rebase");
    assert.equal(await git(root, "show", "-s", "--format=%s", "HEAD"), "second edit");
    assert.equal(await git(root, "show", "HEAD:tracked.txt"), "second");
    assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "another operation's new edit\n");
    assert.equal(await git(root, "diff", "--cached", "--name-only"), "");
  });
}

test("graph Continue accepts its own future todo edit while safely amending the current file", async t => {
  const { root, paused, deps, items } = await pausedFixture(t, true);
  const temporary = await createRebaseEditTempFile(root, paused, paused.files[0]);
  const doc = openDirtyDocument(t, temporary.tempPath, async () => {
    await writeFile(temporary.tempPath, "amended first\n");
    doc.isDirty = false;
    return true;
  });
  const changed = items.map((item, index) => index ? { ...item, action: "drop" as const } : item);
  assert.equal((await continueGraphRebase(deps, changed, [items[1].hash])).status, "completed");
  assert.equal(await git(root, "show", "HEAD:tracked.txt"), "amended first");
  assert.equal(await git(root, "show", "-s", "--format=%s", "HEAD"), "first edit");
});

for (const replacement of ["next-edit", "restarted-rebase"] as const) {
  test(`amend refuses an old paused state after ${replacement}`, async t => {
    const { root, base, service, paused, items } = await pausedFixture(t, true);
    if (replacement === "next-edit") await git(root, "rebase", "--continue");
    else {
      await git(root, "rebase", "--abort");
      assert.equal((await service.start(base, false, items, editor)).status, "paused");
    }
    const head = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "tracked.txt"), "keep new work\n");
    await assert.rejects(service.amendPausedEditChanges(paused), /paused rebase edit changed/);
    assert.equal(await git(root, "rev-parse", "HEAD"), head);
    assert.equal(await git(root, "diff", "--cached", "--name-only"), "");
    assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "keep new work\n");
  });
}

for (const action of ["continue", "skip", "abort"] as const) {
  test(`general ${action} closes its disk session and cannot restore it onto a later rebase`, async t => {
    const { root, deps } = await pausedFixture(t, false, true);
    const original = await readRebaseSessionState(root);
    assert.ok(original?.nativeOperation);
    t.mock.method(window, "showWarningMessage", async (...args: unknown[]) => args[2]);
    const commands = { continue: continueOperation, skip: skipOperation, abort: abortOperation };
    await commands[action](controller(root));
    assert.equal(await detectOperation(root), "none");
    assert.equal((await readRebaseSessionState(root))?.phase, action === "abort" ? "aborted" : "completed");
    await commitText(root, "later local\n", "later local");
    assert.equal((await new BranchOperationService(root).rebaseMerge("source")).status, "conflicts");
    const messages: Array<{ type: string }> = [];
    assert.equal(await restoreGraphRebaseSession({ ...deps, post: message => messages.push(message) }), false);
    // 종료 기록이 실패해 옛 paused 파일이 남아 있어도 native 세대가 다르면 복원을 거부한다.
    await writeFile(await rebaseSessionStatePath(root), JSON.stringify(original));
    assert.equal(await restoreGraphRebaseSession({ ...deps, post: message => messages.push(message) }), false);
    assert.equal(messages.some(message => message.type === "graphRebasePlan"), false);
  });
}

test("the active graph session restores only its own native rebase", async t => {
  const { root, deps } = await pausedFixture(t, false, true);
  const messages: Array<{ type: string }> = [];
  assert.equal(await restoreGraphRebaseSession({ ...deps, post: message => messages.push(message) }), true);
  assert.ok(messages.some(message => message.type === "graphRebasePlan"));
  assert.ok(messages.some(message => message.type === "graphRebasePaused"));
  const legacy = await readRebaseSessionState(root);
  delete legacy!.nativeOperation;
  await writeFile(await rebaseSessionStatePath(root), JSON.stringify(legacy));
  messages.length = 0;
  assert.equal(await restoreGraphRebaseSession({ ...deps, post: message => messages.push(message) }), false);
  assert.equal(messages.some(message => message.type === "graphRebasePlan"), false);
});

for (const action of ["continue", "skip", "abort"] as const) {
  test(`graph ${action} restores a branch rebase stash and completes pending cleanup`, async t => {
    const { root } = await prSafetyFixture(t, true);
    const deps = graphDeps(t, root);
    const service = new BranchOperationService(root);
    await writeFile(join(root, "other.txt"), "work preserved before rebase\n");
    assert.equal((await service.rebaseMerge("source")).status, "conflicts");
    t.mock.method(window, "showWarningMessage", async (...args: unknown[]) => args[2]);
    if (action === "continue") {
      await writeFile(join(root, "tracked.txt"), "resolved\n");
      await git(root, "add", "tracked.txt");
    }
    const commands = { continue: continueGraphRebase, skip: skipGraphRebase, abort: abortGraphRebase };
    assert.equal((await commands[action](deps)).status, action === "abort" ? "aborted" : "completed");
    assert.equal(await detectOperation(root), "none");
    assert.equal(await readFile(join(root, "other.txt"), "utf8"), "work preserved before rebase\n");
    await assert.rejects(readFile(join(root, ".git/gitsimplecompare/branch-rebase-merge-state.json")), { code: "ENOENT" });
    assert.equal(await git(root, "stash", "list"), "");
    assert.equal(await service.hasUndoSnapshot(), action !== "abort");
  });
}

test("graph Abort reports recovery failure and keeps pending state instead of returning success", async t => {
  const { root } = await prSafetyFixture(t, true);
  const deps = graphDeps(t, root);
  await writeFile(join(root, "other.txt"), "preserved stash\n");
  await new BranchOperationService(root).rebaseMerge("source");
  await new ConflictService(root).abortOperation("rebase");
  await unlink(join(root, ".git/gitsimplecompare/operation-control.json"));
  assert.equal((await abortGraphRebase(deps)).status, "failed");
  assert.ok(await readFile(join(root, ".git/gitsimplecompare/branch-rebase-merge-state.json")));
  assert.match(await git(root, "stash", "list"), /Git Simple Compare/);
});

test("graph Continue also finishes an owned stack restack", async t => {
  const { root, base } = await prSafetyFixture(t);
  const metadata = new PullRequestStackMetadataService(root);
  await metadata.createLayer({ branch: "stack/one", parentBranch: "main", parentRef: base });
  await git(root, "switch", "stack/one");
  await commitText(root, "stack\n", "stack");
  await git(root, "switch", "main");
  const parent = await commitText(root, "new main\n", "new main");
  await git(root, "switch", "stack/one");
  const service = new PullRequestStackRestackService(root);
  assert.equal((await service.execute(await service.createPlan("stack/one"))).status, "conflicts");
  await writeFile(join(root, "tracked.txt"), "resolved stack\n");
  await git(root, "add", "tracked.txt");
  assert.equal((await continueGraphRebase(graphDeps(t, root))).status, "completed");
  assert.equal(await git(root, "rev-parse", "HEAD^"), parent);
  await assert.rejects(readFile(join(root, ".git/gitsimplecompare/stack-restack-state.json")), { code: "ENOENT" });
});
