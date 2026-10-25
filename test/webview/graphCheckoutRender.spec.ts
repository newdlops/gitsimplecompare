import { expect, test } from "@playwright/test";
import { mountReferenceGraph } from "./graphReferenceHarness";

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`checkout deltas keep unchanged badges, selection and viewport at ${width}px`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await mountReferenceGraph(page, true);
    await page.keyboard.press("Escape");
    await page.locator('#graph-content .row[data-index="1"] .commit-hash').click(); await page.keyboard.press("Escape");
    await page.locator("#graph").evaluate(element => { element.scrollTop = 4000; (element as HTMLElement).focus(); });
    const measured = await page.evaluate(async () => {
      const w = window as any, fixture = w.__referenceFixture, graph = document.getElementById("graph")!;
      const keptRow = document.querySelector('#graph-content .row[data-index="1500"]');
      const keptNode = document.querySelector('.node[data-row="1500"]');
      const keptEdge = (document.querySelector("#graph-content svg") as any).__gscEdgeElements[1500][0];
      const scroll = graph.scrollTop;
      const phases: Record<string, number> = {};
      for (const [owner, name, label] of [[w.GscGraphSvgRender, "render", "svg"], [w.GscGraphDataUpdates, "prepare", "prepare"],
        [w.GscGraphDataUpdates, "renderRows", "rows"], [w.GscGraphFeatures, "attachNodeDrag", "bindings"]]) {
        const run = owner[name]; owner[name] = (...args: unknown[]) => {
          const start = performance.now(), result = run(...args); phases[label] = (phases[label] || 0) + performance.now() - start; return result;
        };
      }
      fixture.badgeCalls = 0; fixture.resolverCalls = 0;
      let colorCalls = 0, nodeCalls = 0;
      const nodeClass = w.GscGraphFeatures.nodeClass;
      w.GscGraphFeatures.nodeClass = (...args: unknown[]) => { nodeCalls++; return nodeClass(...args); };
      const rowColor = w.GscGraphColors.rowColor;
      w.GscGraphColors.rowColor = (...args: unknown[]) => { colorCalls++; return rowColor(...args); };
      const samples: number[] = [], painted: number[] = [];
      for (let round = 0; round < 3; round++) {
        const active = round % 2 === 0 ? 1 : 0, branches = structuredClone(fixture.branches);
        branches[0].current = active === 0; branches[1].current = active === 1;
        const rowUpdates = [0, 1].map(index => ({ index, row: { ...fixture.rows[index],
          refs: [...(index === active ? ["HEAD"] : []), `bench-${index}`, `tag:release-${index}`] } }));
        const start = performance.now();
        window.dispatchEvent(new MessageEvent("message", { data: { type: "branchStatus", branches, worktrees: [] } }));
        window.dispatchEvent(new MessageEvent("message", { data: { type: "graphDelta", delta: { baseRevision: round, revision: round + 1,
          rowStart: fixture.rows.length, rows: [], rowUpdates, edgeStart: fixture.edges.length, edges: [], edgeUpdates: [], laneCount: 1 },
          state: { loadedCount: fixture.rows.length, reset: false, loading: false, hasMore: false, hasMoreBefore: false, colorScope: "/fixture/references" } } }));
        samples.push(+(performance.now() - start).toFixed(1));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        painted.push(+(performance.now() - start).toFixed(1));
      }
      return { badgeCalls: fixture.badgeCalls, colorCalls, nodeCalls, resolverCalls: fixture.resolverCalls, phases, samples, painted, keptRow: keptRow === document.querySelector('#graph-content .row[data-index="1500"]'),
        keptNode: keptNode === document.querySelector('.node[data-row="1500"]'), keptEdge: keptEdge === (document.querySelector("#graph-content svg") as any).__gscEdgeElements[1500][0],
        edges: fixture.edges.length, scroll: graph.scrollTop === scroll, focus: document.activeElement === graph };
    });
    console.log(`[checkout-render:${width}] ${JSON.stringify(measured)}`);
    await info.attach("checkout-render-metrics.json", { body: JSON.stringify(measured), contentType: "application/json" });
    expect(measured.keptRow).toBe(true); expect(measured.keptNode).toBe(true); expect(measured.scroll).toBe(true); expect(measured.focus).toBe(true);
    expect(measured.keptEdge).toBe(true); expect(measured.edges).toBe(4999);
    expect(measured.badgeCalls).toBeLessThanOrEqual(120);
    expect(measured.colorCalls).toBeLessThanOrEqual(12); expect(measured.resolverCalls).toBe(0);
    expect(measured.nodeCalls).toBeLessThanOrEqual(30);
    await expect(page.locator('#graph-content .row.selected[data-index="1"]')).toHaveCount(1);
    await expect(page.locator('#graph-content .row[data-index="1"] .head')).toHaveCount(1);
    await expect(page.locator('#graph-content .row[data-index="0"] .head')).toHaveCount(0);
    await expect(page.locator('.ref.current-local[data-branch-name="bench-1"]')).toHaveCount(1);
    await page.locator('#graph-content .row[data-index="0"]').scrollIntoViewIfNeeded();
    await page.locator("#graph").evaluate(element => { element.scrollLeft = 0; });
    await page.screenshot({ path: info.outputPath(`checkout-render-${width}.png`) });
    expect(errors).toEqual([]);
  });
}

