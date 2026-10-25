import { expect, test, type Page } from "@playwright/test";
import { mountProductionReference } from "../helpers/graphProductionReference";
import { benchmarkOverrides as mock } from "../helpers/benchmarkOverrides";

/** 현재 production Graph에 구조가 같은 제목 delta를 보내고 보조 기능의 RAF까지 기다린다. */
async function update(page: Page, index = 0) {
  await page.evaluate(async index => {
    const w = window as any, fixture = w.__referenceFixture, revision = w.GscGraphDataUpdates.stats().revision;
    window.dispatchEvent(new MessageEvent("message", { data: { type: "branchStatus", branches: fixture.branches, worktrees: [] } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "graphDelta", delta: { baseRevision: revision, revision: revision + 1,
      rowStart: fixture.rows.length, rows: [], rowUpdates: [{ index, row: { ...fixture.rows[index], subject: `Changed ${revision}` } }],
      edgeStart: fixture.edges.length, edges: [], edgeUpdates: [], laneCount: 1 },
      state: { loadedCount: fixture.rows.length, reset: false, loading: false, hasMore: false, colorScope: "/fixture/references" } } }));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, index);
}

/** 쓰지 않는 보조 기능의 전체 탐색과 viewport 캡처만 관찰한다. 제품 결과나 selector 응답은 바꾸지 않는다. */
async function observe(page: Page) {
  await page.evaluate(() => {
    const w = window as any, root = document.getElementById("graph-content")!, query = root.querySelectorAll.bind(root);
    w.__inactiveCounts = { cleanupScans: 0, captures: 0 };
    root.querySelectorAll = ((selector: string) => {
      if (/pr-stack-(layer-chip|head-row)|rebase-progress-(target|todo)/.test(selector)) w.__inactiveCounts.cleanupScans++;
      return query(selector);
    }) as typeof root.querySelectorAll;
    const capture = w.GscGraphViewport.capture;
    w.GscGraphViewport.capture = (...args: unknown[]) => { w.__inactiveCounts.captures++; return capture(...args); };
  });
}

test.afterEach(() => mock.restoreAll());
for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`inactive stack/rebase/reflog avoids full Graph scans at ${width}px`, async ({ browser, page }) => {
    test.setTimeout(90_000); await page.setViewportSize({ width, height });
    await mountProductionReference(browser, page); await observe(page);
    for (let round = 0; round < 3; round++) await update(page);
    expect(await page.evaluate(() => (window as any).__inactiveCounts)).toEqual({ cleanupScans: 0, captures: 0 });
    await expect(page.locator("#graph-content .row")).toHaveCount(5000);
    await expect(page.locator('#graph-content .row[data-index="0"] .subject')).toHaveText("Changed 2");
  });
}

test("active stack/progress/reflog redraw and clear correctly before becoming idle", async ({ browser, page }) => {
  test.setTimeout(90_000); await mountProductionReference(browser, page);
  await page.evaluate(async () => {
    const fixture = (window as any).__referenceFixture;
    const snapshot = { repository: "fixture", stacks: [], layers: [{ branch: "bench-0", parentBranch: "bench-1",
      headHash: fixture.rows[0].hash, parentHash: fixture.rows[1].hash, depth: 0, childBranches: [], local: true,
      needsRestack: false, pullRequest: { number: 42, state: "OPEN" } }] };
    for (let index = 0; index < 3; index++) window.dispatchEvent(new MessageEvent("message", { data: { type: "pullRequestStackSnapshot", snapshot } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "graphRebaseProgress", progress: {
      phase: "running", title: "Rebasing", detail: "Fixture progress", hash: fixture.rows[0].hash,
      todos: [{ hash: fixture.rows[1].hash, action: "pick", role: "remaining", index: 1, subject: "Remaining" }] } } }));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(page.locator(".pr-stack-flow-overlay")).toHaveCount(1);
  await expect(page.locator(".pr-stack-layer-chip")).toHaveCount(1);
  await expect(page.locator(".row.rebase-progress-target")).toHaveCount(1);
  await update(page);
  await expect(page.locator(".pr-stack-layer-chip")).toHaveCount(1);
  await expect(page.locator(".row.rebase-progress-target")).toHaveCount(1);
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "pullRequestStackSnapshot", snapshot: { repository: "fixture", stacks: [], layers: [] } } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "graphRebaseClear" } }));
  });
  await expect(page.locator(".pr-stack-layer-chip,.pr-stack-flow-overlay,.rebase-progress-target,.rebase-progress-target-node,.rebase-progress-todo-row,.rebase-progress-todo-node")).toHaveCount(0);
  await page.locator("#graph-reflog").click();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "graphReflog", entries: [] } })));
  await observe(page); await update(page);
  expect(await page.evaluate(() => (window as any).__inactiveCounts.captures)).toBeGreaterThan(0);
  await page.locator("#close-reflog").click();
  await page.evaluate(() => { (window as any).__inactiveCounts = { cleanupScans: 0, captures: 0 }; });
  await update(page);
  expect(await page.evaluate(() => (window as any).__inactiveCounts)).toEqual({ cleanupScans: 0, captures: 0 });
});

