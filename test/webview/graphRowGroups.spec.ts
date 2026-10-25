import { expect, test, type Page } from "@playwright/test";
import { mountProductionReference } from "../helpers/graphProductionReference";
import { benchmarkOverrides as mock } from "../helpers/benchmarkOverrides";

test.afterEach(() => mock.restoreAll());

/** host 메시지의 실제 renderer와 그룹 위치 observer가 두 frame까지 반영되면 끝난다. */
async function post(page: Page, message: unknown) {
  await page.evaluate(async message => {
    window.dispatchEvent(new MessageEvent("message", { data: message }));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, message);
}

test("crossing from two pages to grouped history preserves focused ref identity, scroll and global row positions", async ({ browser, page }) => {
  await mountProductionReference(browser, page);
  const initial = await page.evaluate(() => {
    const fixture = (window as any).__referenceFixture;
    return { type: "graph", revision: 0, data: { rows: fixture.rows.slice(0, 600), edges: fixture.edges.slice(0, 599), laneCount: 1 },
      state: { reset: true, loadedCount: 600, loading: false, hasMore: true, hasMoreBefore: false, colorScope: "/fixture/references" } };
  });
  await post(page, initial);
  await expect(page.locator(".graph-row-group")).toHaveCount(0);
  await page.locator('#graph-content .row [data-branch-name="bench-100"]').focus();
  const before = await page.evaluate(() => {
    const w = window as any, root = document.getElementById("graph-content")!;
    w.__groupAnchor = root.querySelector('.row[data-index="100"]');
    w.__groupFocus = document.activeElement;
    return document.getElementById("graph")!.scrollTop;
  });
  const addition = await page.evaluate(() => {
    const fixture = (window as any).__referenceFixture;
    return { type: "graphDelta", delta: { baseRevision: 0, revision: 1, rowStart: 600,
      rows: fixture.rows.slice(600, 650), rowUpdates: [], edgeStart: 599, edges: fixture.edges.slice(599, 649), edgeUpdates: [], laneCount: 1 },
      state: { reset: false, loadedCount: 650, loading: false, hasMore: true, hasMoreBefore: false, colorScope: "/fixture/references" } };
  });
  await post(page, addition);
  const after = await page.evaluate(() => {
    const w = window as any, root = document.getElementById("graph-content")!, row = root.querySelector<HTMLElement>('.row[data-index="100"]')!;
    return { sameRow: row === w.__groupAnchor, sameFocus: document.activeElement === w.__groupFocus,
      scrollTop: document.getElementById("graph")!.scrollTop, globalTop: row.offsetTop,
      renderedTop: row.getBoundingClientRect().top - root.getBoundingClientRect().top };
  });
  expect(after.sameRow).toBe(true); expect(after.sameFocus).toBe(true);
  expect(after.scrollTop).toBe(before); expect(after.globalTop).toBe(3000);
  expect(after.renderedTop).toBeCloseTo(3000, 1);
  await expect(page.locator("#graph-content .row[data-hash]")).toHaveCount(650);
});

test("a populated reflog keeps rows and SVG aligned across group boundaries and after closing", async ({ browser, page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountProductionReference(browser, page, undefined, 80);
  await page.locator("#graph-reflog").click();
  const message = await page.evaluate(() => {
    const rows = (window as any).__referenceFixture.rows;
    return { type: "graphReflog", entries: [{ hash: rows[32].hash, source: "head", selector: "HEAD@{0}", shortSelector: "@{0}",
      message: "commit: boundary fixture", dateIso: rows[32].dateIso, branchSources: [], dropSources: [], currentRefs: [],
      transition: { fromHash: rows[31].hash, toHash: rows[32].hash, changed: true },
      recovery: { kind: "reachable" }, flowStatus: "timeline", eventKind: "commit" }] };
  });
  await post(page, message);
  await expect(page.locator(".reflog-virtual-row")).toHaveCount(1);
  /** 실제 row box와 SVG 중심을 비교해 스크롤용 전역 top과 paint containment 경계를 함께 확인한다. */
  const geometry = () => page.evaluate(() => {
    const root = document.getElementById("graph-content")!, rootTop = root.getBoundingClientRect().top;
    return [31, 32, 63, 64].map(index => {
      const row = root.querySelector<HTMLElement>(`.row[data-index="${index}"]:not([data-reflog-virtual])`)!;
      const node = root.querySelector(`.graph-node-layer .node[data-row="${index}"]`)!;
      const box = row.getBoundingClientRect(), group = row.closest(".graph-row-group")!.getBoundingClientRect();
      return { globalTop: row.offsetTop, renderedTop: box.top - rootTop,
        svgTop: Number(node.getAttribute("cy")) - 15, insideTop: box.top >= group.top, insideBottom: box.bottom <= group.bottom };
    });
  });
  for (const row of await geometry()) {
    expect(row.renderedTop).toBeCloseTo(row.svgTop, 1);
    expect(row.globalTop).toBeCloseTo(row.svgTop, 1);
    expect(row.insideTop).toBe(true); expect(row.insideBottom).toBe(true);
  }
  await page.locator('#graph-content .row[data-index="32"] .commit-hash').click();
  await expect(page.locator('#graph-content .row.selected[data-index="32"]')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("reflog-group-boundary.png"), animations: "disabled" });
  await page.locator("#close-reflog").click();
  await post(page, { type: "branchStatus", branches: await page.evaluate(() => (window as any).__referenceFixture.branches), worktrees: [] });
  for (const row of await geometry()) {
    expect(row.renderedTop).toBeCloseTo(row.svgTop, 1);
    expect(row.insideTop).toBe(true); expect(row.insideBottom).toBe(true);
  }
});

test("native find and keyboard focus can reveal previously unseen distant rows", async ({ browser, page }) => {
  await mountProductionReference(browser, page);
  const found = await page.evaluate(async () => {
    const text = (window as any).__referenceFixture.rows[3001].subject;
    const found = (window as any).find(text);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return { found, selectedText: window.getSelection()?.toString(), expectedText: text };
  });
  expect(found.found).toBe(true); expect(found.selectedText).toBe(found.expectedText);
  const ref = page.locator('#graph-content .row [data-branch-name="bench-900"]');
  await ref.focus(); await expect(ref).toBeFocused();
  const visible = await ref.evaluate(element => {
    const graph = document.getElementById("graph")!.getBoundingClientRect(), box = element.getBoundingClientRect();
    return box.top >= graph.top && box.bottom <= graph.bottom;
  });
  expect(visible).toBe(true);
});

test("adding and removing working-tree rows preserves a distant selection and its viewport anchor", async ({ browser, page }) => {
  await mountProductionReference(browser, page);
  const selected = page.locator('#graph-content .row[data-index="3000"] .commit-hash');
  await selected.click();
  const before = await page.locator("#graph").evaluate(element => element.scrollTop);
  const message = await page.evaluate(() => {
    const fixture = (window as any).__referenceFixture, first = fixture.rows[0];
    const virtual = ["ongoing", "staged"].map((kind, index) => ({ ...first, hash: `__gsc_virtual_${kind}__`, kind,
      parents: [index ? first.hash : "__gsc_virtual_staged__"], refs: [], subject: `${kind} changes` }));
    return { type: "graph", data: { rows: [...virtual, ...fixture.rows], laneCount: 1,
      edges: [...[{ fromRow: 0, toRow: 1 }, { fromRow: 1, toRow: 2 }].map(edge => ({ ...edge, column: 0, fromColumn: 0, toColumn: 0, color: 0 })),
        ...fixture.edges.map((edge: any) => ({ ...edge, fromRow: edge.fromRow + 2, toRow: edge.toRow + 2 }))] },
      state: { reset: true, loading: false, hasMore: false, hasMoreBefore: false, loadedCount: 5002, colorScope: "/fixture/references" } };
  });
  await post(page, message);
  await expect(page.locator('#graph-content .row.selected[data-index="3002"]')).toHaveCount(1);
  await expect(page.locator(".row.ongoing-row,.row.staged-row")).toHaveCount(2);
  expect(await page.locator("#graph").evaluate(element => element.scrollTop)).toBeCloseTo(before + 60, 1);
  const original = await page.evaluate(() => {
    const fixture = (window as any).__referenceFixture;
    return { type: "graph", data: { rows: fixture.rows, edges: fixture.edges, laneCount: 1 },
      state: { reset: true, loading: false, hasMore: false, hasMoreBefore: false, loadedCount: 5000, colorScope: "/fixture/references" } };
  });
  await post(page, original);
  await expect(page.locator('#graph-content .row.selected[data-index="3000"]')).toHaveCount(1);
  expect(await page.locator("#graph").evaluate(element => element.scrollTop)).toBeCloseTo(before, 1);
});

test("a full refresh retains horizontal position while viewing a distant long subject", async ({ browser, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountProductionReference(browser, page);
  const message = await page.evaluate(() => {
    const fixture = (window as any).__referenceFixture;
    const rows = fixture.rows.map((row: any, index: number) => ({ ...row,
      subject: index < 30 ? "Wide measured subject ".repeat(60) : index >= 3000 && index < 3010 ? "Distant visible subject ".repeat(40) : row.subject }));
    return { type: "graph", data: { rows, edges: fixture.edges, laneCount: 1 },
      state: { reset: true, loading: false, hasMore: false, hasMoreBefore: false, loadedCount: rows.length, colorScope: "/fixture/references" } };
  });
  await post(page, message);
  await page.locator("#graph").evaluate(async element => {
    element.scrollTop = 3000 * 30; element.scrollLeft = 1000;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const before = await page.locator("#graph").evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }));
  expect(before.left).toBe(1000);
  await post(page, message);
  const after = await page.locator("#graph").evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }));
  expect(after).toEqual(before);
});
