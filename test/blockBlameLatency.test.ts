import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as vscode from "vscode";
import { commands, window, workspace, Uri, SymbolKind } from "./helpers/vscodeMock";
import { safetyFixture, git } from "./helpers/gitSafetyFixture";
import { GitServiceRegistry } from "../src/git/serviceRegistry";
import { GitBlameService, type GitBlameLine } from "../src/git/blameService";
import { BlockBlameCodeLensController } from "../src/providers/blockBlameCodeLensController";
import { BlockBlameSourceCache } from "../src/providers/blockBlameSourceCache";
import { loadBlockBlameSnapshot } from "../src/providers/blockBlameSnapshotLoader";
import { BlockBlamePresenter } from "../src/ui/blockBlamePresenter";

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as vscode.CancellationToken;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** 문서/설정/언어 심볼의 VS Code 경계만 재현하고 제품의 캐시·검증·집계·거터를 그대로 실행한다. */
function documentFixture(t: TestContext, file = "/repo/tracked.txt") {
  const previous = { state: window.state, editor: window.activeTextEditor };
  t.after(() => { window.state = previous.state; window.activeTextEditor = previous.editor; });
  const uri = { scheme: "file", fsPath: file, toString: () => pathToFileURL(file).href };
  const document = { uri, version: 1, languageId: "typescript", isDirty: false, lineCount: 1,
    lineAt: () => ({ text: "base", range: { start: { line: 0 }, end: { line: 0 } } }) } as vscode.TextDocument;
  window.state = { focused: true }; window.activeTextEditor = { document };
  t.mock.method(workspace, "getConfiguration", () => ({ get: (_key: string, fallback: unknown) => fallback }));
  t.mock.method(workspace, "openTextDocument", async () => document);
  t.mock.method(Uri, "parse", () => uri);
  let symbols = 0;
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };
  const symbol = { name: "example", kind: SymbolKind.Function, range, selectionRange: range, children: [] };
  t.mock.method(commands, "executeCommand", async (id: string) => {
    if (id === "vscode.executeDocumentSymbolProvider") { symbols++; return [symbol]; }
    return undefined;
  });
  const request = { uri: uri.toString(), symbolName: "example", kind: "function", startLine: 1, endLine: 1, documentVersion: 1 };
  return { document, symbol, request, symbols: () => symbols };
}

/** 제어 가능한 타이밍 테스트에 쓰는 실제 blame 레코드 모양이다. */
function lines(): GitBlameLine[] {
  return [{ line: 1, commit: "a".repeat(40), authorName: "Author", authorMail: "author@example.test", authorTime: 1700000000,
    summary: "base", filename: "tracked.txt", content: "base" }];
}

test("cold Block Author overlaps Git with slow symbols: controlled 1500ms serial path becomes 1200ms", async t => {
  const { document } = documentFixture(t);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
  const block = { id: "function:1", name: "example", kind: "function", startLine: 1, endLine: 1, declarationLine: 1 };
  const sources = { read: () => new Promise(resolve => setTimeout(() => resolve([block]), 1200)) } as unknown as BlockBlameSourceCache;
  const registry = { resolve: () => new Promise(resolve => setTimeout(() => resolve({ repoRoot: "/repo", toRepoRelative: () => "tracked.txt" }), 400)) } as unknown as GitServiceRegistry;
  let gitReads = 0, gitCompleted = false;
  t.mock.method(GitBlameService.prototype, "getFileBlame", () => {
    gitReads++; return new Promise(resolve => setTimeout(() => { gitCompleted = true; resolve(lines()); }, 300));
  });
  const startedAt = Date.now(), pending = loadBlockBlameSnapshot(document, registry, sources, new AbortController().signal);
  t.mock.timers.tick(400); await flush();
  t.mock.timers.tick(16); await flush();
  assert.equal(gitReads, 1, "Git must start while symbols are still pending");
  t.mock.timers.tick(300); await flush(); assert.equal(gitCompleted, true);
  t.mock.timers.tick(484); await flush();
  const snapshot = await pending;
  assert.equal(snapshot.summaries.length, 1); assert.equal(Date.now() - startedAt, 1200);
  assert.equal(snapshot.fileBlame?.length, 1);
});

