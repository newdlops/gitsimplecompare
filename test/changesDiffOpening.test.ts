import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitError, runGit } from "../src/git/gitExec";
import { readFileAtRef, readWorkingContentWithoutStaged } from "../src/git/fileContentReader";
import { setGitReadTimeoutResolver } from "../src/git/gitProcessRunner";
import { GitServiceRegistry } from "../src/git/serviceRegistry";
import { openWorkingChange } from "../src/commands/workingChanges";
import { BranchContentProvider, disposeBranchContentCache } from "../src/providers/branchContentProvider";
import { HunkCheckboxController } from "../src/providers/hunkCheckboxController";
import { beginDiffOpen, isAnyDiffOpenInProgress, isDiffOpenInProgress } from "../src/providers/diffOpenGate";
import { makeRefUri, parseRefUri } from "../src/utils/uri";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";
import * as vscode from "./helpers/vscodeMock";

/** 부분 stage로 HEAD/index/working 세 버전을 만들고 표시 과정이 실제 내용을 바꾸지 않는지 검사한다. */
async function partialFixture(t: TestContext) {
  const f = await safetyFixture(t, "changes-diff-opening");
  const file = join(f.root, "tracked.txt");
  await writeFile(file, "first\nlast\n"); await git(f.root, "commit", "-qam", "two base lines");
  await writeFile(file, "first\nstaged only\nlast\n"); await git(f.root, "add", "tracked.txt");
  await writeFile(file, "first\nstaged only\nlast\nunstaged only\n");
  return { ...f, file };
}

/** URI와 탭의 VS Code 경계만 대체하며 비교 문서와 Hunk는 실제 Git으로 읽는다. */
function editorFixture(t: TestContext) {
  const api = vscode.workspace as any, previousFs = api.fs;
  api.fs = { stat: async (uri: any) => stat(uri.fsPath) };
  t.after(() => { api.fs = previousFs; });
  const previous = { groups: vscode.window.tabGroups.all, active: vscode.window.tabGroups.activeTabGroup,
    editor: vscode.window.activeTextEditor };
  t.after(() => { vscode.window.tabGroups.all = previous.groups; vscode.window.tabGroups.activeTabGroup = previous.active;
    vscode.window.activeTextEditor = previous.editor; disposeBranchContentCache(); });
  t.mock.method(vscode.workspace, "getConfiguration", () => ({ get: (_key: string, fallback: unknown) => fallback }));
  t.mock.method(vscode.Uri, "from", (parts: any) => ({ ...parts,
    toString: () => `${parts.scheme}:${parts.path}?${parts.query}` }));
  const documents = new Map<string, { uri: any; getText(): string }>();
  t.mock.method(vscode.workspace, "openTextDocument", async (uri: any) => {
    const document = documents.get(uri.toString()); assert.ok(document, `Unexpected document: ${uri.toString()}`); return document;
  });
  return { documents };
}

test("index blob reads bypass a blocked fsmonitor, including missing-path checks, without changing Git settings", { skip: process.platform === "win32" }, async t => {
  const f = await partialFixture(t), hook = join(f.directory, "slow-fsmonitor");
  await writeFile(hook, "#!/bin/sh\nprintf 'called\\n' >> .git/monitor-calls\nexec /bin/sleep 3\n", { mode: 0o755 });
  await git(f.root, "config", "core.fsmonitor", hook);
  // 기존 show :0:path가 같은 대기 증상을 보이는지 짧은 deadline으로 실제 재현한다.
  await assert.rejects(runGit(["show", ":0:tracked.txt"], f.root, { readTimeoutMs: 1500 }), (error: unknown) => {
    assert.ok(error instanceof GitError); assert.equal(error.code, "ETIMEDOUT"); return true;
  });
  assert.equal(await readFile(join(f.root, ".git/monitor-calls"), "utf8"), "called\n");
  const before = await Promise.all([readFile(join(f.root, ".git/index")), readFile(join(f.root, ".git/config")), readFile(f.file)]);
  t.after(setGitReadTimeoutResolver(() => 2000));
  assert.equal(await readFileAtRef(f.root, ":0", "tracked.txt"), "first\nstaged only\nlast\n");
  assert.equal(await readFileAtRef(f.root, ":0", "absent.txt"), "");
  assert.equal(await readWorkingContentWithoutStaged(f.root, "tracked.txt"), "first\nlast\nunstaged only\n");
  const after = await Promise.all([readFile(join(f.root, ".git/index")), readFile(join(f.root, ".git/config")), readFile(f.file)]);
  assert.deepEqual(after, before); assert.equal(await readFile(join(f.root, ".git/monitor-calls"), "utf8"), "called\n");
});