test("80 active stack layers remain complete across consecutive Graph and branch updates", async ({ browser, page }) => {
  test.setTimeout(90_000); await mountProductionReference(browser, page, undefined, 80);
  await expect(page.locator(".pr-stack-layer-chip")).toHaveCount(80);
  await expect(page.locator(".pr-stack-flow-path")).toHaveCount(80);
  await page.evaluate(() => {
    const w = window as any, root = document.getElementById("graph-content")!, query = root.querySelector.bind(root);
    w.__stackHashQueries = 0;
    root.querySelector = ((selector: string) => {
      if (/^\.(row|node)\[data-hash=/.test(selector)) w.__stackHashQueries++;
      return query(selector);
    }) as typeof root.querySelector;
  });
  for (let round = 0; round < 3; round++) await update(page);
  await expect(page.locator(".pr-stack-flow-overlay")).toHaveCount(1);
  await expect(page.locator(".pr-stack-layer-chip")).toHaveCount(80);
  await expect(page.locator(".pr-stack-flow-path")).toHaveCount(80);
  await expect(page.locator(".row.pr-stack-head-row")).toHaveCount(80);
  expect(await page.evaluate(() => (window as any).__stackHashQueries)).toBe(0);
});

test("stack arrows follow nodes repositioned by a populated reflog after a metadata delta", async ({ browser, page }) => {
  test.setTimeout(90_000); await mountProductionReference(browser, page, undefined, 80);
  await expect(page.locator(".pr-stack-layer-chip")).toHaveCount(80);
  await page.locator("#graph-reflog").click();
  await page.evaluate(() => {
    const rows = (window as any).__referenceFixture.rows;
    window.dispatchEvent(new MessageEvent("message", { data: { type: "graphReflog", entries: [{ hash: rows[1].hash,
      source: "head", selector: "HEAD@{0}", shortSelector: "@{0}", message: "commit: fixture", dateIso: rows[1].dateIso,
      branchSources: [], dropSources: [], currentRefs: [], transition: { fromHash: rows[0].hash, toHash: rows[1].hash, changed: true },
      recovery: { kind: "reachable" }, flowStatus: "timeline", eventKind: "commit" }] } }));
  });
  await expect(page.locator(".reflog-virtual-row")).toHaveCount(1);
  await update(page, 1);
  const positions = await page.evaluate(() => {
    const path = document.querySelector(".pr-stack-flow-path")!;
    const numbers = path.getAttribute("d")!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    return { pathHead: numbers[1], pathParent: numbers.at(-1),
      head: Number(document.querySelector('.graph-node-layer .node[data-row="0"]')!.getAttribute("cy")),
      parent: Number(document.querySelector('.graph-node-layer .node[data-row="1"]')!.getAttribute("cy")) };
  });
  expect(positions.pathHead).toBe(positions.head); expect(positions.pathParent).toBe(positions.parent);
});
