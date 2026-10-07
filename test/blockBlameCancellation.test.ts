import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type * as vscode from "vscode";
import { BlockBlameCodeLensController } from "../src/providers/blockBlameCodeLensController";
import type { GitServiceRegistry } from "../src/git/serviceRegistry";
import { GitBlameService } from "../src/git/blameService";
import { BlockBlamePresenter } from "../src/ui/blockBlamePresenter";
import { window, workspace, __resetWindowMessages, __errorMessages } from "./helpers/vscodeMock";

/** VS Code 취소 이벤트 경계만 대체하며 실제 CodeLens 소비자와 공유 캐시는 그대로 실행한다. */
function cancellation() {
  const callbacks = new Set<() => void>();
  const token: vscode.CancellationToken = { isCancellationRequested: false,
    onCancellationRequested: callback => { callbacks.add(callback); return { dispose: () => { callbacks.delete(callback); } }; } };
  return { token, cancel: () => { (token as { isCancellationRequested: boolean }).isCancellationRequested = true; for (const callback of callbacks) callback(); } };
}

test("one cancelled CodeLens consumer keeps the pending snapshot available to other viewports", async t => {
  const controller = new BlockBlameCodeLensController({} as GitServiceRegistry);
  const internal = controller as unknown as { visible: boolean; loadSnapshot: (document: vscode.TextDocument, signal: AbortSignal) => Promise<unknown> };
  internal.visible = true;
  const reads: { signal: AbortSignal; finish: () => void }[] = [];
  t.mock.method(internal, "loadSnapshot", (document, signal) => new Promise(resolve => {
    reads.push({ signal, finish: () => resolve({ documentVersion: document.version, summaries: [] }) });
  }));
  const document = { version: 1, isDirty: false, uri: { scheme: "file", fsPath: "/repo/code.ts", toString: () => "file:///repo/code.ts" } } as vscode.TextDocument;
  const first = cancellation(), second = cancellation(), third = cancellation();
  const a = controller.provideCodeLenses(document, first.token), b = controller.provideCodeLenses(document, second.token);
  let c: Promise<vscode.CodeLens[]> | undefined;
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(reads.length, 1);
    first.cancel(); assert.deepEqual(await a, []); assert.equal(reads[0].signal.aborted, false);
    c = controller.provideCodeLenses(document, third.token); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.length, 1, "an independent cancellation must not remove another viewport's pending cache");
    second.cancel(); await b; assert.equal(reads[0].signal.aborted, false);
    third.cancel(); await c; assert.equal(reads[0].signal.aborted, true, "the final viewport release must reach the actual loader");
  } finally {
    first.cancel(); second.cancel(); third.cancel(); reads.forEach(read => read.finish()); controller.dispose(); await Promise.all([a, b, c]);
  }
});

/** 지연된 Git 조회만 대체하고 presenter의 실제 취소·event·refresh 수명을 실행한다. */
function presenterFixture(t: TestContext) {
  __resetWindowMessages();
  const original = window.activeTextEditor;
  const document = { version: 1, isDirty: false, lineCount: 2, uri: { fsPath: "/repo/code.ts", toString: () => "file:///repo/code.ts" } };
  window.activeTextEditor = { document };
  t.after(() => { window.activeTextEditor = original; });
  const presenter = new BlockBlamePresenter({} as GitServiceRegistry);
  t.after(() => presenter.dispose());
  const internal = presenter as any;
  t.mock.method(internal, "resolveTarget", async () => ({ document, service: { repoRoot: "/repo", toRepoRelative: () => "code.ts" } }));
  const reads: Array<{ signal: AbortSignal; complete: () => void }> = [];
  t.mock.method(GitBlameService.prototype, "getFileBlame", (_file, _range, options) => new Promise((resolve, reject) => {
    const signal = options!.signal!;
    signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    reads.push({ signal, complete: () => resolve([{ line: 1, commit: "a".repeat(40), authorName: "Alice", authorMail: "", summary: "change", filename: "code.ts", content: "first" }]) });
  }));
  const request = { uri: document.uri.toString(), symbolName: "example", kind: "function", startLine: 1, endLine: 2, documentVersion: 1 };
  return { presenter, document, request, reads };
}

test("clicking the pending gutter closed cancels its Git consumer without an error notification", async t => {
  const f = presenterFixture(t);
  const first = f.presenter.show(f.request);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.reads.length, 1);
  await f.presenter.show(f.request); await first;
  assert.equal(f.reads[0].signal.aborted, true);
  assert.equal(f.presenter.gutterSnapshot(), undefined);
  assert.deepEqual(__errorMessages, []);
});

test("changing editor or editing the document also cancels a pending gutter read", async t => {
  for (const event of ["editor", "document"] as const) {
    const f = presenterFixture(t);
    let listener: (event: any) => void = () => { throw new Error("listener not registered"); };
    if (event === "editor") t.mock.method(window, "onDidChangeActiveTextEditor", callback => { listener = callback; return { dispose() {} }; });
    else t.mock.method(workspace, "onDidChangeTextDocument", callback => { listener = callback; return { dispose() {} }; });
    f.presenter.register();
    const pending = f.presenter.show(f.request);
    await new Promise(resolve => setImmediate(resolve));
    listener(event === "editor" ? undefined : { document: f.document, contentChanges: [{}] });
    await pending;
    assert.equal(f.reads[0].signal.aborted, true);
    assert.equal(f.presenter.gutterSnapshot(), undefined);
    assert.deepEqual(__errorMessages, []);
    f.presenter.dispose();
  }
});

test("repository refresh bursts make one new gutter read and retain the current snapshot", async t => {
  const f = presenterFixture(t);
  const first = f.presenter.show(f.request);
  await new Promise(resolve => setImmediate(resolve)); f.reads[0].complete(); await first;
  const snapshot = f.presenter.gutterSnapshot(); assert.ok(snapshot);
  f.presenter.refresh("HEAD"); f.presenter.refresh("index"); f.presenter.refresh("workingTree");
  assert.equal(f.presenter.gutterSnapshot(), snapshot);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(f.reads.length, 2);
  assert.equal(f.presenter.gutterSnapshot(), snapshot);
  f.presenter.dispose();
  assert.equal(f.reads[1].signal.aborted, true);
  assert.deepEqual(__errorMessages, []);
});