test("changing a local-only tip recomputes the ancestor and edge colors beyond the stable-color cap", async ({ page }) => {
  test.setTimeout(90_000);
  await mountReferenceGraph(page);
  const result = await page.evaluate(() => {
    const w = window as any, rows = structuredClone(w.__referenceFixture.rows);
    rows[1200] = { ...rows[1200], refs: ["bench-0"], localOnlyBranches: ["bench-0", "bench-1"] };
    rows[1201] = { ...rows[1201], localOnlyBranches: ["bench-0", "bench-1"] };
    const edges = [{ fromRow: 1200, toRow: 1201, column: 0, fromColumn: 0, toColumn: 0, color: 0 }];
    const state = { loadedCount: rows.length, reset: true, loading: false, hasMore: false, colorScope: "/fixture/references" };
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data }));
    send({ type: "graph", data: { rows, edges, laneCount: 1 }, revision: 10, state });
    const ancestor = () => document.querySelector<HTMLElement>('#graph-content .row[data-index="1201"]')!.style.getPropertyValue("--branch-color");
    const before = ancestor(), changed = { ...rows[1200], refs: ["bench-1"] };
    send({ type: "graphDelta", delta: { baseRevision: 10, revision: 11, rowStart: rows.length, rows: [],
      rowUpdates: [{ index: 1200, row: changed }], edgeStart: edges.length, edges: [], edgeUpdates: [], laneCount: 1 }, state: { ...state, reset: false } });
    return { before, after: ancestor(), expected: w.GscGraphFeatures.branchColor("bench-1"),
      node: document.querySelector('.node[data-row="1201"]')!.getAttribute("fill"), edge: document.querySelector("#graph-content svg path")!.getAttribute("stroke") };
  });
  expect(result.before).not.toBe(result.expected);
  expect(result.after).toBe(result.expected); expect(result.node).toBe(result.expected); expect(result.edge).toBe(result.expected);
});

test("a palette change invalidates cached branch badge HTML even when every branch record is identical", async ({ page }) => {
  test.setTimeout(90_000);
  await mountReferenceGraph(page);
  const color = await page.evaluate(() => {
    const w = window as any, branchColor = w.GscGraphColors.branchColor;
    w.GscGraphColors.branchColor = (name: string, ...args: unknown[]) => name === "bench-0" ? "#123456" : branchColor(name, ...args);
    window.dispatchEvent(new MessageEvent("message", { data: { type: "branchStatus", branches: structuredClone(w.__referenceFixture.branches), worktrees: [] } }));
    return document.querySelector<HTMLElement>('.ref[data-branch-name="bench-0"]')!.style.getPropertyValue("--branch-color");
  });
  expect(color).toBe("#123456");
});

