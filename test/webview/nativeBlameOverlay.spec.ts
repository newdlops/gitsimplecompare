import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { nativeBlameOverlayRendererScript } from "../../src/providers/nativeBlameOverlayRenderer";
import { mountNativeBlameFixture, type NativeBlameFixtureOptions } from "../fixtures/webview/nativeBlameFixture";

const COMMIT = "abcdef1234".repeat(4);
const codiconCss = readFileSync("media/codicons/codicon.css", "utf8");
const fontUrl = "data:font/ttf;base64," + readFileSync("media/codicons/codicon.ttf").toString("base64");

/** 실제 renderer·Codicon·CSS를 설치한다. 파일 blame/host 통신 경계만 공통 fixture로 재현한다. */
async function mount(page: Page, options: NativeBlameFixtureOptions = {}) {
  await page.setContent('<html lang="en"><head></head><body></body></html>');
  await page.evaluate(mountNativeBlameFixture, { ...options, codiconCss, fontUrl });
  await page.addScriptTag({ content: nativeBlameOverlayRendererScript() });
  await page.evaluate(() => (window as any).__gscNativeBlameOverlay.render((window as any).__testSnapshot));
  await expect(page.locator(".gsc-native-blame-row")).toHaveCount(16);
  await page.evaluate(() => document.fonts.ready);
}

for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
  for (const theme of ["dark", "light", "contrast"] as const) {
    test(`commit information and actions remain usable at ${width}px in ${theme}`, async ({ page }, info) => {
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.setViewportSize({ width, height }); await mount(page, { theme });
      const row = page.locator('[data-gsc-line="3"]'), popup = page.getByRole("dialog", { name: "Commit details" });
      await row.hover(); await expect(popup).toBeVisible();
      await expect(popup).toContainText("minsu@example.invalid");
      await expect(popup).toContainText("Preserve the commit message body");
      await expect(popup).toContainText("Alex Park"); await expect(popup).toContainText("Co-author");
      await expect(popup).toContainText("4 files changed");
      await expect(popup.locator(".gsc-blame-insertions")).toHaveText("+42");
      await expect(popup.locator(".gsc-blame-deletions")).toHaveText("−7");
      await expect(popup.locator("script")).toHaveCount(0);
      await expect(popup.getByRole("button", { name: /^Open Commit Changes/ })).toHaveAttribute("title", new RegExp(COMMIT));
      const bounds = await popup.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(8); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 7);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height - 7);
      await popup.getByRole("button", { name: "Copy Commit Hash" }).click();
      await expect(popup).toContainText("Commit hash copied");
      await popup.getByRole("button", { name: /^Open Commit Changes/ }).click();
      await popup.getByRole("button", { name: "Open Commit in Browser" }).click();
      await popup.getByRole("button", { name: "Open Blame Settings" }).click();
      const actions = await page.evaluate(() => (window as any).__testRequests);
      for (const action of ["copyHash", "openCommit", "openRemote", "settings"]) {
        expect(actions.find((request: any) => request.action === action)?.commit).toBe(COMMIT);
      }
      await page.screenshot({ path: info.outputPath(`commit-${theme}-${width}.png`) });
      await page.keyboard.press("Escape"); await expect(popup).toHaveCount(0);
      await expect(row).toBeFocused();
      expect(errors).toEqual([]);
    });
  }
}

test("loading and retry preserve the original identity, copy action and keyboard focus", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await mount(page, { mode: "error", delayMs: 120 });
  const row = page.locator('[data-gsc-line="3"]'), popup = page.getByRole("dialog");
  await row.focus(); await expect(popup).toContainText("Loading commit details…");
  await page.keyboard.press("Tab"); await expect(popup.getByRole("button", { name: /^Open Commit Changes/ })).toBeFocused();
  await expect(popup).toContainText("Could not load commit details.");
  await expect(popup).toContainText("minsu@example.invalid");
  await popup.getByRole("button", { name: "Copy Commit Hash" }).click(); await expect(popup).toContainText("Commit hash copied");
  await page.screenshot({ path: info.outputPath("error-390.png") });
  await popup.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(popup).toContainText("4 files changed");
  await expect(popup.getByRole("button", { name: "Retry", exact: true })).toBeHidden();
  await page.keyboard.press("Escape"); await expect(popup).toHaveCount(0);
});

