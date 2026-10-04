import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as vscode from "vscode";
import { window, workspace } from "./helpers/vscodeMock";
import { BlockBlameCodeLensController } from "../src/providers/blockBlameCodeLensController";
import { BlameDecoratorController } from "../src/providers/blameDecoratorController";
import type { GitServiceRegistry } from "../src/git/serviceRegistry";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readBlameCacheIdentity } from "../src/git/blameCacheIdentity";

const document = { version: 1, isDirty: false, lineCount: 1, uri: { scheme: "file", fsPath: "/repo/code.ts", toString: () => "file:///repo/code.ts" } } as vscode.TextDocument;
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as vscode.CancellationToken;

/** focus 이벤트와 설정의 VS Code 경계만 재현하고 실제 컨트롤러/공유 소비자 수명을 검사한다. */
function fixture(t: TestContext, focused: boolean) {
  const oldState = window.state, oldEditor = window.activeTextEditor;
  t.after(() => { window.state = oldState; window.activeTextEditor = oldEditor; });
  window.state = { focused }; window.activeTextEditor = { document, setDecorations() {} };
  t.mock.method(workspace, "getConfiguration", () => ({ get: (_key: string, defaultValue?: unknown) => defaultValue ?? true }));
  let listener: ((state: { focused: boolean }) => void) | undefined;
  t.mock.method(window, "onDidChangeWindowState", callback => { listener = callback; return { dispose() {} }; });
  return { focus: (focused: boolean) => { window.state = { focused }; listener?.(window.state); }, registered: () => !!listener };
}

test("unfocused CodeLens requests skip repository and blame work", async t => {
  fixture(t, false); let resolves = 0;
  const registry = { resolve: async () => { resolves++; return undefined; } } as unknown as GitServiceRegistry;
  const controller = new BlockBlameCodeLensController(registry); t.after(() => controller.dispose());
  (controller as unknown as { visible: boolean }).visible = true;
  assert.deepEqual(await controller.provideCodeLenses(document, token), []);
  assert.equal(resolves, 0);
});

test("losing focus cancels every pending CodeLens consumer and regaining focus requests fresh lenses", async t => {
  const f = fixture(t, true), controller = new BlockBlameCodeLensController({} as GitServiceRegistry);
  t.after(() => controller.dispose());
  const internal = controller as unknown as { visible: boolean; loadSnapshot: (document: vscode.TextDocument, signal: AbortSignal) => Promise<unknown>; changeEmitter: { fire(): void } };
  let signal: AbortSignal | undefined, changes = 0;
  t.mock.method(internal, "loadSnapshot", (_document, abort) => new Promise((_resolve, reject) => {
    signal = abort; abort.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
  }));
  t.mock.method(internal.changeEmitter, "fire", () => { changes++; });
  controller.register(); internal.visible = true;
  const pending = controller.provideCodeLenses(document, token);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.registered(), true);
  f.focus(false);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(await pending, []);
  const before = changes; f.focus(true); assert.ok(changes > before);
});

test("an unfocused line decorator defers its timer and resumes at window focus", async t => {
  const f = fixture(t, false); let resolves = 0;
  t.mock.method(workspace, "getConfiguration", () => ({ get: () => true }));
  const registry = { resolve: async () => { resolves++; return undefined; } } as unknown as GitServiceRegistry;
  const controller = new BlameDecoratorController(registry); t.after(() => controller.dispose()); controller.register();
  await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(resolves, 0);
  assert.equal(f.registered(), true); f.focus(true);
  await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(resolves, 1);
});

test("a completed CodeLens snapshot is refreshed when HEAD changes before its TTL", async t => {
  fixture(t, true);
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-blame-lenses-head-")), gitDir = path.join(root, ".git"), file = path.join(root, "code.ts");
  await mkdir(path.join(gitDir, "refs", "heads"), { recursive: true });
  await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(path.join(gitDir, "refs", "heads", "main"), `${"a".repeat(40)}\n`); await writeFile(file, "first\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  const doc = { ...document, uri: { scheme: "file", fsPath: file, toString: () => `file://${file}` } } as vscode.TextDocument;
  const controller = new BlockBlameCodeLensController({} as GitServiceRegistry); t.after(() => controller.dispose());
  const internal = controller as unknown as { visible: boolean; loadSnapshot: (document: vscode.TextDocument, signal: AbortSignal) => Promise<unknown> };
  internal.visible = true; let reads = 0;
  t.mock.method(internal, "loadSnapshot", async () => {
    reads++; return { documentVersion: 1, summaries: [], repoRoot: root, cacheIdentity: await readBlameCacheIdentity(root, file) };
  });
  await controller.provideCodeLenses(doc, token); await controller.provideCodeLenses(doc, token); assert.equal(reads, 1);
  await writeFile(path.join(gitDir, "refs", "heads", "main"), `${"b".repeat(40)}\n`);
  await controller.provideCodeLenses(doc, token); assert.equal(reads, 2);
});