test("slow empty symbols cancel speculative blame without an unhandled rejection", async t => {
  const { document } = documentFixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sources = { read: () => new Promise(resolve => setTimeout(() => resolve([]), 20)) } as unknown as BlockBlameSourceCache;
  const registry = { resolve: async () => ({ repoRoot: "/repo", toRepoRelative: () => "tracked.txt" }) } as unknown as GitServiceRegistry;
  let signal: AbortSignal | undefined;
  t.mock.method(GitBlameService.prototype, "getFileBlame", (_file, _range, options) => new Promise((_resolve, reject) => {
    signal = options!.signal; signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  }));
  const pending = loadBlockBlameSnapshot(document, registry, sources, new AbortController().signal);
  await flush(); t.mock.timers.tick(16); await flush(); assert.ok(signal);
  t.mock.timers.tick(4); await flush();
  assert.equal((await pending).skipReason, "no-supported-symbols"); assert.equal(signal.aborted, true);
  await flush();
});

test("prepared Code Vision opens and reopens the gutter with zero extra repository discovery or blame reads", async t => {
  const { root } = await safetyFixture(t, "blame-prepared"), f = documentFixture(t, path.join(root, "tracked.txt"));
  let discoveries = 0, reads = 0;
  const registry = new GitServiceRegistry(async () => { discoveries++; return { root, branch: "main" }; });
  const original = GitBlameService.prototype.getFileBlame;
  t.mock.method(GitBlameService.prototype, "getFileBlame", async function (...args) { reads++; return original.apply(this, args); });
  const controller = new BlockBlameCodeLensController(registry);
  const presenter = new BlockBlamePresenter(registry, (document, signal) => controller.preparedFile(document, signal));
  t.after(() => { presenter.dispose(); controller.dispose(); });
  assert.equal((await controller.provideCodeLenses(f.document, token)).length, 1);
  // 5초 저장소 탐색 TTL을 지나도 실제 metadata가 같으면 준비된 결과를 쓰되 blame의 60초 상한은 지킨다.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 6_000 });
  await presenter.show(f.request); assert.equal(presenter.gutterSnapshot()?.lines.length, 1);
  await presenter.show(f.request); assert.equal(presenter.gutterSnapshot(), undefined);
  await presenter.show(f.request); assert.equal(presenter.gutterSnapshot()?.lines.length, 1);
  assert.equal(discoveries, 1); assert.equal(reads, 1); assert.equal(f.symbols(), 1);
  assert.equal((await controller.provideCodeLenses(f.document, token)).length, 1);
  assert.equal(discoveries, 1); assert.equal(reads, 1); assert.equal(f.symbols(), 1);
  t.mock.timers.setTime(Date.now() + 55_000);
  assert.equal(await controller.preparedFile(f.document), undefined, "the original 60-second maximum age remains enforced");
});

test("repository refresh retains validated snapshots and reuses symbols after an actual HEAD change", async t => {
  const { root } = await safetyFixture(t, "blame-refresh"), f = documentFixture(t, path.join(root, "tracked.txt"));
  const registry = new GitServiceRegistry(async () => ({ root, branch: "main" }));
  let reads = 0; const original = GitBlameService.prototype.getFileBlame;
  t.mock.method(GitBlameService.prototype, "getFileBlame", async function (...args) { reads++; return original.apply(this, args); });
  const controller = new BlockBlameCodeLensController(registry); t.after(() => controller.dispose());
  await controller.provideCodeLenses(f.document, token);
  controller.refresh("unrelated-working-tree-event");
  await controller.provideCodeLenses(f.document, token);
  assert.equal(reads, 1); assert.equal(f.symbols(), 1);
  await git(root, "commit", "--allow-empty", "-qm", "new HEAD");
  assert.equal(await controller.preparedFile(f.document), undefined);
  controller.refresh("HEAD-changed");
  await controller.provideCodeLenses(f.document, token);
  assert.equal(reads, 2); assert.equal(f.symbols(), 1, "HEAD does not change document symbol ranges");
});

