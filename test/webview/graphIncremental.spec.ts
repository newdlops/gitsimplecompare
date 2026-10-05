import { expect, test } from "@playwright/test";
import { layoutGraph } from "../../src/graph/graphLayout";
import { compactGraphData } from "../../src/graph/graphCompact";
import type { Commit, GraphData, GraphDataDelta } from "../../src/graph/graphTypes";
import { dispatchWebviewMessage, mountGraphRenderer, readPostedMessages } from "./webviewHarness";

/** 페이지 추가 전후의 같은 topo 입력으로 큰 그래프와 실제로 변하는 경계를 만든다. */
function history(count: number): Commit[] {
  return Array.from({ length: count }, (_, i) => ({ hash: `commit-${i}`, parents: i + 1 < count ? [`commit-${i + 1}`] : [],
    refs: i === 0 ? ["HEAD", "main"] : [], authorName: "Fixture", authorEmail: "a@example.test",
    dateIso: "2026-01-01T00:00:00Z", subject: `Commit ${i}` }));
}

/** 독립된 host 모델의 추가 행과 변경된 dangling 간선만 전송한다. */
function delta(previous: GraphData, next: GraphData): GraphDataDelta {
  return { baseRevision: 1, revision: 2, rowStart: previous.rows.length, rows: next.rows.slice(previous.rows.length), rowUpdates: [],
    edgeStart: previous.edges.length, edges: next.edges.slice(previous.edges.length),
    edgeUpdates: previous.edges.flatMap((edge, index) => JSON.stringify(edge) === JSON.stringify(next.edges[index]) ? [] : [{ index, edge: next.edges[index] }]),
    laneCount: next.laneCount };
}

test("graph page append preserves unchanged row, SVG, focus and viewport and repairs missing transport", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await mountGraphRenderer(page);
  const input = history(2200), before = layoutGraph(input.slice(0, 2000)), after = layoutGraph(input);
  const state = { loadedCount: 2000, hasMore: true, loading: false, reset: true, colorScope: "/fixture" };
  await dispatchWebviewMessage(page, { type: "graph", data: before, revision: 1, state });
  await expect(page.locator("#graph-content > .row")).toHaveCount(2000);
  await page.locator('#graph-content > .row[data-hash="commit-205"]').click();
  await page.evaluate(() => {
    const w: any = window;
    w.__row = document.querySelector('#graph-content > .row[data-hash="commit-205"]');
    w.__svg = document.querySelector("#graph-content svg");
    w.__node = document.querySelector('.node[data-hash="commit-205"]');
    w.__focus = document.getElementById("graph"); w.__focus.focus(); w.__scroll = w.__focus.scrollTop;
    w.__graphEvents = 0; window.addEventListener("message", event => { if (event.data?.type === "graph") w.__graphEvents++; });
  });
  await dispatchWebviewMessage(page, { type: "graphDelta", delta: delta(before, after), state: { ...state, loadedCount: 2200, reset: false } });
  await expect(page.locator("#graph-content > .row")).toHaveCount(2200);
  expect(await page.evaluate(() => {
    const w: any = window; return {
      row: w.__row === document.querySelector('#graph-content > .row[data-hash="commit-205"]'),
      svg: w.__svg === document.querySelector("#graph-content svg"), node: w.__node === document.querySelector('.node[data-hash="commit-205"]'),
      focus: document.activeElement === w.__focus, scroll: document.getElementById("graph")!.scrollTop === w.__scroll,
      events: w.__graphEvents, stats: w.GscGraphDataUpdates.stats(),
    };
  })).toEqual({ row: true, svg: true, node: true, focus: true, scroll: true, events: 1,
    stats: { revision: 2, rows: 2200, edges: 2199, waiting: false } });
  for (let i = 0; i < 2; i++) await dispatchWebviewMessage(page, { type: "graphDelta", delta: { ...delta(before, after), baseRevision: 9, revision: 10 }, state });
  expect((await readPostedMessages(page)).filter((m: any) => m.type === "resyncGraph")).toHaveLength(1);
  await expect(page.locator("#graph-content > .row")).toHaveCount(2200);
  await dispatchWebviewMessage(page, { type: "graph", data: after, revision: 10, state: { ...state, loadedCount: 2200, reset: false } });
  expect(await page.evaluate(() => (window as any).GscGraphDataUpdates.stats().waiting)).toBe(false);
});

test("delta merge and compact markers render identically to a full snapshot", async ({ page }) => {
  await mountGraphRenderer(page);
  const input = history(140); input[0].parents = ["commit-1", "commit-100"]; input[40].parents.push("commit-120");
  const before = layoutGraph(input.slice(0, 80)), after = layoutGraph(input);
  const state = { loadedCount: 80, hasMore: false, loading: false, reset: true, colorScope: "/fixture" };
  await dispatchWebviewMessage(page, { type: "graph", data: before, revision: 1, state });
  await dispatchWebviewMessage(page, { type: "graphDelta", delta: { ...delta(before, after),
    rowUpdates: before.rows.flatMap((row, index) => JSON.stringify(row) === JSON.stringify(after.rows[index]) ? [] : [{ index, row: after.rows[index] }]) },
    state: { ...state, reset: false, loadedCount: 140 } });
  const read = () => page.evaluate(() => [...document.querySelectorAll("#graph-content svg path,#graph-content svg circle")].map(node =>
    [node.tagName, ...["d", "cx", "cy", "fill", "stroke", "data-hash"].map(attribute => node.getAttribute(attribute))]));
  const incremental = await read();
  await dispatchWebviewMessage(page, { type: "graph", data: after, revision: 3, state: { ...state, loadedCount: 140 } });
  expect(await read()).toEqual(incremental);
});

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`dense compact graph remains complete after delta at ${width}px`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height }); await mountGraphRenderer(page);
    const input = history(120); input[0].parents = Array.from({ length: 23 }, (_, i) => `commit-${10 + i * 2}`);
    const before = compactGraphData(layoutGraph(input.slice(0, 80))), after = compactGraphData(layoutGraph(input));
    const state = { loadedCount: 80, hasMore: false, loading: false, reset: true, colorScope: "/fixture" };
    await dispatchWebviewMessage(page, { type: "graph", data: before, revision: 1, state });
    await dispatchWebviewMessage(page, { type: "graphDelta", delta: { ...delta(before, after),
      rowUpdates: before.rows.flatMap((row, index) => JSON.stringify(row) === JSON.stringify(after.rows[index]) ? [] : [{ index, row: after.rows[index] }]) },
      state: { ...state, reset: false, loadedCount: 120 } });
    await expect(page.locator("#graph-content > .row")).toHaveCount(120);
    await page.locator('#graph-content > .row[data-hash="commit-4"]').click();
    if (width < 1100) await page.keyboard.press("Escape");
    await page.mouse.move(width - 1, height - 1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: `/tmp/gsc-optimization-graph-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  });
}
