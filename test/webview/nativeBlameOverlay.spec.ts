import { test, expect, type Page } from "@playwright/test";
import { nativeBlameOverlayRendererScript } from "../../src/providers/nativeBlameOverlayRenderer";

const COMMIT = "abcdef1234".repeat(4);

/** 실제 renderer/CSS를 Chromium에 설치하고 Monaco의 문서·거터·이벤트 경계만 재현한다. */
async function mount(page: Page) {
  await page.setContent(`<style>
    html,body{margin:0;background:#1e1e1e;--vscode-editorGutter-background:#1e1e1e;--vscode-editorCodeLens-foreground:#999;
      --vscode-editor-foreground:#ddd;--vscode-foreground:#ddd;--vscode-editorHoverWidget-background:#252526;
      --vscode-editorHoverWidget-foreground:#ddd;--vscode-editorHoverWidget-border:#454545;--vscode-focusBorder:#007fd4;
      --vscode-font-family:Arial,sans-serif;--vscode-font-size:13px;--vscode-widget-shadow:#0006;}
    .monaco-editor{position:relative;height:500px;width:100%;font:14px monospace;color:#ddd;}
    .overflow-guard{position:relative;height:100%;overflow:hidden;}
    .margin-view-overlays{position:absolute;inset:0 auto 0 0;width:70px;}
    .margin-view-overlays>div{position:absolute;left:0;width:70px;height:24px;}
    .line-numbers{padding-left:20px;}
    .view-lines{position:absolute;top:0;right:0;left:70px;}
    .view-line{position:absolute;height:24px;}
  </style><div class="monaco-workbench"><div class="monaco-editor" tabindex="0"><div class="overflow-guard">
    <div class="margin-view-overlays"></div><div class="view-lines"></div>
  </div></div></div>`);
  await page.evaluate(({ commit }) => {
    const root = document.querySelector<HTMLElement>(".monaco-editor")!;
    const margin = root.querySelector(".margin-view-overlays")!;
    const code = root.querySelector<HTMLElement>(".view-lines")!;
    for (let index = 1; index <= 12; index++) {
      const row = document.createElement("div"); row.style.top = `${index * 24}px`;
      row.innerHTML = `<span class="line-numbers" data-line-number="${index}">${index}</span>`; margin.appendChild(row);
      const source = document.createElement("div"); source.className = "view-line"; source.style.top = row.style.top;
      source.textContent = `const line${index} = ${index};`; code.appendChild(source);
    }
    const listeners = new Map<string, () => void>();
    let extraWidth = 0;
    const editor: any = { getModel: () => ({ uri: { toString: () => "file:///repo/example.ts" } }),
      getDomNode: () => root, getRawOptions: () => ({ lineDecorationsWidth: 10 }),
      getLayoutInfo: () => ({ contentLeft: 70 + extraWidth }),
      updateOptions: (options: any) => { extraWidth = options.lineDecorationsWidth - 10; code.style.left = `${70 + extraWidth}px`; } };
    for (const name of ["onDidScrollChange", "onDidLayoutChange", "onDidChangeModel", "onDidDispose"]) {
      editor[name] = (callback: () => void) => { listeners.set(name, callback); return { dispose: () => listeners.delete(name) }; };
    }
    // Monaco가 거터 클릭 뒤 본문 focus를 가져가는 동작도 실제 DOM focus/blur로 재현한다.
    root.addEventListener("mousedown", event => { event.preventDefault(); root.focus(); });
    window.addEventListener("resize", () => listeners.get("onDidLayoutChange")?.());
    Object.assign(window, { __gscNativeBlameEditor: editor, __testEditorEvents: listeners,
      __testSnapshot: { uri: "file:///repo/example.ts", revision: 1, columnWidthCh: 31,
        lines: Array.from({ length: 50_000 }, (_, index) => ({ line: index + 1, label: "작성자 · 2026-10-07",
          tooltip: `Line ${index + 1}\nAuthor <author@example.invalid>\n${commit} · 2026-10-07\n${"A long message <script> is plain text. ".repeat(12)}` })) } });
  }, { commit: COMMIT });
  await page.addScriptTag({ content: nativeBlameOverlayRendererScript() });
  await page.evaluate(() => (window as any).__gscNativeBlameOverlay.render((window as any).__testSnapshot));
  await expect(page.locator(".gsc-native-blame-row")).toHaveCount(12);
}

for (const width of [1440, 768, 520]) {
  test(`native blame hover, click and Escape use real browser events at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 700 }); await mount(page);
    const row = page.locator('[data-gsc-line="3"]'), tooltip = page.getByRole("tooltip");
    await row.hover(); await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText(COMMIT);
    await expect(tooltip).toContainText("<script>");
    await expect(tooltip.locator("script")).toHaveCount(0);
    await row.click(); await expect(tooltip).toBeVisible();
    const bounds = await tooltip.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(8); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 7);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(693);
    await page.screenshot({ path: info.outputPath(`hover-${width}.png`) });
    await page.keyboard.press("Escape"); await expect(tooltip).toHaveCount(0);
    await page.mouse.move(width - 10, 600); await row.focus(); await expect(tooltip).toBeVisible();
    await expect(row).toHaveAttribute("aria-describedby", "gsc-native-blame-hover");
    await page.keyboard.press("Escape"); await expect(tooltip).toHaveCount(0);
  });
}

test("repaints keep hovered rows while viewport changes remove stale hover and restore width on cleanup", async ({ page }) => {
  await mount(page);
  const row = page.locator('[data-gsc-line="3"]'); await row.hover();
  await row.evaluate(element => { (window as any).__firstBlameRow = element; });
  await page.waitForTimeout(900);
  expect(await row.evaluate(element => element === (window as any).__firstBlameRow)).toBe(true);
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.evaluate(() => {
    document.querySelector('.line-numbers[data-line-number="3"]')!.setAttribute("data-line-number", "1000");
    (window as any).__testEditorEvents.get("onDidScrollChange")();
  });
  await expect(row).toHaveCount(0);
  // 같은 화면 좌표의 새 라인에 pointerenter가 발생해도 이전 라인의 tooltip은 남기지 않는다.
  const visibleTooltip = page.getByRole("tooltip");
  if (await visibleTooltip.count()) await expect(visibleTooltip).toContainText("Line 1000\n");
  await expect(page.locator('[data-gsc-line="1000"]')).toHaveCount(1);
  await page.evaluate(() => (window as any).__gscNativeBlameOverlay.render(null));
  await expect(page.locator(".gsc-native-blame-layer")).toHaveCount(0);
  expect(await page.locator(".view-lines").evaluate(element => getComputedStyle(element).left)).toBe("70px");
});

test("resizing a wide editor shrinks the blame column without a new Git snapshot", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 }); await mount(page);
  const previous = await page.locator(".gsc-native-blame-layer").evaluate(element => element.getBoundingClientRect().width);
  await page.setViewportSize({ width: 520, height: 700 });
  await expect.poll(() => page.locator(".gsc-native-blame-layer").evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(previous);
  const width = await page.locator(".gsc-native-blame-layer").evaluate(element => element.getBoundingClientRect().width);
  expect(width).toBeLessThanOrEqual(520 * 0.42);
  await expect(page.locator(".gsc-native-blame-row")).toHaveCount(12);
});