test("prepared blame rejects file, index, config, document and nested repository changes", async t => {
  const { root } = await safetyFixture(t, "blame-prepared-boundary"), directory = path.join(root, "nested");
  await mkdir(directory); await writeFile(path.join(directory, "code.ts"), "base\n");
  await git(root, "add", "nested/code.ts"); await git(root, "commit", "-qm", "nested file");
  const f = documentFixture(t, path.join(directory, "code.ts"));
  const registry = new GitServiceRegistry(async () => ({ root, branch: "main" }));
  const controller = new BlockBlameCodeLensController(registry); t.after(() => controller.dispose());
  await controller.provideCodeLenses(f.document, token);
  assert.ok(await controller.preparedFile(f.document));
  await writeFile(f.document.uri.fsPath, "changed content\n"); assert.equal(await controller.preparedFile(f.document), undefined);
  await controller.provideCodeLenses(f.document, token); assert.ok(await controller.preparedFile(f.document));
  await git(root, "add", "nested/code.ts"); assert.equal(await controller.preparedFile(f.document), undefined);
  await controller.provideCodeLenses(f.document, token);
  await git(root, "config", "blame.showRoot", "true"); assert.equal(await controller.preparedFile(f.document), undefined);
  await controller.provideCodeLenses(f.document, token);
  (f.document as any).isDirty = true; assert.equal(await controller.preparedFile(f.document), undefined);
  (f.document as any).isDirty = false; (f.document as any).version++;
  assert.equal(await controller.preparedFile(f.document), undefined);
  await controller.provideCodeLenses(f.document, token);
  await mkdir(path.join(directory, ".git")); assert.equal(await controller.preparedFile(f.document), undefined);
});

test("a registered provider preloads only the focused active saved file and shares the pending snapshot", async t => {
  const f = documentFixture(t);
  let lookup = 0, finish!: (value: undefined) => void, focus!: (value: { focused: boolean }) => void;
  const registry = { resolve: async () => { lookup++; return new Promise<undefined>(resolve => { finish = resolve; }); } } as unknown as GitServiceRegistry;
  t.mock.method(window, "onDidChangeWindowState", callback => { focus = callback; return { dispose() {} }; });
  const controller = new BlockBlameCodeLensController(registry); t.after(() => controller.dispose());
  controller.register(); await flush(); assert.equal(lookup, 1, "preload starts before VS Code requests lenses");
  const requested = controller.provideCodeLenses(f.document, token); finish(undefined);
  assert.deepEqual(await requested, []); assert.equal(lookup, 1);
  window.state = { focused: false }; focus(window.state);
  controller.refresh("background-refresh"); await flush(); assert.equal(lookup, 1);
});

