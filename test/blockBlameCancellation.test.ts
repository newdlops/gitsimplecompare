import assert from "node:assert/strict";
import test from "node:test";
import type * as vscode from "vscode";
import { BlockBlameCodeLensController } from "../src/providers/blockBlameCodeLensController";
import type { GitServiceRegistry } from "../src/git/serviceRegistry";

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
