import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type * as vscode from "vscode";
import { window, workspace, commands, SymbolKind } from "./helpers/vscodeMock";
import { NativeBlamePreparation } from "../src/providers/nativeBlamePreparation";
import type { NativeOverlayConnection } from "../src/providers/nativeOverlayConnection";
import { NativeDiffOverlayController } from "../src/providers/nativeDiffOverlayController";
import { BlockBlameCodeLensController } from "../src/providers/blockBlameCodeLensController";
import { GitBlameService } from "../src/git/blameService";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** 실제 준비 수명을 실행하며 VS Code 문서/설정과 CDP 전송 경계만 제어한다. */
function fixture(t: TestContext) {
  const previous = { state: window.state, active: window.activeTextEditor };
  t.after(() => { window.state = previous.state; window.activeTextEditor = previous.active; });
  const uri = { scheme: "file", fsPath: "/repo/code.ts", toString: () => "file:///repo/code.ts" };
  const document = { uri, version: 1, isDirty: false, isClosed: false, languageId: "typescript", lineCount: 1,
    lineAt: () => ({ text: "function example() {}", range: { start: { line: 0 }, end: { line: 0 } } }) } as vscode.TextDocument;
  window.state = { focused: true }; window.activeTextEditor = { document };
  const settings: Record<string, boolean> = {};
  t.mock.method(workspace, "getConfiguration", () => ({ get: (key: string, fallback: boolean) => settings[key] ?? fallback }));
  let opened = false, connects = 0, evaluations = 0, before = 0, captures = 0;
  const connection = { isOpen: () => opened, ensureConnected: async () => { connects++; opened = true; },
    evaluateMain: async (expression: string) => { evaluations++; assert.match(expression, /preparationOnly = true/); return "ok:7:blame-editor-prepared"; } };
  const preparation = new NativeBlamePreparation(connection as unknown as NativeOverlayConnection, () => ({ paths: ["/repo"], names: ["repo"] }),
    () => { before++; }, () => { captures++; });
  return { preparation, document, settings, connection, counts: () => ({ connects, evaluations, before, captures }), close: () => { opened = false; } };
}

test("native preparation deduplicates requests and keeps rendering out of its expression", async t => {
  const f = fixture(t);
  assert.equal(f.preparation.request(f.document), true); assert.equal(f.preparation.request(f.document), false);
  await f.preparation.runPending(); assert.deepEqual(f.counts(), { connects: 1, evaluations: 1, before: 1, captures: 1 });
  assert.equal(f.preparation.request(f.document), false); await f.preparation.runPending(); assert.equal(f.counts().evaluations, 1);
  f.close(); assert.equal(f.preparation.request(f.document), true); await f.preparation.runPending(); assert.equal(f.counts().evaluations, 2);
});

test("preparation skips unfocused, edited, closed, hidden and inactive documents", async t => {
  const f = fixture(t), document = f.document as any;
  window.state = { focused: false }; assert.equal(f.preparation.request(f.document), false); window.state = { focused: true };
  document.isDirty = true; assert.equal(f.preparation.request(f.document), false); document.isDirty = false;
  document.isClosed = true; assert.equal(f.preparation.request(f.document), false); document.isClosed = false;
  f.settings.codeLens = false; assert.equal(f.preparation.request(f.document), false); f.settings.codeLens = true;
  f.settings["blameBlock.show"] = false; assert.equal(f.preparation.request(f.document), false); f.settings["blameBlock.show"] = true;
  window.activeTextEditor = undefined; assert.equal(f.preparation.request(f.document), false);
  assert.equal(f.counts().connects, 0);
});

test("a changed document or cancelled pending intent cannot start editor discovery", async t => {
  const f = fixture(t); f.preparation.request(f.document); f.preparation.clearPending(); await f.preparation.runPending();
  assert.equal(f.counts().connects, 0);
  f.preparation.request(f.document); (f.document as any).version++; await f.preparation.runPending(); assert.equal(f.counts().connects, 0);
  let connected!: () => void;
  t.mock.method(f.connection, "ensureConnected", () => new Promise<void>(resolve => { connected = resolve; }));
  f.preparation.request(f.document); const pending = f.preparation.runPending(); await flush();
  window.activeTextEditor = undefined; connected(); await pending; assert.equal(f.counts().evaluations, 0);
});

