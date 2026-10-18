import { expect, test } from "@playwright/test";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { mountChanges, readPostedMessages } from "./webviewHarness";
import { CPU_RATE, mountSlowRebase, report } from "./lowEndHarness";

test("2k Graph rows remain responsive to scrolling and commit selection under 6x CPU", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const initial = await mountSlowRebase(page, 2000, 0, false);
  const painted = await page.evaluate(() => new Promise<number>(resolve => {
    const started = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)));
  }));
  await page.locator("#graph").evaluate(element => { element.scrollTop = 1000 * 30; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const row = page.locator('.row[data-index="1000"]');
  await expect(row).toBeVisible();
  await page.evaluate(() => {
    let started = 0;
    document.addEventListener("click", () => { started = performance.now(); }, true);
    document.addEventListener("click", () => { (window as any).__selectionMs = performance.now() - started; });
  });
  await row.click();
  const selectionMs = await page.evaluate(() => (window as any).__selectionMs);
  await report(page, info, "graph-2k", { ...initial, paintedMs: painted, selectionMs });
  expect(errors).toEqual([]);
  expect(initial.graphMs).toBeLessThan(1000);
  expect(selectionMs).toBeLessThan(100);
  expect((await readPostedMessages(page)).some((message: any) => message.type === "selectCommit" && message.hash === (1000).toString(16).padStart(40, "0"))).toBe(true);
});

test("15k Changes support scrolling and off-screen range selection under 6x CPU", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture: any = await loadWebviewFixture("changes.small.en.json");
  await mountChanges(page, fixture);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_RATE });
  const initial = await page.evaluate(base => {
    const changes = Array.from({ length: 15000 }, (_, index) => ({ kind: "file", change: {
      status: "M", path: `src/file${String(index).padStart(5, "0")}.ts`, additions: 3, deletions: 1,
    } }));
    const payload = { ...base, changes: { viewMode: "list", staged: [], unstaged: changes }, commit: { ...base.commit, hasStagedChanges: false } };
    const started = performance.now();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "render", payload } }));
    return { renderMs: performance.now() - started, rows: document.querySelectorAll(".wt-files .row").length };
  }, fixture.payload);
  const selector = (path: string) => page.locator(`#changes-group-files-unstaged .row[data-path="${path}"]`);
  await selector("src/file00000.ts").click();
  await page.locator('.section[data-section="changes"] > .section-body').evaluate(element => { element.scrollTop = 5000 * 22; });
  const target = selector("src/file05000.ts");
  await expect(target).toBeVisible();
  await page.evaluate(() => {
    let started = 0;
    document.addEventListener("click", () => { started = performance.now(); }, true);
    document.addEventListener("click", () => { (window as any).__rangeMs = performance.now() - started; });
  });
  await target.click({ modifiers: ["Shift"] });
  const selectionMs = await page.evaluate(() => (window as any).__rangeMs);
  await target.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Stage Changes" }).click();
  const staged = (await readPostedMessages(page)).filter((message: any) => message.type === "stage").at(-1);
  await report(page, info, "changes-15k", { ...initial, selectionMs, selectedFiles: staged?.paths.length });
  expect(initial.rows).toBeLessThan(120);
  expect(initial.renderMs).toBeLessThan(750);
  expect(selectionMs).toBeLessThan(100);
  expect(staged.paths).toHaveLength(5001);
});

for (const width of [390, 768, 1440]) {
test(`15k comparison files keep a bounded DOM and open off-screen diffs under 6x CPU at ${width}px`, async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const fixture: any = await loadWebviewFixture("changes.small.en.json");
  await mountChanges(page, fixture);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_RATE });
  const initial = await page.evaluate(base => {
    const nodes = Array.from({ length: 15000 }, (_, index) => ({ kind: "file", change: {
      status: "M", path: `src/comparison/file${String(index).padStart(5, "0")}.ts`, additions: 3, deletions: 1,
    } }));
    const payload = { ...base, compare: { mode: "comparison", from: "main", to: "feature/large-comparison", viewMode: "list", nodes } };
    (window as any).__comparisonPayload = payload;
    const started = performance.now();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "render", payload } }));
    return { renderMs: performance.now() - started, rows: document.querySelectorAll(".compare-files .row").length };
  }, fixture.payload);
  await report(page, info, `comparison-15k-${width}`, initial);
  expect(initial.rows).toBeLessThan(120);
  expect(initial.renderMs).toBeLessThan(750);
  await page.locator('.section[data-section="compare"] > .section-body').evaluate(element => { element.scrollTop = 7000 * 22; });
  const target = page.locator('.compare-files .row[data-path="src/comparison/file07000.ts"]');
  await expect(target).toBeVisible();
  await target.locator(".name").focus();
  await page.keyboard.press("Enter");
  expect((await readPostedMessages(page)).some((message: any) => message.type === "openComparisonFile" && message.path === "src/comparison/file07000.ts")).toBe(true);
  await target.hover();
  await target.locator('[data-act="openCompareDiff"]').click();
  expect((await readPostedMessages(page)).some((message: any) => message.type === "openDiff" && message.path === "src/comparison/file07000.ts")).toBe(true);
  await target.locator('[data-act="openCompareDiff"]').focus();
  await page.keyboard.press("Tab");
  await expect(page.locator('.compare-files .row[data-path="src/comparison/file07001.ts"] .name')).toBeFocused();
  // 트리로 전환해 접힌 폴더도 전체 모델을 유지하는지 확인한다.
  await page.evaluate(() => {
    const payload = (window as any).__comparisonPayload;
    const nodes = [{ kind: "folder", name: "src", path: "src", children: payload.compare.nodes }];
    window.dispatchEvent(new MessageEvent("message", { data: { type: "render", payload: {
      ...payload, compare: { ...payload.compare, viewMode: "tree", nodes },
    } } }));
  });
  const scroller = page.locator('.section[data-section="compare"] > .section-body');
  await scroller.evaluate(element => { element.scrollTop = 0; });
  const folder = page.locator('.compare-files .row.folder[data-path="src"]');
  await expect(folder).toBeVisible();
  await folder.focus();
  await page.keyboard.press("Enter");
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  expect(await page.locator(".compare-files .rows").evaluate(element => element.getBoundingClientRect().height)).toBe(22);
  await page.keyboard.press("Enter");
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  expect(await page.locator(".compare-files .row").count()).toBeLessThan(120);
  await report(page, info, `comparison-tree-${width}`, { rows: await page.locator(".compare-files .row").count() });
  expect(errors).toEqual([]);
});
}
