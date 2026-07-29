import { expect, test } from "@playwright/test";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { mountChanges } from "../webview/webviewHarness";
test("Changes representative surface", async ({ page }, testInfo) => {
  const fixture = await loadWebviewFixture("changes.small.en.json"); await page.setViewportSize(fixture.viewport); await mountChanges(page, fixture);
  await expect(page.locator("#root")).toBeVisible();
  await expect(page.locator('.section[data-section="changes"] #changes-group-files-staged .row.file[data-path="src/app.ts"]')).toBeVisible();
  await expect(page.locator("#commit-msg")).toBeVisible();
  expect(await page.locator("#root").evaluate((element:any) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await testInfo.attach("changes-representative.png", { body:await page.screenshot(), contentType:"image/png" });
});
