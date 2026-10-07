import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type * as vscode from "vscode";
import { commands, window, workspace, SymbolKind } from "./helpers/vscodeMock";
import { BlockBlameCodeLensController } from "../src/providers/blockBlameCodeLensController";
import { GitBlameService } from "../src/git/blameService";
import type { GitServiceRegistry } from "../src/git/serviceRegistry";

/** 언어 서버의 준비 시점과 timer만 대체하며 실제 심볼 변환·snapshot 캐시·CodeLens를 실행한다. */
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_700_000_000_000 });
  const oldState = window.state, oldEditor = window.activeTextEditor;
  t.after(() => { window.state = oldState; window.activeTextEditor = oldEditor; });
  t.mock.method(workspace, "getConfiguration", () => ({ get: (_key: string, fallback: unknown) => fallback }));
  const text = ["export function example() {", "  const value = 1;", "  return value;", "}"];
  const document = { version: 1, isDirty: false, lineCount: text.length,
    uri: { scheme: "file", fsPath: "/repo/example.ts", toString: () => "file:///repo/example.ts" },
    lineAt: (line: number) => ({ text: text[line] }) } as vscode.TextDocument;
  window.state = { focused: true }; window.activeTextEditor = { document };
  let ready = false, repository = true, symbols = 0, gitReads = 0, changes = 0;
  const range = { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } };
  t.mock.method(commands, "executeCommand", async () => {
    symbols++;
    return ready ? [{ name: "example", kind: SymbolKind.Function, range, selectionRange: range, children: [] }] : undefined;
  });
  const service = { repoRoot: "/repo", toRepoRelative: () => "example.ts" };
  const registry = { resolve: async () => repository ? service : undefined } as unknown as GitServiceRegistry;
  t.mock.method(GitBlameService.prototype, "getFileBlame", async () => {
    gitReads++;
    return text.map((content, index) => ({ line: index + 1, commit: "a".repeat(40), authorName: "Author", authorMail: "author@example.test", authorTime: 1700000000, summary: "example", filename: "example.ts", content }));
  });
  const controller = new BlockBlameCodeLensController(registry);
  t.after(() => controller.dispose());
  t.mock.method((controller as any).changeEmitter, "fire", () => { changes++; });
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as vscode.CancellationToken;
  return { controller, document, read: () => controller.provideCodeLenses(document, token),
    ready: () => { ready = true; }, repository: (value: boolean) => { repository = value; },
    counts: () => ({ symbols, gitReads, changes }) };
}

test("initially missing language symbols are retried quickly and the first available block becomes a CodeLens", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.read(), []);
  assert.deepEqual(f.counts(), { symbols: 1, gitReads: 0, changes: 0 });
  f.ready(); t.mock.timers.tick(250);
  assert.equal(f.counts().changes, 1);
  const lenses = await f.read();
  assert.equal(lenses.length, 1);
  assert.match(lenses[0].command!.title, /Author/);
  assert.equal(f.counts().gitReads, 1);
  t.mock.timers.tick(60_000);
  assert.equal(f.counts().changes, 1, "success must stop symbol retry timers");
});

test("documents without symbols retry at most three times and never execute Git blame", async t => {
  const f = fixture(t);
  await f.read();
  for (const delay of [250, 750, 1500]) { t.mock.timers.tick(delay); await f.read(); }
  assert.deepEqual(f.counts(), { symbols: 4, gitReads: 0, changes: 3 });
  t.mock.timers.tick(60_000);
  assert.deepEqual(f.counts(), { symbols: 4, gitReads: 0, changes: 3 });
});

test("losing focus prevents pending symbol retries from requesting background CodeLens work", async t => {
  const f = fixture(t); await f.read();
  window.state = { focused: false };
  t.mock.timers.tick(60_000);
  assert.deepEqual(f.counts(), { symbols: 1, gitReads: 0, changes: 0 });
});

test("an unavailable repository is cached briefly and recovers without the old 60-second wait", async t => {
  const f = fixture(t); f.ready(); f.repository(false);
  assert.deepEqual(await f.read(), []);
  f.repository(true); t.mock.timers.tick(499);
  assert.deepEqual(await f.read(), []);
  assert.equal(f.counts().symbols, 1);
  t.mock.timers.tick(1);
  assert.equal((await f.read()).length, 1);
  assert.equal(f.counts().gitReads, 1);
});
