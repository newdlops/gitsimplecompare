import { expect, test } from "@playwright/test";
import path from "node:path";
import { dispatchWebviewMessage, mountGraphRenderer, readPostedMessages } from "./webviewHarness";

/** 실제 첫 페이지와 늦게 추가되는 가상 행의 동일한 hash/부모/행 배치를 만든다. */
function data(count = 300, virtual = false) {
  const rows = Array.from({ length: count }, (_, index) => ({
    hash: `initial-${index}`, parents: index + 1 < count ? [`initial-${index + 1}`] : [],
    refs: index === 0 ? ["HEAD", "main"] : [], authorName: "Graph fixture", authorEmail: "graph@example.invalid",
    dateIso: "2026-10-18T00:00:00Z", subject: `Commit ${index}: preserve the selected history during working-tree loading`,
    color: 0, column: 0, kind: "commit",
  }));
  if (virtual) rows.unshift(
    { ...rows[0], hash: "__gsc_virtual_ongoing__", parents: ["__gsc_virtual_staged__"], refs: [], subject: "Working tree", kind: "ongoing" },
    { ...rows[0], hash: "__gsc_virtual_staged__", parents: ["initial-0"], refs: [], subject: "Staged changes", kind: "staged" },
  );
  return { rows, edges: rows.slice(1).map((_, index) => ({
    fromRow: index, toRow: index + 1, column: 0, fromColumn: 0, toColumn: 0, color: 0,
  })), laneCount: 1 };
}

/** 커밋 페이지 로딩은 끝났지만 작업트리 소비자는 아직 진행 중인 실제 protocol 상태다. */
function pendingState() {
  return { loadedCount: 300, loading: false, hasMore: true, hasMoreBefore: false,
    reset: true, colorScope: "/fixture/initial-graph",
    workingTree: { loading: true, message: "Reading working tree..." } };
}

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`initial history stays interactive and keeps its anchor during late status at ${width}px`, async ({ page }, info) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await mountGraphRenderer(page);
    await page.addScriptTag({ path: path.join(process.cwd(), "media/graph/graphViewport.js") });
    await page.keyboard.press("Escape");
    await dispatchWebviewMessage(page, { type: "graph", data: data(), state: pendingState() });
    await expect(page.locator('#graph-content .row[data-hash="initial-0"]')).toBeVisible();
    await expect(page.locator("#load-status")).toContainText("Reading working tree...");
    await expect(page.locator("#load-status")).toHaveClass(/loading/);
    await page.screenshot({ path: info.outputPath(`initial-pending-${width}.png`) });
    await page.locator('#graph-content .row[data-hash="initial-5"] .subject').click();
    await expect.poll(async () => (await readPostedMessages(page)).some((message: any) => message.type === "selectCommit" && message.hash === "initial-5")).toBe(true);
    await page.keyboard.press("Escape");
    const graph = page.locator("#graph"), box = await graph.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 1500);
    await expect.poll(() => graph.evaluate(element => element.scrollTop)).toBeGreaterThan(500);
    const anchor = await graph.evaluate(element => {
      const row = Array.from(element.querySelectorAll<HTMLElement>(".row[data-hash]")).find(row => row.offsetTop + row.offsetHeight > element.scrollTop)!;
      return { hash: row.dataset.hash, offset: row.offsetTop - element.scrollTop };
    });
    await dispatchWebviewMessage(page, { type: "graph", data: data(300, true),
      state: { ...pendingState(), reset: false, loadDirection: "newer", workingTree: null } });
    const after = await graph.evaluate((element, hash) => {
      const row = element.querySelector<HTMLElement>(`.row[data-hash="${hash}"]`)!;
      return row.offsetTop - element.scrollTop;
    }, anchor.hash);
    expect(after).toBeCloseTo(anchor.offset, 0);
    await expect(page.locator('#graph-content .row.selected[data-hash="initial-5"]')).toHaveCount(1);
    await expect(page.locator("#load-status")).not.toContainText("Reading working tree");
    await expect(page.locator("#load-status")).not.toHaveClass(/loading/);
    await page.screenshot({ path: info.outputPath(`initial-complete-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("working-tree loading does not block normal pagination and a failure keeps history readable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountGraphRenderer(page);
  await page.keyboard.press("Escape");
  await dispatchWebviewMessage(page, { type: "graph", data: data(), state: pendingState() });
  const graph = page.locator("#graph");
  await graph.click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("End");
  await expect.poll(async () => (await readPostedMessages(page)).some((message: any) => message.type === "loadMore" && message.direction === "older")).toBe(true);
  await dispatchWebviewMessage(page, { type: "graph", data: data(600),
    state: { ...pendingState(), loadedCount: 600, reset: false, loadDirection: "older" } });
  await dispatchWebviewMessage(page, { type: "graphLoadState", state: {
    ...pendingState(), loadedCount: 600, reset: false, workingTree: {
      loading: false, message: "작업트리 상태를 불러오지 못했습니다.",
      detail: "커밋 이력은 사용할 수 있습니다. Git Simple Compare 출력을 확인한 뒤 새로고침하세요. 원인: status deadline",
    },
  } });
  await expect(page.locator("#graph-content .row")).toHaveCount(600);
  await expect(page.locator("#load-status")).toContainText("작업트리 상태를 불러오지 못했습니다.");
  await expect(page.locator("#load-status")).toHaveAttribute("title", /status deadline/);
  await expect(page.locator("#load-status")).not.toHaveClass(/loading/);
  await expect(page.locator("#graph-health")).toBeHidden();
});