for (const stage of ["staged", "unstaged"] as const) {
  test(`Changes ${stage} click loads the correct diff documents and exposes matching Hunk controls`, async t => {
    const f = await partialFixture(t), editor = editorFixture(t), registry = new GitServiceRegistry();
    const provider = new BranchContentProvider(registry), hunks = new HunkCheckboxController(registry);
    let opened = 0;
    t.mock.method(vscode.commands, "executeCommand", async (id: string, original: any, modified: any, title: any, options: any) => {
      assert.equal(id, "vscode.diff"); opened++; assert.equal(options.preview, false);
      assert.match(title, stage === "staged" ? /Index/ : /Unstaged/);
      const [left, right] = await Promise.all([provider.provideTextDocumentContent(original), provider.provideTextDocumentContent(modified)]);
      assert.equal(left, "first\nlast\n");
      assert.equal(right, stage === "staged" ? "first\nstaged only\nlast\n" : "first\nlast\nunstaged only\n");
      for (const [uri, text] of [[original, left], [modified, right]] as const) editor.documents.set(uri.toString(), { uri, getText: () => text });
      const group = { viewColumn: 1, activeTab: { input: new vscode.TabInputTextDiff(original, modified) } };
      vscode.window.tabGroups.all = [group]; vscode.window.tabGroups.activeTabGroup = group;
      vscode.window.activeTextEditor = { document: editor.documents.get(modified.toString()) };
      assert.equal(parseRefUri(modified).ref, stage === "staged" ? ":0" : ":unstaged");
      // 실제 Git/문서 읽기 완료 뒤 부착 지연만 가상 시계로 넘겨 diff 열기 gate를 검사한다.
      t.mock.timers.enable({ apis: ["setTimeout"] });
    });
    await openWorkingChange({} as any, { root: f.root, path: "tracked.txt", stage, hasStaged: true });
    assert.equal(opened, 1);
    if (stage === "unstaged") {
      assert.deepEqual(await hunks.overlaySnapshots(), []);
      t.mock.timers.tick(1800);
    }
    // Git 실행기의 timeout은 실제 타이머로 돌리고 완료된 gate 상태는 그대로 보존한다.
    t.mock.timers.reset();
    const snapshots = await hunks.overlaySnapshots(); assert.equal(snapshots.length, 1);
    const snapshot = snapshots[0]; assert.equal(snapshot.action, stage === "staged" ? "unstage" : "stage");
    assert.ok(snapshot.lines.length > 0); assert.ok(snapshot.lines.every(line => line.lineIds.length > 0));
    assert.ok(snapshot.lines.some(line => line.side === "modified" && line.line === (stage === "staged" ? 2 : 3)));
    assert.equal(await readFile(f.file, "utf8"), "first\nstaged only\nlast\nunstaged only\n");
  });
}

test("a pending diff in one group does not hide Hunk controls for another ready diff", async t => {
  const f = await partialFixture(t), editor = editorFixture(t), registry = new GitServiceRegistry();
  await writeFile(join(f.root, "ready.txt"), "ready\n"); await git(f.root, "add", "ready.txt");
  await git(f.root, "commit", "-qm", "ready file"); await writeFile(join(f.root, "ready.txt"), "ready\nchanged\n");
  const groups = ["tracked.txt", "ready.txt"].map((file, index) => {
    const original = makeRefUri(":0", file, f.root), modified = vscode.Uri.file(join(f.root, file));
    editor.documents.set(original.toString(), { uri: original, getText: () => file === "ready.txt" ? "ready\n" : "first\nstaged only\nlast\n" });
    editor.documents.set(modified.toString(), { uri: modified, getText: () => file === "ready.txt" ? "ready\nchanged\n" : "first\nstaged only\nlast\nunstaged only\n" });
    return { viewColumn: index + 1, activeTab: { input: new vscode.TabInputTextDiff(original, modified) } };
  });
  vscode.window.tabGroups.all = groups; vscode.window.tabGroups.activeTabGroup = groups[1];
  const waiting = groups[0].activeTab.input.modified, ready = groups[1].activeTab.input.modified;
  const finish = beginDiffOpen(waiting);
  try {
    assert.equal(isAnyDiffOpenInProgress(), true); assert.equal(isDiffOpenInProgress(waiting), true); assert.equal(isDiffOpenInProgress(ready), false);
    const snapshots = await new HunkCheckboxController(registry).overlaySnapshots();
    assert.deepEqual(snapshots.map(snapshot => snapshot.path), ["tracked.txt", "ready.txt"]);
    assert.equal(snapshots[0].pending, true); assert.deepEqual(snapshots[0].lines, []); assert.ok(snapshots[1].lines.length > 0);
  } finally {
    t.mock.timers.enable({ apis: ["setTimeout"] }); finish(); t.mock.timers.tick(1800); t.mock.timers.reset();
  }
  assert.equal(isDiffOpenInProgress(waiting), false);
});

test("overlapping opens release only their own URI and the finisher remains idempotent", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = vscode.Uri.file("/gate/a.txt"), b = vscode.Uri.file("/gate/b.txt");
  const first = beginDiffOpen(a), second = beginDiffOpen(a), other = beginDiffOpen(b);
  first(); first(); t.mock.timers.tick(1800);
  assert.equal(isDiffOpenInProgress(a), true); assert.equal(isDiffOpenInProgress(b), true);
  second(); t.mock.timers.tick(900); other(); t.mock.timers.tick(900);
  assert.equal(isDiffOpenInProgress(a), false); assert.equal(isDiffOpenInProgress(b), true);
  t.mock.timers.tick(900); assert.equal(isDiffOpenInProgress(b), false);
});
