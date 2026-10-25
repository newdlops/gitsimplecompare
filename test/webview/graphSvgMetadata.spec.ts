import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { compactGraphData } from "../../src/graph/graphCompact";
import { layoutGraph } from "../../src/graph/graphLayout";
import { mountReferenceGraph } from "./graphReferenceHarness";
import { dispatchWebviewMessage, mountGraphRenderer } from "./webviewHarness";

/** 최신 full snapshot과 SVG 표시를 비교하되 소유 요소의 삽입 순서는 비교하지 않는다. */
async function svgShape(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll("#graph-content svg *")].map(node => [
    node.tagName, [...node.attributes].map(attr => `${attr.name}=${attr.value}`).sort().join("|"),
    node.children.length ? "" : node.textContent,
  ].join("\n")).sort());
}

for (const unknownScope of [false, true]) {
  test(`metadata SVG matches full snapshot after reference changes (unknown scope: ${unknownScope})`, async ({ page }) => {
    test.setTimeout(90_000);
    await mountReferenceGraph(page, true, 1);
    const data = await page.evaluate(unknownScope => {
      const w = window as any, fixture = w.__referenceFixture;
      const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data }));
      const branches = structuredClone(fixture.branches);
      if (unknownScope) {
        const branchColor = w.GscGraphColors.branchColor;
        w.GscGraphColors.branchColor = (name: string, ...args: unknown[]) => name === "bench-2" ? "#123456" : branchColor(name, ...args);
      } else {
        branches[2].ahead = 3; branches[2].current = true; branches[0].current = false;
      }
      send({ type: "branchStatus", branches, worktrees: [{ branch: "bench-3", name: "other", path: "/fixture/other" }] });
      send({ type: "tagStatus", tags: fixture.tags.filter((tag: any) => tag.name !== "release-4") });
      const state = { loadedCount: fixture.rows.length, reset: false, loading: false, hasMore: false, hasMoreBefore: false,
        colorScope: "/fixture/references" };
      // 상태만 알린 프레임에서도 아직 SVG에 반영하지 않은 참조 변경 범위는 보존해야 한다.
      send({ type: "graphLoadState", state });
      const rows = structuredClone(fixture.rows);
      rows[0].refs = rows[0].refs.filter((ref: string) => ref !== "HEAD"); rows[2].refs.unshift("HEAD");
      rows[17].subject = "Changed subject and author"; rows[17].authorName = "Updated author";
      send({ type: "graphDelta", delta: { baseRevision: 0, revision: 1, rowStart: rows.length, rows: [],
        rowUpdates: [0, 2, 17].map(index => ({ index, row: rows[index] })),
        edgeStart: fixture.edges.length, edges: [], edgeUpdates: [], laneCount: 1 }, state });
      return { rows, edges: fixture.edges, laneCount: 1 };
    }, unknownScope);
    const incremental = await svgShape(page);
    await dispatchWebviewMessage(page, { type: "graph", data, revision: 2,
      state: { loadedCount: data.rows.length, reset: false, loading: false, hasMore: false, colorScope: "/fixture/references" } });
    expect(await svgShape(page)).toEqual(incremental);
  });
}

test("metadata updates preserve compact marker ownership and match a full SVG", async ({ page }) => {
  await mountGraphRenderer(page);
  await page.addScriptTag({ path: join(process.cwd(), "media/graph/graphCompactRender.js") });
  const commits = Array.from({ length: 160 }, (_, index) => ({ hash: `commit-${index}`,
    parents: index < 159 ? [`commit-${index + 1}`] : [], refs: index === 0 ? ["HEAD", "main"] : [],
    subject: `Commit ${index}`, authorName: "Fixture", authorEmail: "fixture@example.test", dateIso: "2026-10-17T00:00:00Z" }));
  commits[0].parents = Array.from({ length: 23 }, (_, index) => `commit-${20 + index * 4}`);
  const data = compactGraphData(layoutGraph(commits));
  const index = data.rows.findIndex(row => row.compacted);
  expect(index).toBeGreaterThanOrEqual(0);
  const state = { loadedCount: data.rows.length, reset: false, loading: false, hasMore: false, colorScope: "/fixture/compact" };
  await dispatchWebviewMessage(page, { type: "graph", data, revision: 10, state: { ...state, reset: true } });
  const markers = await page.locator("#graph-content svg > .compact-continuation").count();
  expect(markers).toBeGreaterThan(0);
  for (let round = 0; round < 3; round++) {
    data.rows[index] = { ...data.rows[index], subject: `Changed compact node ${round}`, refs: [...data.rows[index].refs.filter(ref => ref !== "HEAD"), ...(round % 2 ? [] : ["HEAD"])] };
    await dispatchWebviewMessage(page, { type: "graphDelta", delta: { baseRevision: 10 + round, revision: 11 + round,
      rowStart: data.rows.length, rows: [], rowUpdates: [{ index, row: data.rows[index] }],
      edgeStart: data.edges.length, edges: [], edgeUpdates: [], laneCount: data.laneCount }, state });
    expect(await page.locator("#graph-content svg > .compact-continuation").count()).toBe(markers);
  }
  const incremental = await svgShape(page);
  await dispatchWebviewMessage(page, { type: "graph", data, revision: 20, state });
  expect(await svgShape(page)).toEqual(incremental);
});

test("a detached cached tail and a virtual lookalike recover from the complete latest model", async ({ page }) => {
  await mountGraphRenderer(page);
  const rows = Array.from({ length: 4 }, (_, index) => ({ hash: `commit-${index}`, parents: [], refs: index ? [] : ["HEAD"],
    subject: `Commit ${index}`, authorName: "Fixture", authorEmail: "fixture@example.test", dateIso: "2026-10-17T00:00:00Z", color: 0, column: 0 }));
  const state = { loadedCount: rows.length, reset: false, loading: false, hasMore: false, colorScope: "/fixture/tail" };
  await dispatchWebviewMessage(page, { type: "graph", data: { rows, edges: [], laneCount: 1 }, revision: 1, state: { ...state, reset: true } });
  await page.evaluate(() => {
    const tail = document.querySelector('#graph-content > .row[data-index="3"]')!;
    const virtual = tail.cloneNode(true) as HTMLElement; virtual.dataset.reflogVirtual = "1";
    tail.replaceWith(virtual);
  });
  rows[1].subject = "Updated after detached tail";
  await dispatchWebviewMessage(page, { type: "graphDelta", delta: { baseRevision: 1, revision: 2,
    rowStart: rows.length, rows: [], rowUpdates: [{ index: 1, row: rows[1] }], edgeStart: 0, edges: [], edgeUpdates: [], laneCount: 1 }, state });
  await expect(page.locator('#graph-content > .row:not([data-reflog-virtual])')).toHaveCount(4);
  await expect(page.locator('#graph-content > .row[data-index="1"]')).toContainText("Updated after detached tail");
  await expect(page.locator('[data-reflog-virtual]')).toHaveCount(0);
  await expect(page.locator('#graph-content .node[data-row="3"]')).toHaveCount(1);
});
