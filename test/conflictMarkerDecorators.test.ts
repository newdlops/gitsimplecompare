import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type * as vscode from "vscode";
import { ConflictService, type ConflictSources } from "../src/git/conflictService";
import type { GitServiceRegistry } from "../src/git/serviceRegistry";
import { ConflictMarkerDecoratorController } from "../src/providers/conflictMarkerDecoratorController";
import type { ConflictEditorOverlayController } from "../src/providers/conflictEditorOverlayController";
import { disposeOutputLog } from "../src/ui/outputLog";
import * as vscodeMock from "./helpers/vscodeMock";

const MARKERS = "<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> topic\n";
const SOURCES: ConflictSources = {
  operation: "merge",
  current: { label: "Current", ref: "HEAD" },
  incoming: { label: "Incoming", ref: "topic" },
};

/** 테스트가 VS Code 이벤트를 직접 전달하고 dispose 뒤 구독 해제까지 관찰한다. */
function eventSource<T>() {
  const listeners = new Set<(event: T) => void>();
  return {
    event(listener: (event: T) => void) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    fire(event: T) { for (const listener of listeners) listener(event); },
  };
}

/**
 * 실제 편집처럼 version을 증가시키고 잘못된 라인 접근을 거부하는 문서/에디터를 만든다.
 * @param text 초기 파일 내용
 * @param scheme OUTPUT/일반 파일/custom Result를 구분할 URI scheme
 * @param name 분할/다중 문서 테스트에서 URI를 구분할 파일명
 * @returns 변경 가능한 문서와 decoration 호출 기록을 가진 에디터 대역
 */
function createEditor(text = MARKERS, scheme = "file", name = "conflict.ts") {
  let cachedText = text;
  let lines = text.split("\n");
  const uri = {
    scheme, fsPath: `/repo/${name}`,
    toString: () => `${scheme}:///repo/${name}`,
  };
  const document = {
    uri, version: 1, isClosed: false, text,
    getText() { return this.text; },
    lineAt(line: number) {
      if (this.text !== cachedText) {
        cachedText = this.text;
        lines = this.text.split("\n");
      }
      assert.ok(line >= 0 && line < lines.length, `Stale decoration line: ${line}`);
      return { range: { start: { line, character: 0 }, end: { line, character: lines[line].length } } };
    },
  };
  const calls: Array<{ kind: number; options: vscode.DecorationOptions[] }> = [];
  return {
    document, calls,
    setDecorations(type: { kind: number }, options: vscode.DecorationOptions[]) {
      calls.push({ kind: type.kind, options });
    },
  };
}

type TestEditor = ReturnType<typeof createEditor>;

/** 대역에 없는 VS Code API를 테스트 동안만 설치하고 원래 속성 상태를 복원한다. */
function install(t: TestContext, target: object, key: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  });
}

/**
 * 실제 controller의 이벤트·debounce·Git 조회·OUTPUT 쓰기를 연결한 재현 환경이다.
 * @param t 타이머와 API 대역의 수명을 소유할 테스트
 * @param editors 처음부터 보이는 에디터들
 * @param overlayScheme controller가 소유한 custom Result scheme
 * @returns 이벤트 전달, 비동기 진행, 로그/조회 횟수 관찰 도구
 */