test("repeated source events share in-progress preparation and failures leave the normal click path available", async t => {
  const f = fixture(t); let finish!: () => void;
  t.mock.method(f.connection, "ensureConnected", async () => new Promise<void>(resolve => { finish = resolve; }));
  f.preparation.request(f.document); const pending = f.preparation.runPending(); await flush();
  assert.equal(f.preparation.request(f.document), false); finish(); await pending;
  f.close();
  t.mock.method(f.connection, "ensureConnected", async () => { throw new Error("inspector unavailable"); });
  f.preparation.request(f.document); await assert.doesNotReject(f.preparation.runPending());
  assert.equal(f.preparation.request(f.document), true, "failure must allow a later foreground attempt");
});

test("an installed method observer requests a cached Code Vision refresh before awaiting its capture", async t => {
  const f = fixture(t), order: string[] = [];
  t.mock.method(f.connection, "evaluateMain", async (expression: string) => {
    if (expression.includes("preparationOnly = true")) { order.push("observe"); return "ok:7:blame-editor-observing"; }
    order.push("complete"); return "ok:7:blame-editor-prepared";
  });
  const preparation = new NativeBlamePreparation(f.connection as unknown as NativeOverlayConnection,
    () => ({ paths: ["/repo"], names: ["repo"] }), () => {}, () => {}, document => {
      assert.equal(document, f.document); order.push("refresh");
    });
  preparation.request(f.document); await preparation.runPending();
  assert.deepEqual(order, ["observe", "refresh", "complete"]);
  assert.equal(preparation.request(f.document), false);
});

test("source blocks trigger native preparation before the shared Git blame read completes", async t => {
  const f = fixture(t); let finishBlame!: (value: any[]) => void;
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 21 } };
  t.mock.method(commands, "executeCommand", async () => [{ name: "example", kind: SymbolKind.Function, range, selectionRange: range, children: [] }]);
  t.mock.method(GitBlameService.prototype, "getFileBlame", () => new Promise(resolve => { finishBlame = resolve; }));
  const controller = new BlockBlameCodeLensController({ resolve: async () => ({ repoRoot: "/repo", toRepoRelative: () => "code.ts" }) } as any);
  t.after(() => controller.dispose());
  t.mock.method((controller as any).preparationEmitter, "fire", document => {
    if (f.preparation.request(document)) void f.preparation.runPending();
  });
  const read = controller.provideCodeLenses(f.document, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  await flush(); assert.equal(f.counts().evaluations, 1, "native work must overlap Git rather than start after the click");
  finishBlame([{ line: 1, commit: "a".repeat(40), authorName: "Author", authorMail: "a@example.test", summary: "example", filename: "code.ts", content: "function example() {}" }]);
  assert.equal((await read).length, 1);
});

test("preparation-only debugger ownership is released even when no gutter was opened", async t => {
  const f = fixture(t), values = new Map<string, unknown>(), expressions: string[] = [];
  const state = { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } };
  const hunks = { mode: () => "nativeOverlay", overlaySnapshots: async () => [], setNativeOverlayAvailable() {} };
  const controller = new NativeDiffOverlayController({ fsPath: "/storage" } as any, state as any, hunks as any);
  const internal = controller as any;
  t.after(() => controller.shutdown());
  let opened = false;
  t.mock.method(internal.connection, "isOpen", () => opened);
  t.mock.method(internal.connection, "ensureConnected", async () => { opened = true; });
  t.mock.method(internal.connection, "evaluateMain", async (expression: string) => {
    expressions.push(expression); return expression.includes("preparationOnly = true") ? "ok:7:blame-editor-prepared" : "released:7";
  });
  internal.blamePreparation.request(f.document); await internal.render("prepareBlockBlame");
  assert.equal(expressions.filter(value => value.includes("preparationOnly = true")).length, 1);
  assert.ok(expressions.some(value => value.includes("releaseWindow(wins[i])")));
  assert.equal(internal.blameSurfaceMayExist, false); assert.equal(internal.rendererBridgeMayExist, false);
  assert.equal(values.get("gitSimpleCompare.nativeOverlaySurfacesMayExist"), undefined);
});
