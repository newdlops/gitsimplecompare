import { test, expect, type Page } from "@playwright/test";
import vm from "node:vm";
import { blameOverlayInjectionExpression, blameOverlayPreparationExpression, blameOverlayPreparationCompletionExpression, nativeBlameOverlayRendererScript } from "../../src/providers/nativeBlameOverlayPatch";
import { mountNativeBlameFixture } from "../fixtures/webview/nativeBlameFixture";

/**
 * 제품 renderer에 실제 Chromium의 listener/closure/heap 경계를 연결한다.
 * @param page 사용자 창과 무관한 로컬 fixture 페이지
 * @param mode cold discovery가 만날 listener 소유 방식. fallback은 module만 남긴다.
 * @returns Electron main process 경계만 대체해 실행하는 실제 injection과 CDP 호출 기록
 */
async function discoveryFixture(page: Page, mode: "bound" | "closure" | "arrow-this" | "service" | "fallback") {
  await page.setContent('<html lang="en"><head><title>Blame discovery fixture</title></head><body></body></html>');
  await page.evaluate(mountNativeBlameFixture);
  await page.addScriptTag({ type: "module", content: `
    const base = window.__gscNativeBlameEditor;
    class FixtureCodeEditor {
      constructor() { this._codeEditorService = {listCodeEditors: () => [this]}; }
      getModel() { return base.getModel(); }
      getDomNode() { return base.getDomNode(); }
      getRawOptions() { return base.getRawOptions(); }
      getLayoutInfo() { return base.getLayoutInfo(); }
      updateOptions(value) { return base.updateOptions(value); }
      createDecorationsCollection() { return base.createDecorationsCollection(); }
      getPosition() { return base.getPosition(); }
      onDidScrollChange(callback) { return base.onDidScrollChange(callback); }
      onDidLayoutChange(callback) { return base.onDidLayoutChange(callback); }
      onDidChangeModel(callback) { return base.onDidChangeModel(callback); }
      onDidDispose(callback) { return base.onDidDispose(callback); }
      onDidChangeCursorPosition(callback) { return base.onDidChangeCursorPosition(callback); }
    }
    const target = new FixtureCodeEditor(), root = target.getDomNode();
    window.__testTargetEditor = target;
    window.__testOriginalModelMethod = FixtureCodeEditor.prototype.getModel;
    if (${JSON.stringify(mode)} === 'bound') {
      const unrelated = {get updateOptions(){throw Error('unrelated getter');}, handle(){return 0;}};
      root.addEventListener('keydown', unrelated.handle.bind(unrelated));
      const decoy = Object.create(target);
      decoy.getModel = () => ({uri:{toString:()=>'file:///repo/other.ts'}});
      const wrongFile = {_editor:decoy, handle(){return this._editor.getPosition();}};
      root.addEventListener('keydown', wrongFile.handle.bind(wrongFile));
      const owner = {_editor:target, handle(){return this._editor.getPosition();}};
      root.addEventListener('keydown', owner.handle.bind(owner));
    } else if (${JSON.stringify(mode)} === 'closure') {
      function install() {
        const owner = {_editor:target};
        root.addEventListener('keydown', () => owner._editor.getPosition());
      }
      install();
    } else if (${JSON.stringify(mode)} === 'arrow-this') {
      class ListenerOwner {
        constructor(editor) { this._editor = editor; root.addEventListener('keydown', () => this._editor.getPosition()); }
      }
      new ListenerOwner(target);
    } else if (${JSON.stringify(mode)} === 'service') {
      const owner = {_context:{_instantiationService:{_parent:{_services:{_entries:new Map([['codeEditorService',target._codeEditorService]])}}}},
        get _editor(){throw Error('editor getters must not run during service discovery');}};
      root.addEventListener('keydown', () => owner._context);
    } else {
      root.addEventListener('keydown', () => FixtureCodeEditor);
    }
    delete window.__gscNativeBlameEditor;
    delete window.__gscNativeBlameEditorRef;
    delete window.__gscNativeBlameEditorConstructor;
    delete window.__gscNativeBlameEditorServiceRef;
    window.__testSnapshot.lines = window.__testSnapshot.lines.slice(0, 16);
    window.__testDiscoveryReady = true;
  ` });
  await page.waitForFunction(() => (window as any).__testDiscoveryReady);
  const snapshot = await page.evaluate(() => (window as any).__testSnapshot);
  const session = await page.context().newCDPSession(page);
  const calls: string[] = [];
  const debuggerApi = {
    isAttached: () => true, on() {}, removeListener() {},
    async sendCommand(method: string, params?: any) {
      calls.push(method);
      const result: any = await session.send(method as any, params);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result;
    },
  };
  const browserWindow = { id: 7, getTitle: () => "repo - Visual Studio Code", isFocused: () => true,
    webContents: { debugger: debuggerApi, getURL: () => "vscode-file://workbench.html" } };
  const context = vm.createContext({ global: {}, process: {},
    require: () => ({ BrowserWindow: { getAllWindows: () => [browserWindow] } }) });
  return { calls, run: () => vm.runInContext(blameOverlayInjectionExpression(nativeBlameOverlayRendererScript(), snapshot,
    { paths: ["/repo"], names: ["repo"] }), context) as Promise<string>,
    prepare: () => vm.runInContext(blameOverlayPreparationExpression(snapshot.uri, { paths: ["/repo"], names: ["repo"] }), context) as Promise<string>,
    complete: () => vm.runInContext(blameOverlayPreparationCompletionExpression(snapshot.uri, { paths: ["/repo"], names: ["repo"] }), context) as Promise<string> };
}

