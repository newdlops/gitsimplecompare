import assert from "node:assert/strict";
import test from "node:test";
import {
  disposePullRequestQuickEdit,
  openPullRequestQuickEdit,
  parsePullRequestQuickEditPatch,
} from "../src/ui/pullRequestQuickEdit";
import * as vscodeMock from "./helpers/vscodeMock";

test("quick edit patch parser compresses additions and anchors removed lines", () => {
  const changes = parsePullRequestQuickEditPatch([
    "@@ -1,6 +1,7 @@",
    " keep",
    "-old",
    "+new",
    "+extra",
    " context",
    "-removed",
    " tail",
    "@@ -20,2 +21,3 @@",
    "+inserted",
    " end",
  ].join("\n"));

  assert.deepEqual(changes, {
    addedRanges: [
      { startLine: 2, endLine: 3 },
      { startLine: 21, endLine: 21 },
    ],
    deletedAnchors: [
      { line: 2, count: 1 },
      { line: 5, count: 1 },
    ],
  });
  assert.deepEqual(parsePullRequestQuickEditPatch(undefined), {
    addedRanges: [],
    deletedAnchors: [],
  });
  assert.deepEqual(parsePullRequestQuickEditPatch([
    "@@ -3,2 +3,0 @@",
    "-before-eof",
    "-at-eof",
    "\\ No newline at end of file",
  ].join("\n")), {
    addedRanges: [],
    deletedAnchors: [{ line: 3, count: 2 }],
  });
});

test("quick edit opens a normal editor and applies bounded added/deleted decorations", async (t) => {
  const windowApi = vscodeMock.window as any;
  const workspaceApi = vscodeMock.workspace as any;
  const originalWindow = { ...windowApi };
  const originalOpenTextDocument = workspaceApi.openTextDocument;
  const uri = {
    scheme: "file",
    fsPath: "/repo/src/file.ts",
    toString: () => "file:///repo/src/file.ts",
  };
  const document = { uri, lineCount: 4 };
  const decorationOptions: any[] = [];
  const decorationCalls: Array<{ decoration: any; values: any[] }> = [];
  const revealCalls: any[] = [];
  let shownOptions: any;

  windowApi.visibleTextEditors = [];
  windowApi.createTextEditorDecorationType = (options: any) => {
    const decoration = { id: decorationOptions.length, dispose() {} };
    decorationOptions.push(options);
    return decoration;
  };
  windowApi.onDidChangeVisibleTextEditors = () => ({ dispose() {} });
  windowApi.showTextDocument = async (shownDocument: any, options: any) => {
    shownOptions = options;
    return {
      document: shownDocument,
      setDecorations(decoration: any, values: any[]) {
        decorationCalls.push({ decoration, values });
      },
      revealRange(range: any, mode: any) {
        revealCalls.push({ range, mode });
      },
    };
  };
  workspaceApi.openTextDocument = async (openedUri: any) => {
    assert.equal(openedUri.fsPath, "/repo/src/file.ts");
    return document;
  };
  t.after(() => {
    disposePullRequestQuickEdit();
    Object.assign(windowApi, originalWindow);
    workspaceApi.openTextDocument = originalOpenTextDocument;
  });

  await openPullRequestQuickEdit("/repo", {
    path: "src/file.ts",
    status: "M",
    patch: [
      "@@ -1,3 +1,4 @@",
      " keep",
      "-old",
      "+new",
      "+extra",
      " tail",
    ].join("\n"),
  });

  assert.deepEqual(shownOptions, { preview: false, preserveFocus: false });
  assert.equal(decorationOptions.length, 2);
  assert.equal(decorationCalls.length, 2);
  assert.deepEqual(decorationCalls[0].values[0].values, [
    1, 0, 2, Number.MAX_SAFE_INTEGER,
  ]);
  assert.deepEqual(decorationCalls[1].values[0].range.values, [
    1, 0, 1, Number.MAX_SAFE_INTEGER,
  ]);
  assert.equal(
    decorationCalls[1].values[0].renderOptions.before.contentText,
    "−1 "
  );
  assert.equal(revealCalls.length, 1);
  assert.ok(vscodeMock.__outputLines.some((line) =>
    line.includes("PR preview quick edit opened")
      && line.includes('"addedRanges":1')
  ));
});

test("quick edit rejects paths outside the repository before opening a document", async () => {
  vscodeMock.__resetWindowMessages();
  let opened = false;
  const workspaceApi = vscodeMock.workspace as any;
  const originalOpenTextDocument = workspaceApi.openTextDocument;
  workspaceApi.openTextDocument = async () => {
    opened = true;
    return {};
  };
  try {
    await openPullRequestQuickEdit("/repo", {
      path: "../outside.ts",
      status: "M",
      patch: "",
    });
  } finally {
    workspaceApi.openTextDocument = originalOpenTextDocument;
    disposePullRequestQuickEdit();
  }
  assert.equal(opened, false);
  assert.deepEqual(vscodeMock.__warningMessages, [
    "This review file cannot be opened for quick editing.",
  ]);
});
