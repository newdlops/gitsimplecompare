import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerBlameCommands } from "../src/commands/blame";
import { BlockBlamePresenter } from "../src/ui/blockBlamePresenter";
import { BlockBlameHoverPresenter } from "../src/ui/blockBlameHoverPresenter";
import { GitBlameService } from "../src/git/blameService";
import { LineHistoryService } from "../src/git/lineHistoryService";
import { showBlameLineHistory } from "../src/ui/lineHistoryPresenter";
import { formatBlameDate, formatBlameAuthor } from "../src/ui/blameAnnotationPresentation";
import { safetyFixture, git, commitText } from "./helpers/gitSafetyFixture";
import * as mock from "./helpers/vscodeMock";

/** 실제 Git 파일에 맞춘 VS Code 경계만 제공한다. 심볼 provider는 일부러 제공하지 않는다. */
function documentFixture(t: any, root: string) {
  const file = join(root, "tracked.txt"), uri = { scheme: "file", fsPath: file, toString: () => pathToFileURL(file).href };
  const doc = { uri, lineCount: 1, version: 1, isDirty: false };
  const original = mock.window.activeTextEditor;
  mock.__resetWindowMessages(); mock.window.activeTextEditor = { document: doc, selection: { active: { line: 0 } } };
  t.after(() => { mock.window.activeTextEditor = original; });
  t.mock.method(mock.workspace, "openTextDocument", async () => doc);
  t.mock.method(mock.Uri, "parse", () => uri);
  return { uri, doc };
}

test("symbol-free file commands show, reformat without Git, and hide only the owned annotations", async t => {
  const { root } = await safetyFixture(t, "annotation-commands"), { uri } = documentFixture(t, root);
  const options: Record<string, unknown> = {};
  let configurationChanged: (event: any) => void = () => {};
  t.mock.method(mock.workspace, "getConfiguration", () => ({ get: (key: string, fallback: unknown) => options[key] ?? fallback }));
  t.mock.method(mock.workspace, "onDidChangeConfiguration", callback => { configurationChanged = callback; return { dispose() {} }; });
  const registry: any = { resolve: async () => ({ repoRoot: root, toRepoRelative: () => "tracked.txt" }) };
  const presenter = new BlockBlamePresenter(registry); presenter.register(); t.after(() => presenter.dispose());
  const deps: any = { registry, blockBlamePresenter: presenter };
  const registrations = registerBlameCommands(deps); t.after(() => registrations.forEach(item => item.dispose()));
  let reads = 0; const original = GitBlameService.prototype.getFileBlame;
  t.mock.method(GitBlameService.prototype, "getFileBlame", async function (...args) { reads++; return original.apply(this, args); });
  await mock.commands.executeCommand("gitSimpleCompare.showBlameAnnotations", { uri });
  assert.equal(presenter.gutterSnapshot()?.lines.length, 1);
  await mock.commands.executeCommand("gitSimpleCompare.showBlameAnnotations", { uri }); assert.equal(reads, 1);
  options.showCommitHash = true; options.compact = true;
  configurationChanged({ affectsConfiguration: (section: string) => section.endsWith("blameAnnotations") });
  assert.equal(reads, 1); assert.equal(presenter.gutterSnapshot()?.compact, true);
  options["blameBlock.show"] = false;
  configurationChanged({ affectsConfiguration: (section: string) => section.endsWith("blameBlock.show") });
  assert.ok(presenter.gutterSnapshot(), "explicit file annotations are independent of Code Vision visibility");
  assert.match(presenter.gutterSnapshot()!.lines[0].label, new RegExp((await git(root, "rev-parse", "HEAD")).slice(0, 8)));
  presenter.hideFile({ toString: () => "file:///other.txt" } as any); assert.ok(presenter.gutterSnapshot());
  await mock.commands.executeCommand("gitSimpleCompare.hideBlameAnnotations", { uri }); assert.equal(presenter.gutterSnapshot(), undefined);
  assert.equal(mock.__executedCommands.some(item => item.id === "vscode.executeDocumentSymbolProvider"), false);
  assert.equal(mock.__executedCommands.at(-1)?.args[1], false);
});

test("line history picker opens the selected historical file diff and rejects dirty documents", async t => {
  const { root } = await safetyFixture(t, "line-history-ui"), { uri, doc } = documentFixture(t, root);
  const hash = await commitText(root, "changed line\n", "Selected line change");
  mock.__setQuickPickResult((items: any[]) => items[0]);
  await showBlameLineHistory({ repoRoot: root, uri: uri as any, line: 1 });
  const diff = mock.__executedCommands.find(item => item.id === "vscode.diff")!;
  assert.ok(diff); assert.ok(JSON.stringify(diff.args[1]).includes(hash));
  assert.match((mock.__quickPickItems[0][0] as any).label, /Selected line change/);
  assert.equal((diff.args[3] as any).selection.start.line, 0);
  mock.__resetWindowMessages(); doc.isDirty = true;
  await showBlameLineHistory({ repoRoot: root, uri: uri as any, line: 1 });
  assert.match(mock.__informationMessages[0], /Save the file/); assert.equal(mock.__quickPickItems.length, 0);
});

