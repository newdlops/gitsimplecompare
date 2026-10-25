import { expect, test } from "@playwright/test";
import { mountReferenceGraph } from "./graphReferenceHarness";

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`large graph paints and selects distant rows after horizontal scrolling at ${width}px`, async ({ page }, info) => {
    test.setTimeout(60_000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await mountReferenceGraph(page, true, 1);
    await page.keyboard.press("Escape");
    await page.evaluate(async () => {
      const root = document.getElementById("graph-content")!;
      // 폭 후보보다 짧은 원거리 행도 가로 스크롤된 viewport에서 텍스트와 클릭 영역을 유지해야 한다.
      for (let index = 0; index < 30; index++) root.querySelector(`.row[data-index="${index}"] .subject`)!.textContent = "Wide measured subject ".repeat(60);
      for (let index = 3000; index < 3010; index++) root.querySelector(`.row[data-index="${index}"] .subject`)!.textContent = "Distant visible subject ".repeat(40);
      window.dispatchEvent(new Event("resize"));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const graph = document.getElementById("graph")!;
      graph.scrollTop = 3000 * 30; graph.scrollLeft = 1000;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const graph = page.locator("#graph"), box = await graph.boundingBox();
    expect(box).not.toBeNull();
    // locator의 자동 scrollIntoView를 쓰지 않고 현재 보이는 텍스트 위치를 직접 클릭한다.
    await page.mouse.click(box!.x + Math.min(150, box!.width / 2), box!.y + 45);
    await expect(page.locator('#graph-content > .row.selected[data-index="3001"]')).toHaveCount(1);
    await page.keyboard.press("Escape");
    const selected = await page.locator('#graph-content > .row[data-index="3001"]').evaluate(row => ({
      height: row.getBoundingClientRect().height,
      top: row.getBoundingClientRect().top,
      scroll: document.getElementById("graph")!.scrollLeft,
    }));
    expect(selected.height).toBe(30);
    expect(selected.top).toBeGreaterThanOrEqual(box!.y);
    expect(selected.scroll).toBeGreaterThanOrEqual(1000);
    await page.screenshot({ path: info.outputPath(`large-graph-scroll-${width}.png`) });
    await expect(page.locator("#graph-content > .row")).toHaveCount(5000);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("returning from a large graph to one page keeps ordinary row sizing and measured width", async ({ page }) => {
  await mountReferenceGraph(page, true, 1);
  await page.evaluate(async () => {
    const w: any = window, rows = w.__referenceFixture.rows.slice(0, 300);
    rows[200] = { ...rows[200], subject: "Long title after graph reset ".repeat(70) };
    window.dispatchEvent(new MessageEvent("message", { data: { type: "graph", data: { rows,
      edges: w.__referenceFixture.edges.slice(0, 299), laneCount: 1 },
      state: { reset: true, loading: false, hasMore: false, hasMoreBefore: false, loadedCount: 300, colorScope: "/fixture/references" } } }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page.locator("#graph-content > .row")).toHaveCount(300);
  const measured = await page.evaluate(() => {
    const root = document.getElementById("graph-content")!, row = root.querySelector<HTMLElement>('.row[data-index="200"]')!;
    return { width: parseFloat(root.style.width), right: row.offsetLeft + row.scrollWidth };
  });
  expect(measured.width).toBeGreaterThanOrEqual(measured.right);
});