test("uncommitted and empty commits show their actual states without fabricated commit actions", async ({ page }, info) => {
  await mount(page, { mode: "working" }); await page.locator('[data-gsc-line="3"]').hover();
  const popup = page.getByRole("dialog"); await expect(popup).toContainText("Changes on this line have not been committed.");
  await expect(popup.getByRole("button", { name: "Copy Commit Hash" })).toBeHidden();
  expect(await page.evaluate(() => (window as any).__testRequests.filter((r: any) => r.action === "load").length)).toBe(0);
  await page.screenshot({ path: info.outputPath("working-tree.png") });
  await mount(page, { mode: "empty" }); await page.locator('[data-gsc-line="3"]').hover();
  await expect(popup).toContainText("No file changes");
  await expect(popup.getByRole("button", { name: /^Open Commit Changes/ })).toBeDisabled();
});

test("long Korean identity and complete messages scroll inside the popup while actions stay visible", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await mount(page, { longText: true, locale: "ko" });
  await page.locator('[data-gsc-line="16"]').hover();
  const popup = page.getByRole("dialog", { name: "커밋 상세" }); await expect(popup).toContainText("파일 4개 변경");
  await expect(popup.locator(".gsc-blame-message")).toContainText("한국어");
  const scroll = popup.locator(".gsc-blame-scroll");
  expect(await scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(popup.getByRole("button", { name: "커밋 해시 복사" })).toBeVisible();
  const bounds = await popup.boundingBox(); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(383);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(837);
  expect(await popup.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("long-ko-390.png") });
});

test("repaints and host responses retain focused buttons, while scrolling rejects stale details", async ({ page }) => {
  await mount(page, { mode: "loading" });
  const row = page.locator('[data-gsc-line="3"]'); await row.focus(); await page.keyboard.press("Tab");
  const open = page.getByRole("dialog").getByRole("button", { name: /^Open Commit Changes/ }); await expect(open).toBeFocused();
  await page.evaluate(() => { const w = window as any; w.__testRespond(w.__testRequests.find((r: any) => r.action === "load")); });
  await expect(open).toBeFocused(); await expect(page.getByRole("dialog")).toContainText("4 files changed");
  await row.evaluate(element => { (window as any).__firstBlameRow = element; });
  await page.waitForTimeout(900);
  expect(await row.evaluate(element => element === (window as any).__firstBlameRow)).toBe(true);
  await page.evaluate(() => {
    document.querySelector('.line-numbers[data-line-number="3"]')!.setAttribute("data-line-number", "1000");
    (window as any).__testEditorEvents.get("onDidScrollChange")();
  });
  await expect(row).toHaveCount(0);
  await page.evaluate(() => { const w = window as any; w.__testRespond(w.__testRequests.find((r: any) => r.action === "load")); });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => (window as any).__gscNativeBlameOverlay.render(null));
  await expect(page.locator(".gsc-native-blame-layer")).toHaveCount(0);
  expect(await page.locator(".view-lines").evaluate(element => getComputedStyle(element).left)).toBe("70px");
});

test("resizing an editor updates the gutter width without another file snapshot", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await mount(page);
  const previous = await page.locator(".gsc-native-blame-layer").evaluate(element => element.getBoundingClientRect().width);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator(".gsc-native-blame-layer").evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(previous);
  expect(await page.locator(".gsc-native-blame-layer").evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(390 * 0.42);
  await expect(page.locator(".gsc-native-blame-row")).toHaveCount(16);
});