function setup(t: TestContext, editors: TestEditor[], overlayScheme?: string) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  disposeOutputLog();
  const changed = eventSource<any>();
  const saved = eventSource<any>();
  const active = eventSource<any>();
  const visible = eventSource<any>();
  const metadataChanged = eventSource<void>();
  const gitChanged = eventSource<any>();
  const state = {
    reads: 0, resolves: 0, logs: [] as string[],
    feedbackDocument: undefined as TestEditor["document"] | undefined,
    metadata: async (): Promise<ConflictSources> => SOURCES,
    sessionDocument: { ...SOURCES, metadataState: "ready" } as any,
  };
  let kind = 0;
  install(t, vscodeMock.window, "visibleTextEditors", editors);
  install(t, vscodeMock.window, "onDidChangeActiveTextEditor", active.event);
  install(t, vscodeMock.window, "onDidChangeVisibleTextEditors", visible.event);
  install(t, vscodeMock.workspace, "onDidChangeTextDocument", changed.event);
  install(t, vscodeMock.workspace, "onDidSaveTextDocument", saved.event);
  install(t, vscodeMock.MarkdownString.prototype, "appendText", function (this: any, value: string) { this.value = value; return this; });
  t.mock.method(vscodeMock.window, "createTextEditorDecorationType", () => ({ kind: kind++, dispose() {} }));
  t.mock.method(vscodeMock.window, "createOutputChannel", () => ({
    append() {}, show() {}, dispose() {},
    appendLine(line: string) {
      state.logs.push(line);
      if (state.feedbackDocument) {
        const document = state.feedbackDocument;
        queueMicrotask(() => changed.fire({ document, contentChanges: [{ text: line }] }));
      }
    },
  }));
  t.mock.method(ConflictService.prototype, "getConflictSources", async () => {
    state.reads++;
    return state.metadata();
  });
  const registry = {
    resolve: async () => {
      state.resolves++;
      return { repoRoot: "/repo", toRepoRelative: (file: string) => file.slice(6) };
    },
  } as unknown as GitServiceRegistry;
  const overlay = overlayScheme ? {
    onDidChangeOverlay: metadataChanged.event,
    ownsUri: (uri: vscode.Uri) => uri.scheme === overlayScheme,
    sessionForUri: (uri: vscode.Uri) => uri.scheme === overlayScheme
      ? { service: { repoRoot: "/repo" }, rel: "conflict.ts", document: state.sessionDocument } : undefined,
  } as unknown as ConflictEditorOverlayController : undefined;
  const controller = new ConflictMarkerDecoratorController(registry, overlay, { onDidRefresh: gitChanged.event });
  controller.register();
  t.after(() => { controller.dispose(); disposeOutputLog(); });
  return {
    state, controller, changed, saved, active, visible, metadataChanged, gitChanged,
    /** debounce를 진행한 뒤 Promise/OUTPUT 이벤트가 모두 끝날 때까지 한 tick 기다린다. */
    async advance(ms = 130) { t.mock.timers.tick(ms); await setImmediate(); },
    /** 실제 내용 편집으로 문서 version을 증가시키고 contentChanges 이벤트를 전달한다. */
    edit(editor: TestEditor, text: string) {
      editor.document.text = text;
      editor.document.version++;
      changed.fire({ document: editor.document, contentChanges: [{ text }] });
    },
  };
}

/** Git metadata 지연 중 편집/탭 닫기/폐기가 끼어드는 순서를 재현한다. */
function deferredSources() {
  let resolve!: (value: ConflictSources) => void;
  const promise = new Promise<ConflictSources>(done => { resolve = done; });
  return { promise, resolve };
}

test("visible OUTPUT changes cannot feed conflict decoration logs back into refresh", async t => {
  const file = createEditor();
  const output = createEditor("Git Simple Compare logs", "output", "Git Simple Compare");
  const h = setup(t, [file, output]);
  h.state.feedbackDocument = output.document;
  await h.advance(0);
  for (let cycle = 0; cycle < 6; cycle++) await h.advance();
  assert.equal(h.state.reads, 1, "Logging must not trigger another Git metadata read");
  assert.equal(h.state.logs.filter(line => line.includes("decorators applied")).length, 1);
  assert.equal(output.calls.length, 0, "OUTPUT must never receive conflict decorations");
});

test("dirty-state notifications and unrelated virtual document changes are ignored", async t => {
  const file = createEditor();
  const virtual = createEditor("other content", "git");
  const h = setup(t, [file, virtual]);
  await h.advance(0);
  const applied = file.calls.length;
  for (let cycle = 0; cycle < 4; cycle++) {
    h.changed.fire({ document: file.document, contentChanges: [] });
    h.changed.fire({ document: virtual.document, contentChanges: [{ text: "new" }] });
    h.saved.fire(virtual.document);
    await h.advance();
  }
  assert.equal(h.state.reads, 1);
  assert.equal(file.calls.length, applied);
});

test("an edit in another visible file does not repaint an unchanged conflict editor", async t => {
  const file = createEditor();
  const other = createEditor("plain text", "file", "other.ts");
  const h = setup(t, [file, other]);
  await h.advance(0);
  const applied = file.calls.length;
  h.edit(other, "new plain text");
  await h.advance();
  assert.equal(h.state.reads, 1);
  assert.equal(file.calls.length, applied);
});

test("existing highlights stay visible until fresh save metadata can replace them", async t => {
  const file = createEditor();
  const h = setup(t, [file]);
  await h.advance(0);
  const applied = file.calls.length;
  const pending = deferredSources();
  h.state.metadata = () => pending.promise;
  h.edit(file, "prefix\n" + MARKERS);
  h.saved.fire(file.document);
  await h.advance();
  assert.equal(h.state.reads, 2);
  assert.equal(file.calls.length, applied, "Do not clear highlights while waiting for Git");
  pending.resolve(SOURCES);
  await h.advance(0);
  assert.equal(file.calls.length, applied + 4);
  assert.equal(file.calls.at(-4)?.options[0].range.start.line, 2);
  assert.ok(file.calls.at(-4)?.options[0].hoverMessage);
});