test("worktree-only changes refresh their cached badge before and after a metadata delta", async ({ page }) => {
  test.setTimeout(90_000);
  await mountReferenceGraph(page);
  const result = await page.evaluate(() => {
    const w = window as any, fixture = w.__referenceFixture;
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data }));
    const other = { branch: "bench-3", name: "unchanged", path: "/fixture/unchanged" };
    send({ type: "branchStatus", branches: fixture.branches, worktrees: [{ branch: "bench-2", name: "old", path: "/fixture/old" }, other] });
    send({ type: "graph", data: { rows: structuredClone(fixture.rows), edges: [], laneCount: 1 }, revision: 10,
      state: { loadedCount: fixture.rows.length, reset: true, loading: false, hasMore: false, colorScope: "/fixture/references" } });
    const kept = document.querySelector('#graph-content .row[data-index="3"]');
    fixture.badgeCalls = 0;
    const updates = [
      { branch: "bench-2", name: "moved", path: "/fixture/moved", locked: "keep" },
      { branch: "bench-2", name: "pruned", path: "/fixture/pruned", prunable: "missing" },
      null,
    ];
    const states = updates.map((item, round) => {
      send({ type: "branchStatus", branches: structuredClone(fixture.branches), worktrees: [...(item ? [item] : []), other] });
      const read = () => document.querySelector<HTMLElement>('.ref[data-branch-name="bench-2"] .ref-worktree-badge');
      const immediate = read()?.textContent || "", tooltip = read()?.title || "";
      send({ type: "graphDelta", delta: { baseRevision: 10 + round, revision: 11 + round, rowStart: fixture.rows.length, rows: [],
        rowUpdates: [{ index: 0, row: { ...fixture.rows[0], subject: `Changed ${round}` } }], edgeStart: 0, edges: [], edgeUpdates: [], laneCount: 1 },
        state: { loadedCount: fixture.rows.length, reset: false, loading: false, hasMore: false, colorScope: "/fixture/references" } });
      return { immediate, tooltip, after: read()?.textContent || "" };
    });
    return { states, badgeCalls: fixture.badgeCalls, kept: kept === document.querySelector('#graph-content .row[data-index="3"]') };
  });
  expect(result.states).toEqual([
    { immediate: "moved", after: "moved", tooltip: "Worktree: moved | Path: /fixture/moved | locked: keep" },
    { immediate: "pruned", after: "pruned", tooltip: "Worktree: pruned | Path: /fixture/pruned | prunable: missing" },
    { immediate: "", after: "", tooltip: "" },
  ]);
  expect(result.badgeCalls).toBeLessThanOrEqual(80); expect(result.kept).toBe(true);
});

test("a load-state scope change invalidates colors from the last rendered graph", async ({ page }) => {
  test.setTimeout(90_000);
  await mountReferenceGraph(page);
  const result = await page.evaluate(() => {
    const w = window as any, fixture = w.__referenceFixture;
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data }));
    const color = () => document.querySelector<HTMLElement>('#graph-content .row[data-index="4000"]')!.style.getPropertyValue("--branch-color");
    const before = color(); w.GscGraphColors.rowColor = () => "#123456";
    const state = { loadedCount: fixture.rows.length, reset: false, loading: false, hasMore: false, colorScope: "/fixture/other" };
    send({ type: "graphLoadState", state });
    send({ type: "graphDelta", delta: { baseRevision: 0, revision: 1, rowStart: fixture.rows.length, rows: [],
      rowUpdates: [{ index: 0, row: { ...fixture.rows[0], subject: "Changed scope" } }], edgeStart: 0, edges: [], edgeUpdates: [], laneCount: 1 }, state });
    return { before, after: color(), resolverCalls: fixture.resolverCalls };
  });
  expect(result.before).not.toBe("#123456"); expect(result.after).toBe("#123456"); expect(result.resolverCalls).toBe(1);
});