for (const mode of ["bound", "closure", "service"] as const) {
  test(`cold ${mode} listener discovery binds the visible editor without a heap query`, async ({ page }, info) => {
    const fixture = await discoveryFixture(page, mode);
    const result = await fixture.run();
    await expect(page.locator(".gsc-native-blame-row")).toHaveCount(16);
    expect(await page.evaluate(() => (window as any).__gscNativeBlameEditor === (window as any).__testTargetEditor)).toBe(true);
    expect(fixture.calls.filter(method => method === "Runtime.queryObjects")).toHaveLength(0);
    expect(result).toContain("discoverySource=listener-owner");
    expect(result).toContain("heapQueries=0");
    expect(fixture.calls.filter(method => method === "Runtime.releaseObjectGroup")).toHaveLength(1);
    await info.attach("cold-discovery", { body: result, contentType: "text/plain" });
    const before = fixture.calls.length;
    const cached = await fixture.run();
    expect(cached).toContain("editor-cached:file:///repo/example.ts");
    expect(fixture.calls.slice(before).filter(method => method === "Runtime.getProperties" || method === "Runtime.queryObjects")).toHaveLength(0);
    await expect(page.locator(".gsc-native-blame-layer")).toHaveCount(1);
    await expect(page.locator(".gsc-native-blame-row")).toHaveCount(16);
  });
}

test("opaque module listeners retain constructor discovery and release their remote objects", async ({ page }, info) => {
  const fixture = await discoveryFixture(page, "fallback");
  const result = await fixture.run();
  await info.attach("fallback-discovery", { body: JSON.stringify({ result, calls: fixture.calls }, null, 2), contentType: "application/json" });
  expect(result).toContain("editor-bound:file:///repo/example.ts");
  await expect(page.locator(".gsc-native-blame-row")).toHaveCount(16);
  expect(result).toContain("discoverySource=heap");
  expect(fixture.calls.filter(method => method === "Runtime.queryObjects")).toHaveLength(1);
  expect(fixture.calls.filter(method => method === "Runtime.releaseObjectGroup")).toHaveLength(1);
});

for (const mode of ["fallback", "arrow-this"] as const) test(`preparing ${mode} captures a normal editor read without heap, gutter or width changes`, async ({ page }, info) => {
  const fixture = await discoveryFixture(page, mode);
  const width = await page.evaluate(() => (window as any).__testTargetEditor.getRawOptions().lineDecorationsWidth);
  const prepared = await fixture.prepare();
  expect(prepared).toContain("blame-editor-observing"); expect(prepared).toContain("heapQueries=0");
  await expect(page.locator(".gsc-native-blame-row,.gsc-native-blame-layer")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__testTargetEditor.getRawOptions().lineDecorationsWidth)).toBe(width);
  expect(await page.evaluate(() => !!(window as any).__gscNativeBlameEditor)).toBe(false);
  expect(await page.evaluate(() => (window as any).__testTargetEditor.getModel === (window as any).__testOriginalModelMethod)).toBe(false);
  await page.evaluate(() => (window as any).__testTargetEditor.getModel());
  expect(await fixture.complete()).toContain("blame-editor-prepared");
  expect(await page.evaluate(() => (window as any).__testTargetEditor.getModel === (window as any).__testOriginalModelMethod)).toBe(true);
  expect(await page.evaluate(() => !!(window as any).__gscNativeBlameEditorCapture || !!(window as any).__gscNativeBlameEditor)).toBe(false);
  const before = fixture.calls.length, startedAt = performance.now();
  const displayed = await fixture.run(), clickMs = performance.now() - startedAt;
  expect(fixture.calls.slice(before).filter(method => method === "Runtime.queryObjects" || method === "Runtime.getProperties")).toHaveLength(0);
  await expect(page.locator(".gsc-native-blame-row")).toHaveCount(16);
  await expect(page.locator(".gsc-native-blame-layer")).toHaveCount(1);
  await info.attach("first-click-after-preparation", { body: JSON.stringify({ prepared, displayed, clickMs }), contentType: "application/json" });
  expect(clickMs).toBeLessThan(500);
});

