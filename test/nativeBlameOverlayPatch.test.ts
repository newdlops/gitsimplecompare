import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { NATIVE_BLAME_PATCH_VERSION } from "../src/providers/nativeBlameOverlayRenderer";
import type { BlockBlameGutterSnapshot } from "../src/ui/blockBlameGutter";
import {
  blameOverlayCleanupExpression,
  blameOverlayInjectionExpression,
  nativeBlameOverlayRendererScript,
} from "../src/providers/nativeBlameOverlayPatch";

/** 네이티브 blame renderer 조립 테스트에 사용할 최소 snapshot. */
const SNAPSHOT: BlockBlameGutterSnapshot = {
  uri: "file:///repo/src/example.ts",
  revision: 4,
  columnWidthCh: 24,
  lines: [
    {
      line: 7,
      label: "Alice · 2026-08-23",
      tooltip: "Line 7\nAlice <alice@example.com>",
    },
  ],
};

/** 대상 VS Code 창을 고르는 테스트 workspace 힌트. */
const HINTS = {
  paths: ["/repo"],
  names: ["repo"],
};

test("blame renderer는 본문 attachment 대신 margin row에 label을 배치한다", () => {
  const script = nativeBlameOverlayRendererScript();

  assert.match(script, /\.margin-view-overlays/);
  assert.match(script, /gsc-native-blame-row/);
  assert.match(script, /rowLineNumber/);
  assert.match(script, /label\.style\.top = \(rowRect\.top - hostTop\)/);
  assert.match(script, /dom\.querySelector\('\.overflow-guard'\)/);
  assert.match(script, /lineDecorationsWidth/);
  assert.match(script, /editor\.updateOptions/);
  assert.match(script, /onDidScrollChange/);
  assert.doesNotMatch(script, /createTextEditorDecorationType/);
  assert.doesNotMatch(script, /renderOptions\s*:\s*\{\s*(?:before|after)/);
  assert.doesNotThrow(() => new Function(script));
});

test("탭 이동 뒤에는 editor service를 재사용해 heap 조회 없이 현재 URI를 바인딩한다", async () => {
  let heapQueries = 0;
  /** DOM/model 계약만 제공해 URI·가시성·focused 선택을 실제 injection에서 검사한다. */
  const editor = (uri: string, focused: boolean) => ({
    getModel: () => ({ uri: { toString: () => uri } }),
    getDomNode: () => ({ isConnected: true, offsetParent: {}, clientWidth: 1000, clientHeight: 800,
      classList: { contains: (name: string) => name === "focused" && focused } }),
    updateOptions() {}, getLayoutInfo() {},
  });
  const other = editor("file:///repo/other.ts", false), target = editor(SNAPSHOT.uri, true);
  const service = { listCodeEditors: () => [other, target] };
  const rendererWindow: any = {
    __gscNativeBlameEditor: other,
    __gscNativeBlameEditorServiceRef: new WeakRef(service),
    __gscNativeBlameOverlay: { version: NATIVE_BLAME_PATCH_VERSION, render: () => "render-scheduled:native" },
  };
  const renderer = vm.createContext({ window: rendererWindow, WeakRef });
  const debuggerApi = {
    isAttached: () => true, on() {}, removeListener() {},
    async sendCommand(method: string, params: any) {
      if (method === "Runtime.queryObjects") { heapQueries++; throw new Error("unexpected heap query"); }
      if (method === "Runtime.evaluate") return { result: { value: await vm.runInContext(params.expression, renderer) } };
      return {};
    },
  };
  const browserWindow = { id: 7, getTitle: () => "repo - Visual Studio Code", isFocused: () => true,
    webContents: { debugger: debuggerApi, getURL: () => "vscode-file://workbench.html" } };
  const context = vm.createContext({ global: {}, process: {},
    require: () => ({ BrowserWindow: { getAllWindows: () => [browserWindow] } }) });
  const result = await vm.runInContext(blameOverlayInjectionExpression(nativeBlameOverlayRendererScript(), SNAPSHOT, HINTS), context);
  assert.equal(heapQueries, 0);
  assert.equal(rendererWindow.__gscNativeBlameEditor, target);
  assert.match(result, /editor-cached:file:\/\/\/repo\/src\/example.ts/);
  assert.match(result, /discoveryMs=\d+/);
});

test("injection은 URI가 같은 Monaco editor를 찾은 뒤 거터 renderer를 실행한다", () => {
  const renderer = nativeBlameOverlayRendererScript();
  const expression = blameOverlayInjectionExpression(
    renderer,
    SNAPSHOT,
    HINTS
  );

  assert.match(expression, /Runtime\.queryObjects/);
  assert.match(expression, /getEventListeners/);
  assert.match(expression, /getRawOptions/);
  assert.match(expression, /file:\/\/\/repo\/src\/example\.ts/);
  assert.match(expression, /__gscNativeBlameOverlay\.render/);
  assert.doesNotThrow(() => new Function(`return ${expression}`));
});

test("cleanup은 renderer state를 통해 원래 거터 폭과 DOM을 함께 복원한다", () => {
  const renderer = nativeBlameOverlayRendererScript();
  const cleanup = blameOverlayCleanupExpression(HINTS);

  assert.match(
    renderer,
    /updateOptions\(\{ lineDecorationsWidth: state\.originalLineDecorationsWidth \}\)/
  );
  assert.match(cleanup, /__gscNativeBlameOverlay\.render\(null\)/);
  assert.match(cleanup, /gsc-native-blame-layer/);
  assert.match(cleanup, /gsc-native-blame-hover/);
  assert.doesNotThrow(() => new Function(`return ${cleanup}`));
});
