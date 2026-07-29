import { expect, test } from "@playwright/test";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { mountPullRequestPreview } from "../webview/webviewHarness";
for (const width of [360, 768, 1280]) test(`PR Preview ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 }); const fixture = await loadWebviewFixture("pr-preview.populated.en.json"); await mountPullRequestPreview(page, fixture);
  await expect(page.getByRole("button", { name: "Create Pull Request on GitHub" })).toBeVisible(); await expect(page.getByRole("button", { name: "Open pull request on GitHub" })).toHaveCount(0);
  await expect(page.getByText("Prepare deterministic Pull Request preview coverage")).toBeVisible(); await page.getByRole("tab", { name:/Changed files/ }).click(); await expect(page.getByText("src/previewFixture.ts")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await testInfo.attach(`pr-preview-${width}.png`, { body:await page.screenshot(), contentType:"image/png" });
});
