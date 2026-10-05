import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "./helpers/vscodeMock";
import { HunkCheckboxController } from "../src/providers/hunkCheckboxController";
import { GitServiceRegistry } from "../src/git/serviceRegistry";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";
import { skipInvalidatedHunkSnapshot } from "../src/providers/hunkCacheEvents";

/** 실제 파일/가상 기준 URI로 두 editor group을 구성해 production target 해석을 사용한다. */
function group(root: string, file: string, column: number) {
  const original = { scheme: "gitsimplecompare", path: `/${file}`, query: JSON.stringify({ ref: "HEAD", repoRoot: root }),
    toString: () => `gitsimplecompare:/${file}?HEAD=${root}` };
  const modified = { scheme: "file", fsPath: join(root, file), path: join(root, file), toString: () => join(root, file) };
  return { viewColumn: column, activeTab: { input: new vscode.TabInputTextDiff(original, modified) } };
}

test("concurrent overlays share native hunk reads and only the edited file loses its cached line mapping", async t => {
  const { root } = await safetyFixture(t, "hunk-file-cache"); const base = "first\nlast\n";
  for (const file of ["a.txt", "b.txt"]) await writeFile(join(root, file), base);
  await git(root, "add", "a.txt", "b.txt"); await git(root, "commit", "-qm", "hunk base");
  for (const file of ["a.txt", "b.txt"]) await writeFile(join(root, file), base + `added ${file}\n`);
  const groups = [group(root, "a.txt", 1), group(root, "b.txt", 2)];
  vscode.window.tabGroups.all = groups; vscode.window.tabGroups.activeTabGroup = groups[0];
  t.after(() => { vscode.window.tabGroups.all = []; vscode.window.tabGroups.activeTabGroup = { activeTab: undefined }; });
  let saved!: (document: any) => void, changed!: (event: any) => void;
  t.mock.method(vscode.workspace, "onDidSaveTextDocument", callback => { saved = callback; return { dispose() {} }; });
  t.mock.method(vscode.workspace, "onDidChangeTextDocument", callback => { changed = callback; return { dispose() {} }; });
  t.mock.method(vscode.workspace, "openTextDocument", async (uri: any) => {
    const text = uri.scheme === "file" ? await readFile(uri.fsPath, "utf8") : base;
    return { uri, getText: () => text };
  });
  let diffs = 0; const release = setGitExecutionObserver(timing => { if (timing.command === "diff") diffs++; }); t.after(release);
  const controller = new HunkCheckboxController(new GitServiceRegistry()), disposable = controller.register(); t.after(() => disposable.dispose());
  assert.deepEqual(controller.repositoryRoots(), [root]);
  const [first, second] = await Promise.all([controller.overlaySnapshots(), controller.overlaySnapshots()]);
  assert.equal(diffs, 4); assert.equal(first.length, 2); assert.deepEqual(first, second);
  const oldB = first.find(snapshot => snapshot.path === "b.txt")!; assert.ok(oldB.lines.length > 0);
  await writeFile(join(root, "a.txt"), "first\nchanged\nlast\nnew line\n");
  saved({ uri: groups[0].activeTab.input.modified });
  const edited = await controller.overlaySnapshots(); assert.equal(diffs, 6);
  assert.deepEqual(edited.find(snapshot => snapshot.path === "b.txt")!.lines, oldB.lines);
  assert.notDeepEqual(edited.find(snapshot => snapshot.path === "a.txt")!.lines, first.find(snapshot => snapshot.path === "a.txt")!.lines);
  changed({ document: { uri: groups[1].activeTab.input.original }, contentChanges: [{ text: "new base" }] });
  await controller.overlaySnapshots(); assert.equal(diffs, 8);
  controller.refresh(); await controller.overlaySnapshots(); assert.equal(diffs, 12, "HEAD/index invalidation refreshes every basis");
});

test("an obsolete overlay cancellation is skipped while real errors remain observable", async () => {
  assert.equal(await skipInvalidatedHunkSnapshot("a.txt", async () => { throw new DOMException("cancelled", "AbortError"); }), undefined);
  await assert.rejects(skipInvalidatedHunkSnapshot("a.txt", async () => { throw new Error("real failure"); }), /real failure/);
});