test("an unused editor observer restores its methods after its bounded deadline", async ({ page }) => {
  const fixture = await discoveryFixture(page, "fallback");
  expect(await fixture.prepare()).toContain("blame-editor-observing");
  await page.waitForFunction(() => !(window as any).__gscNativeBlameEditorCapture);
  expect(await page.evaluate(() => (window as any).__testTargetEditor.getModel === (window as any).__testOriginalModelMethod)).toBe(true);
  expect(await fixture.complete()).toContain("blame-editor-not-observed");
  await expect(page.locator(".gsc-native-blame-layer")).toHaveCount(0);
});

test("cancelling an editor observer restores its methods without retaining a capture", async ({ page }) => {
  const fixture = await discoveryFixture(page, "fallback");
  expect(await fixture.prepare()).toContain("blame-editor-observing");
  await page.evaluate(() => (window as any).__gscNativeBlameEditorCapture.cancel());
  expect(await page.evaluate(() => (window as any).__testTargetEditor.getModel === (window as any).__testOriginalModelMethod)).toBe(true);
  expect(await page.evaluate(() => !!(window as any).__gscNativeBlameEditorCapture)).toBe(false);
  expect(await fixture.complete()).toContain("blame-editor-not-observed");
  await expect(page.locator(".gsc-native-blame-layer")).toHaveCount(0);
});

test("observer preserves method receivers, arguments, return values and thrown errors", async ({ page }) => {
  const fixture = await discoveryFixture(page, "fallback");
  await page.evaluate(() => {
    const state = window as any, target = state.__testTargetEditor, prototype = Object.getPrototypeOf(target);
    state.__captureCalls = []; state.__captureError = new Error("original error"); state.__captureModel = target.getModel();
    prototype.getModel = function (...args: unknown[]) {
      state.__captureCalls.push({ correctReceiver: this === target, args });
      if (args[0] === "fail") throw state.__captureError;
      return state.__captureModel;
    };
    state.__testOriginalModelMethod = prototype.getModel;
  });
  expect(await fixture.prepare()).toContain("blame-editor-observing");
  expect(await page.evaluate(() => {
    const state = window as any;
    try { state.__testTargetEditor.getModel("fail"); } catch (error) { return error === state.__captureError; }
    return false;
  })).toBe(true);
  expect(await page.evaluate(() => (window as any).__testTargetEditor.getModel("okay") === (window as any).__captureModel)).toBe(true);
  expect(await fixture.complete()).toContain("blame-editor-prepared");
  expect(await page.evaluate(() => (window as any).__captureCalls.slice(0, 2))).toEqual([
    { correctReceiver: true, args: ["fail"] }, { correctReceiver: true, args: ["okay"] },
  ]);
  expect(await page.evaluate(() => (window as any).__testTargetEditor.getModel === (window as any).__testOriginalModelMethod)).toBe(true);
});

test("nonconfigurable editor methods retain the legacy preparation fallback", async ({ page }) => {
  const fixture = await discoveryFixture(page, "fallback");
  await page.evaluate(() => {
    const prototype = Object.getPrototypeOf((window as any).__testTargetEditor);
    for (const name of ["getModel", "getDomNode", "getLayoutInfo"]) Object.defineProperty(prototype, name, { configurable: false });
  });
  const result = await fixture.prepare();
  expect(result).toContain("blame-editor-prepared"); expect(result).toContain("heapQueries=1");
  expect(await page.evaluate(() => !!(window as any).__gscNativeBlameEditorCapture)).toBe(false);
  await expect(page.locator(".gsc-native-blame-layer")).toHaveCount(0);
});

test("an editor without WeakRef retains its compatible cached-reference path", async ({ page }) => {
  const fixture = await discoveryFixture(page, "fallback");
  await page.evaluate(() => { (window as any).WeakRef = undefined; });
  expect(await fixture.prepare()).toContain("blame-editor-observing");
  await page.evaluate(() => (window as any).__testTargetEditor.getModel());
  expect(await fixture.complete()).toContain("blame-editor-prepared");
  expect(await fixture.run()).toContain("editor-cached:");
  await expect(page.locator(".gsc-native-blame-layer")).toHaveCount(1);
});