test("hover line history uses the snapshot's original line and path without loading commit details", async t => {
  mock.__resetWindowMessages(); mock.window.state.focused = true;
  const hash = "a".repeat(40), calls: any[] = [];
  const snapshot = { uri: "file:///repo/renamed.ts", revision: 7, repoRoot: "/repo", columnWidthCh: 23,
    lines: [{ line: 12, commit: hash, label: "Author", tooltip: "Source", originalLine: 5, sourcePath: "original.ts" }] };
  const presenter = new BlockBlameHoverPresenter(() => snapshot, async () => assert.fail("History must not load the full commit"),
    async () => assert.fail("History must not resolve a remote"), async target => { calls.push(target); });
  t.after(() => presenter.dispose());
  const request = { type: "blameHover", action: "lineHistory", uri: snapshot.uri, revision: 7, line: 12, commit: hash, requestId: 1 };
  presenter.handleRendererAction(request); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls[0].anchor, { hash, path: "original.ts", line: 5 });
  presenter.handleRendererAction({ ...request, revision: 6 }); presenter.handleRendererAction({ ...request, line: 99 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 1);
});

test("date and name display respects UTC, relative time and full Unicode names", () => {
  assert.equal(formatBlameAuthor("Alex 김민수", "last"), "김민수");
  assert.equal(formatBlameAuthor("김민수", "first"), "김민수");
  assert.equal(formatBlameDate(0, "YYYY-MM-DD"), "1970-01-01");
  assert.equal(formatBlameDate(0, "MM/DD/YYYY"), "01/01/1970");
  assert.equal(formatBlameDate(0, "relative", 86400000), "yesterday");
  assert.equal(formatBlameDate(Number.NaN, "relative"), "Unknown date");
});

test("more line history is requested only after selection and reuses the original anchor", async t => {
  const { uri } = documentFixture(t, "/repo");
  const anchor = { hash: "a".repeat(40), path: "old.ts", line: 1 };
  const entry = { hash: anchor.hash, baseRef: "b".repeat(40), author: "Author", dateIso: "2026-10-19", title: "Selected change", path: "old.ts", line: 1 };
  let anchors = 0, picks = 0; const limits: number[] = [];
  t.mock.method(LineHistoryService.prototype, "anchor", async () => { anchors++; return anchor; });
  t.mock.method(LineHistoryService.prototype, "read", async (value, limit) => {
    assert.equal(value, anchor); limits.push(limit!); return { anchor, entries: [entry], hasMore: limit! < 60 };
  });
  mock.__setQuickPickResult((items: any[]) => ++picks === 1 ? items.find(item => item.more) : items[0]);
  await showBlameLineHistory({ repoRoot: "/repo", uri: uri as any, line: 1 });
  assert.deepEqual(limits, [30, 60]); assert.equal(anchors, 1);
  assert.ok(mock.__executedCommands.some(item => item.id === "vscode.diff"));
});

test("editing a document cancels a pending line history read without a stale picker or error", async t => {
  const { uri, doc } = documentFixture(t, "/repo");
  let changed: (event: any) => void = () => {};
  let signal: AbortSignal | undefined;
  t.mock.method(mock.workspace, "onDidChangeTextDocument", callback => { changed = callback; return { dispose() {} }; });
  t.mock.method(LineHistoryService.prototype, "read", async (_anchor, _limit, value) => new Promise((_resolve, reject) => {
    signal = value; signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
  }));
  const pending = showBlameLineHistory({ repoRoot: "/repo", uri: uri as any, line: 1, anchor: { hash: "a".repeat(40), path: "old.ts", line: 1 } });
  await new Promise(resolve => setImmediate(resolve));
  doc.isDirty = true; doc.version++; changed({ document: doc, contentChanges: [{}] });
  await pending;
  assert.equal(signal?.aborted, true); assert.equal(mock.__quickPickItems.length, 0); assert.equal(mock.__errorMessages.length, 0);
});

test("cancelling annotations during repository discovery never reopens the old editor", async t => {
  const { uri, doc } = documentFixture(t, "/repo");
  let finish: (value: any) => void = () => {};
  let lookups = 0, editorOpens = 0;
  const registry: any = { resolve: async () => { lookups++; return new Promise(resolve => { finish = resolve; }); } };
  const windowApi = mock.window as any, previousShow = windowApi.showTextDocument;
  windowApi.showTextDocument = async () => { editorOpens++; return { document: doc }; };
  t.after(() => { windowApi.showTextDocument = previousShow; });
  const presenter = new BlockBlamePresenter(registry); t.after(() => presenter.dispose());
  t.mock.method(GitBlameService.prototype, "getFileBlame", async () => assert.fail("Cancelled discovery must not start blame"));
  const pending = presenter.showFile(uri as any);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(lookups, 1);
  mock.window.activeTextEditor = { document: { uri: { toString: () => "file:///repo/other.ts" } } };
  presenter.hideFile(uri as any);
  finish({ repoRoot: "/repo", toRepoRelative: () => "tracked.txt" });
  await pending;
  assert.equal(editorOpens, 0); assert.equal(presenter.gutterSnapshot(), undefined); assert.equal(mock.__errorMessages.length, 0);
});
