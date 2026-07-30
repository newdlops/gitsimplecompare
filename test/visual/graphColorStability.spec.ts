import { expect, test } from "@playwright/test";
import { dispatchWebviewMessage, mountGraphRenderer } from "../webview/webviewHarness";

/** 실제 Graph renderer의 좁은 폭과 넓은 폭에서 고정 색상과 내부 스크롤 경계를 시각 검증한다. */
for (const viewport of [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
]) {
  test(`Graph stable colors ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mountGraphRenderer(page);
    const graph = (color: number) => ({
      type: "graph",
      data: {
        rows: [{
          hash: "commit-a", parents: [], refs: ["main"], authorName: "Fixture",
          authorEmail: "fixture@example.test", dateIso: "2026-07-30T12:00:00.000Z",
          subject: "Stable color across graph refreshes", color, column: 0,
        }],
        edges: [],
        laneCount: 1,
      },
      state: {
        loadedCount: 1, hasMore: false, hasMoreBefore: false,
        loading: false, reset: color === 0, colorScope: "/fixture/repository",
      },
    });
    await dispatchWebviewMessage(page, graph(0));
    const initial = await page.locator('.node[data-hash="commit-a"]').getAttribute("fill");
    await dispatchWebviewMessage(page, graph(11));

    await expect(page.locator('.node[data-hash="commit-a"]')).toHaveAttribute("fill", initial || "");
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )).toBe(true);
    if (viewport.width <= 760) {
      await expect(page.locator("body")).toHaveClass(/detail-collapsed/);
      await expect.poll(() => page.locator("#detail").evaluate((element) =>
        element.getBoundingClientRect().left >= window.innerWidth
      )).toBe(true);
    } else {
      await expect(page.locator("#detail")).toBeVisible();
    }
    await testInfo.attach(`graph-stable-colors-${viewport.width}.png`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
}