test("symbol cache shares uncancellable API work, releases cancelled consumers and invalidates changed language/version", async t => {
  const f = documentFixture(t), cache = new BlockBlameSourceCache();
  let finish!: (symbols: unknown[]) => void, calls = 0;
  t.mock.method(commands, "executeCommand", async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = new AbortController(), a = cache.read(f.document, first.signal), b = cache.read(f.document);
  const rejected = assert.rejects(a, { name: "AbortError" }); first.abort(); await rejected;
  assert.equal(calls, 1); finish([f.symbol]); assert.equal((await b).length, 1);
  assert.equal((await cache.read(f.document)).length, 1); assert.equal(calls, 1);
  (f.document as any).languageId = "javascript";
  const changed = cache.read(f.document); finish([f.symbol]); await changed; assert.equal(calls, 2);
  (f.document as any).version++;
  const newer = cache.read(f.document); finish([f.symbol]); await newer; assert.equal(calls, 3);
  cache.invalidate(f.document.uri.toString());
  const invalidated = cache.read(f.document); finish([f.symbol]); await invalidated; assert.equal(calls, 4);
  cache.clear();
});

test("focus recovery retains completed symbols and blame but still validates an externally changed HEAD", async t => {
  const { root } = await safetyFixture(t, "blame-focus-warm"), f = documentFixture(t, path.join(root, "tracked.txt"));
  const registry = new GitServiceRegistry(async () => ({ root, branch: "main" }));
  let focus!: (value: { focused: boolean }) => void, reads = 0;
  t.mock.method(window, "onDidChangeWindowState", callback => { focus = callback; return { dispose() {} }; });
  const original = GitBlameService.prototype.getFileBlame;
  t.mock.method(GitBlameService.prototype, "getFileBlame", async function (...args) { reads++; return original.apply(this, args); });
  const controller = new BlockBlameCodeLensController(registry); t.after(() => controller.dispose());
  controller.register(); await controller.provideCodeLenses(f.document, token);
  window.state = { focused: false }; focus(window.state);
  window.state = { focused: true }; focus(window.state);
  await controller.provideCodeLenses(f.document, token);
  assert.equal(reads, 1); assert.equal(f.symbols(), 1);
  window.state = { focused: false }; focus(window.state);
  await git(root, "commit", "--allow-empty", "-qm", "external HEAD");
  window.state = { focused: true }; focus(window.state);
  await controller.provideCodeLenses(f.document, token);
  assert.equal(reads, 2); assert.equal(f.symbols(), 1);
});

test("cancelling during prepared-file validation never reopens the editor or starts fallback Git", async t => {
  const f = documentFixture(t); let finish!: (value: undefined) => void, signal: AbortSignal | undefined;
  const registry = { resolve: async () => assert.fail("Cancelled validation cannot discover a repository") } as unknown as GitServiceRegistry;
  const presenter = new BlockBlamePresenter(registry, async (_document, abort) => {
    signal = abort; return new Promise(resolve => { finish = resolve; });
  });
  t.after(() => presenter.dispose());
  t.mock.method(GitBlameService.prototype, "getFileBlame", async () => assert.fail("Cancelled validation cannot load blame"));
  const pending = presenter.show(f.request); await flush(); assert.ok(signal);
  await presenter.show(f.request); assert.equal(signal.aborted, true);
  finish(undefined); await pending; assert.equal(presenter.gutterSnapshot(), undefined);
});

test("disabled editor CodeLens starts no preload, and a tab switch cancels its obsolete preload consumer", async t => {
  const f = documentFixture(t); let enabled = false, active!: (editor: any) => void, signal: AbortSignal | undefined;
  t.mock.method(workspace, "getConfiguration", section => ({ get: (key: string, fallback: unknown) => section === "editor" && key === "codeLens" ? enabled : fallback }));
  t.mock.method(window, "onDidChangeActiveTextEditor", callback => { active = callback; return { dispose() {} }; });
  const controller = new BlockBlameCodeLensController({} as GitServiceRegistry);
  const internal = controller as unknown as { loadSnapshot(document: vscode.TextDocument, signal: AbortSignal): Promise<unknown> };
  let calls = 0;
  t.mock.method(internal, "loadSnapshot", (_document, abort) => new Promise((_resolve, reject) => {
    calls++; signal = abort; abort.addEventListener("abort", () => reject(abort.reason), { once: true });
  }));
  t.after(() => controller.dispose());
  controller.register(); await flush(); assert.equal(calls, 0);
  enabled = true; active({ document: f.document }); await flush(); assert.equal(calls, 1);
  active({ document: f.document }); await flush(); assert.equal(calls, 1, "the same active document shares preload");
  window.activeTextEditor = undefined; active(undefined); assert.equal(signal?.aborted, true); await flush();
});
