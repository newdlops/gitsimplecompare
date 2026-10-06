import { expect, test, type Page } from "@playwright/test";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { mountChanges } from "./webviewHarness";

/**
 * 메뉴의 실제 위치와 키보드 tooltip 사이 간격을 검사해 배치 전 focus 회귀를 잡는다.
 * @param page production renderer를 마운트한 브라우저 page. 현재 focus된 menuitem을 기준으로 삼는다.
 * @returns tooltip 문구와 간격이 맞으면 완료하고, 어긋나면 assertion으로 검사를 실패시킨다.
 */
async function expectTooltipAtFocusedItem(page: Page): Promise<void> {
  const item = page.locator('.menu [role="menuitem"]:focus');
  const tooltip = page.locator(".gsc-instant-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(await item.getAttribute("aria-label") || "");
  await expect.poll(async () => {
    const target = await item.boundingBox(), tip = await tooltip.boundingBox();
    if (!target || !tip) return Number.POSITIVE_INFINITY;
    return Math.min(Math.abs(tip.y - target.y - target.height), Math.abs(target.y - tip.y - tip.height));
  }).toBeLessThanOrEqual(8);
}

for (const width of [390, 768, 1440]) for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`Changes menu places root and submenu before keyboard focus at ${width}px (${reducedMotion})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion });
    await mountChanges(page, await loadWebviewFixture("changes.small.en.json"));
    await page.addStyleTag({ content: ":root{--vscode-font-family:sans-serif;--vscode-font-size:13px}" });
    // production renderer가 읽은 배열에 fixture 메뉴를 넣어 실제 drill-down 경로를 조작한다.
    await page.evaluate(() => {
      (window as any).__gscCommitMenu.push({ label: "Commit variants", submenu: [{ id: "commitAmend", label: "Amend commit" }] });
    });
    await page.mouse.move(1, 1);
    const caret = page.locator("#commit-caret");
    await caret.focus(); await page.keyboard.press("Enter");
    await expectTooltipAtFocusedItem(page);
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("menuitem", { name: "Amend commit", exact: true })).toBeVisible();
    await expectTooltipAtFocusedItem(page);
    await page.keyboard.press("ArrowLeft");
    await expectTooltipAtFocusedItem(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".menu")).toHaveCount(0); await expect(caret).toBeFocused();
  });
}
