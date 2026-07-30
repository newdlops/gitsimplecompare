import { expect, test } from "@playwright/test";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { mountPullRequestPreview } from "../webview/webviewHarness";
for (const width of [390, 768, 1440]) test(`PR Preview ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 }); const fixture = await loadWebviewFixture("pr-preview.populated.en.json"); await mountPullRequestPreview(page, fixture);
  await expect(page.getByRole("button", { name: "Create Pull Request on GitHub" })).toBeVisible(); await expect(page.getByRole("button", { name: "Open pull request on GitHub" })).toHaveCount(0);
  await expect(page.getByText("Prepare deterministic Pull Request preview coverage")).toBeVisible(); const splitter = page.getByRole("separator", { name: "Resize changed files inspector" }); if (width >= 900) await expect(splitter).toBeVisible(); else await expect(splitter).toBeHidden();
  await testInfo.attach(`pr-preview-conversation-${width}.png`, { body:await page.screenshot(), contentType:"image/png" });
  if (width === 1440) {
    await splitter.focus(); await page.keyboard.press("ArrowLeft");
    await testInfo.attach("pr-preview-conversation-resized-1440.png", { body:await page.screenshot(), contentType:"image/png" });
    expect(await page.evaluate(() => {
      const shell = document.querySelector(".pr-page");
      const prose = document.querySelector(".markdown-body > p, .preview-conversation-item__body > p");
      if (!shell || !prose) return false;
      const proseMeasure = parseFloat(getComputedStyle(prose).maxInlineSize);
      return shell.getBoundingClientRect().width > 1080 && Number.isFinite(proseMeasure) && proseMeasure <= 900 && prose.getBoundingClientRect().width <= proseMeasure + 1;
    })).toBe(true);
  }
  await page.getByRole("tab", { name:/Changed files/ }).click(); await expect(page.getByText("src/previewFixture.ts")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await testInfo.attach(`pr-preview-${width}.png`, { body:await page.screenshot(), contentType:"image/png" });
});