test("plain file typing shares source metadata until Git refresh or Save invalidates it", async t => {
  const file = createEditor(), h = setup(t, [file]); await h.advance(0);
  for (let index = 0; index < 30; index++) { h.edit(file, `prefix ${index}\n` + MARKERS); await h.advance(); }
  assert.equal(h.state.reads, 1);
  assert.equal(file.calls.length, 31 * 4);
  h.gitChanged.fire({}); await h.advance(); assert.equal(h.state.reads, 2);
  h.edit(file, "another edit\n" + MARKERS); await h.advance(); assert.equal(h.state.reads, 2);
  h.saved.fire(file.document); await h.advance(); assert.equal(h.state.reads, 3);
});

test("owned typing signals do not postpone the document decoration timer", async t => {
  const file = createEditor(MARKERS, "gitsimplecompare-conflict");
  const h = setup(t, [file], "gitsimplecompare-conflict"); await h.advance(0);
  const applied = file.calls.length;
  h.edit(file, "prefix\n" + MARKERS); await h.advance(80);
  h.metadataChanged.fire(); await h.advance(40);
  assert.equal(file.calls.length, applied + 4);
  assert.equal(file.calls.at(-4)?.options[0].range.start.line, 2);
});

test("Git source invalidation survives a later owned metadata notification", async t => {
  const file = createEditor(), owned = createEditor(MARKERS, "gitsimplecompare-conflict");
  const h = setup(t, [file, owned], "gitsimplecompare-conflict"); await h.advance(0);
  assert.equal(h.state.reads, 1);
  h.gitChanged.fire({});
  h.state.sessionDocument = { ...h.state.sessionDocument };
  h.metadataChanged.fire(); await h.advance();
  assert.equal(h.state.reads, 2);
  assert.equal(file.calls.length, 8); assert.equal(owned.calls.length, 8);
});

test("a metadata event during a slow Save refresh cannot restore stale source hovers", async t => {
  const file = createEditor(), owned = createEditor(MARKERS, "gitsimplecompare-conflict");
  const h = setup(t, [file, owned], "gitsimplecompare-conflict"); await h.advance(0);
  const pending = deferredSources(); h.state.metadata = () => pending.promise;
  h.saved.fire(file.document); await h.advance();
  h.state.sessionDocument = { ...h.state.sessionDocument };
  h.metadataChanged.fire(); await h.advance();
  pending.resolve({ ...SOURCES, incoming: { ...SOURCES.incoming, subject: "Fresh Git source after Save" } });
  await h.advance(0);
  const hover = file.calls.at(-2)?.options[0].hoverMessage as vscode.MarkdownString;
  assert.match(hover.value, /Fresh Git source after Save/);
  const reads = h.state.reads;
  h.edit(file, "prefix\n" + MARKERS); await h.advance();
  assert.equal(h.state.reads, reads);
  assert.match((file.calls.at(-2)?.options[0].hoverMessage as vscode.MarkdownString).value, /Fresh Git source after Save/);
});

test("resolving markers removes highlights once without reading Git again", async t => {
  const file = createEditor();
  const h = setup(t, [file]);
  await h.advance(0);
  const applied = file.calls.length;
  h.edit(file, "resolved\n");
  await h.advance();
  assert.equal(h.state.reads, 1);
  assert.equal(file.calls.length, applied + 4);
  assert.ok(file.calls.slice(-4).every(call => call.options.length === 0));
  h.saved.fire(file.document);
  await h.advance();
  assert.equal(file.calls.length, applied + 4);
});

test("stale metadata cannot repaint a document changed during the lookup", async t => {
  const file = createEditor();
  const h = setup(t, [file]);
  const pending = deferredSources();
  h.state.metadata = () => pending.promise;
  await h.advance(0);
  h.edit(file, "resolved\n");
  pending.resolve(SOURCES);
  await h.advance(0);
  assert.equal(file.calls.length, 0);
  await h.advance();
  assert.equal(h.state.logs.some(line => line.includes("decorators applied")), false);
});

test("a closed editor cannot receive a late decoration result", async t => {
  const file = createEditor();
  const h = setup(t, [file]);
  const pending = deferredSources();
  h.state.metadata = () => pending.promise;
  await h.advance(0);
  file.document.isClosed = true;
  vscodeMock.window.visibleTextEditors = [];
  pending.resolve(SOURCES);
  await h.advance(0);
  assert.equal(file.calls.length, 0);
});

