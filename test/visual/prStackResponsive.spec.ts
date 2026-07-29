import { expect, test } from "@playwright/test";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { mountPullRequestStackGraph } from "../webview/webviewHarness";

/** production Stack detail을 세 목표 viewport에서 screenshot과 overflow 검사로 분리 검증한다. */
for (const viewport of [{ width:390, height:844 }, { width:768, height:1024 }, { width:1440, height:900 }]) {
  test(`PR Stack ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    const fixture = await loadWebviewFixture<any>("pr-stack.local-parent.en.json");
    await page.setViewportSize(viewport);
    await mountPullRequestStackGraph(page, fixture.payload);
    const layerChip = page.locator("[data-stack-branch]");
    await expect(layerChip).toHaveCount(1);
    await layerChip.dispatchEvent("click");
    await expect(page.getByText("Local and published parents differ.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Edit local Stack parent/ })).toBeVisible();
    expect(await page.locator("#detail").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await testInfo.attach(`pr-stack-${viewport.width}.png`, { body: await page.screenshot(), contentType:"image/png" });
  });
}
