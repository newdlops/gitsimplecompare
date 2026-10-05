import { expect, test, type Page } from "@playwright/test";
import { dispatchWebviewMessage, mountGraphRenderer } from "./webviewHarness";

const ROWS = 2000;

/** 선형 이력 graph payload 를 page 안에서 만들어 렌더한다(긴 제목 행 하나 포함). */
async function renderLinearGraph(page: Page): Promise<void> {
  await page.evaluate((count) => {
    const rows = Array.from({ length: count }, (_, index) => ({
      hash: `h${index}`,
      parents: index + 1 < count ? [`h${index + 1}`] : [],
      refs: index === 0 ? ["HEAD", "main"] : [],
      authorName: "Fixture",
      authorEmail: "fixture@example.test",
      dateIso: "2026-09-04T00:00:00.000Z",
      subject: index === 1500 ? "long subject ".repeat(80) : `commit ${index}`,
      color: 0,
      column: 0,
    }));
    const edges = rows.slice(0, -1).map((_, index) => ({
      fromRow: index, toRow: index + 1, column: 0, fromColumn: 0, toColumn: 0, color: 0,
    }));
    window.dispatchEvent(new MessageEvent("message", { data: {
      type: "graph",
      data: { rows, edges, laneCount: 1 },
      state: { loadedCount: count, hasMore: false, hasMoreBefore: false, loading: false, reset: true, colorScope: "/fixture" },
    } }));
  }, ROWS);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("branch/tag status updates keep unchanged graph rows and replace only rows whose display changed", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await mountGraphRenderer(page);
  await renderLinearGraph(page);
  await expect(page.locator("#graph-content > .row")).toHaveCount(ROWS);

  await page.evaluate(() => {
    const w = window as any;
    w.__keep = document.querySelector('#graph-content > .row[data-hash="h1000"]');
    w.__old = document.querySelector('#graph-content > .row[data-hash="h5"]');
  });
  await page.locator('#graph-content > .row[data-hash="h5"]').click();
  await dispatchWebviewMessage(page, { type: "branchStatus", branches: [], worktrees: [] });
  await dispatchWebviewMessage(page, { type: "tagStatus", tags: [] });

  const identity = await page.evaluate(() => {
    const w = window as any;
    return {
      kept: document.querySelector('#graph-content > .row[data-hash="h1000"]') === w.__keep,
      selectedReplaced: document.querySelector('#graph-content > .row[data-hash="h5"]') !== w.__old,
      rows: document.querySelectorAll("#graph-content > .row").length,
    };
  });
  expect(identity).toEqual({ kept: true, selectedReplaced: false, rows: ROWS });
  await expect(page.locator('#graph-content > .row[data-hash="h5"]')).toHaveClass(/selected/);
});

test("graph canvas widens to the longest row after the next frame without measuring every row", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await mountGraphRenderer(page);
  await renderLinearGraph(page);
  const width = await page.evaluate(() => parseFloat(document.getElementById("graph-content")!.style.width));
  const longRowWidth = await page.evaluate(() => {
    const row = document.querySelector('#graph-content > .row[data-hash="h1500"]') as HTMLElement;
    return row.offsetLeft + row.scrollWidth;
  });
  expect(width).toBeGreaterThanOrEqual(longRowWidth);
});
