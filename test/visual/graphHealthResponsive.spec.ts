import { expect, test } from "@playwright/test";
import { dispatchWebviewMessage, mountGraphRenderer } from "../webview/webviewHarness";

/** 실제 Graph renderer의 손상 ref 경고를 모바일·태블릿·데스크톱 폭에서 별도 시각 검증한다. */
for (const viewport of [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
]) {
  test(`Graph ref health ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mountGraphRenderer(page);
    await dispatchWebviewMessage(page, {
      type: "graphHealth",
      notice: {
        level: "warning",
        title: "Damaged local branch refs were skipped (2).",
        detail: "The remaining graph is available. Restore or delete these refs, then refresh.",
        items: [
          { label: "broken-local", description: "refs/heads/broken-local → missing-one" },
          {
            label: "long-damaged-branch-name-that-must-stay-inside-the-viewport",
            description: "refs/heads/long-damaged-branch-name-that-must-stay-inside-the-viewport → missing-two",
          },
        ],
      },
    });
    await dispatchWebviewMessage(page, {
      type: "graph",
      data: {
        rows: [{
          hash: "healthy-commit", parents: [], refs: ["HEAD", "main"], authorName: "Fixture",
          authorEmail: "fixture@example.test", dateIso: "2026-08-28T00:00:00.000Z",
          subject: "Healthy commit remains visible", color: 0, column: 0,
        }],
        edges: [],
        laneCount: 1,
      },
      state: {
        loadedCount: 1, hasMore: false, hasMoreBefore: false,
        loading: false, reset: true, colorScope: "/fixture/repository",
      },
    });

    await expect(page.locator("#graph-health")).toBeVisible();
    await expect(page.getByText("Healthy commit remains visible", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show Git Simple Compare Output" })).toBeVisible();
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )).toBe(true);
    if (viewport.width <= 760) {
      await expect(page.locator("body")).toHaveClass(/detail-collapsed/);
      await expect.poll(() => page.locator("#detail").evaluate((element) =>
        element.getBoundingClientRect().left >= window.innerWidth
      )).toBe(true);
      await expect(page.locator("#graph-health-detail")).toHaveCSS("white-space", "normal");
    }
    const screenshotPath = testInfo.outputPath(`graph-ref-health-${viewport.width}.png`);
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach(`graph-ref-health-${viewport.width}.png`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  });
}