test("disposing the controller prevents an in-flight repaint", async t => {
  const file = createEditor();
  const h = setup(t, [file]);
  const pending = deferredSources();
  h.state.metadata = () => pending.promise;
  await h.advance(0);
  h.controller.dispose();
  const disposed = file.calls.length;
  pending.resolve(SOURCES);
  await h.advance();
  assert.equal(file.calls.length, disposed);
  assert.equal(h.state.logs.some(line => line.includes("decorators applied")), false);
});

test("owned Result edits reuse published sources without starting Git reads", async t => {
  const file = createEditor(MARKERS, "gitsimplecompare-conflict");
  const h = setup(t, [file], "gitsimplecompare-conflict");
  await h.advance(0);
  const applied = file.calls.length;
  h.state.metadata = async () => { throw new Error("metadata unavailable"); };
  h.edit(file, "prefix\n" + MARKERS);
  await h.advance();
  assert.equal(h.state.resolves, 0);
  assert.equal(file.calls.length, applied + 4);
  assert.equal(file.calls.at(-4)?.options[0].range.start.line, 2);
  assert.equal(h.state.reads, 0);
  h.state.sessionDocument = { operation: "rebase", metadataState: "pending",
    current: { label: "Current", ref: "index stage 2" }, incoming: { label: "Incoming", ref: "index stage 3" } };
  h.metadataChanged.fire(); await h.advance();
  assert.equal(file.calls.length, applied + 8);
  assert.equal(h.state.reads, 0);
  const pendingHover = file.calls.at(-2)?.options[0].hoverMessage as vscode.MarkdownString;
  assert.match(pendingHover.value, /index stage 3/); assert.doesNotMatch(pendingHover.value, /nested|replayed/);
  h.metadataChanged.fire(); await h.advance();
  assert.equal(file.calls.length, applied + 8, "Unchanged metadata must not repaint");
});

test("compacted body ranges preserve gaps, Base sections and marker lines", async t => {
  const block = "<<<<<<< HEAD\ncurrent 1\ncurrent 2\n||||||| base\nbase 1\n=======\nincoming 1\nincoming 2\n>>>>>>> side\n";
  const file = createEditor(block + "unchanged gap\n" + block, "gitsimplecompare-conflict");
  const h = setup(t, [file], "gitsimplecompare-conflict"); await h.advance(0);
  const [current, base, incoming, markers] = file.calls.slice(-4);
  assert.deepEqual(current.options.map(option => [option.range.start.line, option.range.end.line]), [[1, 2], [11, 12]]);
  assert.deepEqual(base.options.map(option => [option.range.start.line, option.range.end.line]), [[4, 4], [14, 14]]);
  assert.deepEqual(incoming.options.map(option => [option.range.start.line, option.range.end.line]), [[6, 7], [16, 17]]);
  assert.equal(markers.options.length, 8); assert.equal(h.state.reads, 0);
});

test("large conflict blocks and split editors keep independent decoration state", async t => {
  const text = "<<<<<<< HEAD\n" + "current\n".repeat(17_117) +
    "=======\n" + "incoming\n".repeat(181) + ">>>>>>> topic\n";
  const left = createEditor(text);
  const right = createEditor(text);
  right.document = left.document;
  const h = setup(t, [left, right]);
  await h.advance(0);
  assert.equal(left.calls.at(-4)?.options.length, 1);
  assert.equal(right.calls.at(-2)?.options.length, 1);
  assert.equal(left.calls.at(-4)?.options[0].range.end.line, 17_117);
  assert.equal(right.calls.at(-2)?.options[0].range.end.line, 17_299);
  h.edit(left, "prefix\n" + text);
  await h.advance();
  assert.equal(left.calls.length, 8);
  assert.equal(right.calls.length, 8);
  assert.equal(left.calls.at(-4)?.options[0].range.start.line, 2);
  assert.equal(right.calls.at(-4)?.options[0].range.start.line, 2);
});

test("saving unchanged content can refresh source hovers without clearing highlights", async t => {
  const file = createEditor();
  const h = setup(t, [file]);
  await h.advance(0);
  h.saved.fire(file.document);
  await h.advance();
  assert.equal(h.state.reads, 2, "Git context may change without changing document version");
  assert.equal(file.calls.length, 8);
  assert.equal(file.calls.at(-4)?.options.length, 1);
});
