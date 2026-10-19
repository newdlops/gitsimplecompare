import { test, expect, type Page } from "@playwright/test";
import vm from "node:vm";
import { blameOverlayInjectionExpression, nativeBlameOverlayRendererScript } from "../../src/providers/nativeBlameOverlayPatch";
import { mountNativeBlameFixture } from "../fixtures/webview/nativeBlameFixture";

/**
 * 제품 renderer에 실제 Chromium의 listener/closure/heap 경계를 연결한다.
 * @param page 사용자 창과 무관한 로컬 fixture 페이지
 * @param mode cold discovery가 만날 listener 소유 방식. fallback은 module만 남긴다.
 * @returns Electron main process 경계만 대체해 실행하는 실제 injection과 CDP 호출 기록
 */
async function discoveryFixture(page: Page, mode: "bound" | "closure" | "fallback") {
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
    { paths: ["/repo"], names: ["repo"] }), context) as Promise<string> };
}

for (const mode of ["bound", "closure"] as const) {
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
