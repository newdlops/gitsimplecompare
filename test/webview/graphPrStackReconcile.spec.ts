import { expect, test, type Page } from "@playwright/test";
import { mountProductionReference } from "../helpers/graphProductionReference";
import { benchmarkOverrides as mock } from "../helpers/benchmarkOverrides";
import { mountPullRequestStackGraph } from "./webviewHarness";

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = []; errors.set(page, list); page.on("pageerror", error => list.push(error.message));
});
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); mock.restoreAll(); });

/** @param page 소유 Graph @param message host 메시지 @returns 기존 모든 장식 callback이 반영되는 두 frame까지 기다린다. */
async function post(page: Page, message: unknown) {
  await page.evaluate(async message => {
    window.dispatchEvent(new MessageEvent("message", { data: message }));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, message);
}

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`80 stack chips and arrows survive identical messages and replaced commit rows at ${width}px`, async ({ browser, page }) => {
    test.setTimeout(90_000); await page.setViewportSize({ width, height });
    await mountProductionReference(browser, page, undefined, 80);
    await expect(page.locator(".pr-stack-layer-chip")).toHaveCount(80);
    const result = await page.evaluate(async () => {
      const w = window as any, fixture = w.__referenceFixture, root = document.getElementById("graph-content")!;
      const overlay = root.querySelector(".pr-stack-flow-overlay")!, chips = [...root.querySelectorAll(".pr-stack-layer-chip")];
      const paths = [...overlay.querySelectorAll(".pr-stack-flow-path")];
      let writes = 0;
      const observer = new MutationObserver(records => { writes += records.length; });
      [overlay, ...chips].forEach(node => observer.observe(node, { attributes: true, childList: true, characterData: true, subtree: true }));
      /** 같은 표시를 유지하는 frame과 실제 행 교체 frame을 구분한다. */
      const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      for (let round = 0; round < 3; round++) {
        window.dispatchEvent(new MessageEvent("message", { data: { type: "branchStatus", branches: fixture.branches, worktrees: [] } }));
        await frame();
      }
      writes += observer.takeRecords().length; observer.disconnect();
      const revision = w.GscGraphDataUpdates.stats().revision;
      window.dispatchEvent(new MessageEvent("message", { data: { type: "graphDelta", delta: { baseRevision: revision, revision: revision + 1,
        rowStart: fixture.rows.length, rows: [], rowUpdates: [0, 1].map(index => ({ index, row: { ...fixture.rows[index], subject: "Updated row" } })),
        edgeStart: fixture.edges.length, edges: [], edgeUpdates: [], laneCount: 1 },
        state: { loadedCount: fixture.rows.length, reset: false, loading: false, hasMore: false, colorScope: "/fixture/references" } } }));
      await frame();
      return { writes, sameOverlay: root.querySelector(".pr-stack-flow-overlay") === overlay,
        sameChips: chips.every(chip => chip === root.querySelector(`[data-stack-branch="${(chip as HTMLElement).dataset.stackBranch}"]`)),
        samePaths: paths.every((path, index) => path === overlay.querySelectorAll(".pr-stack-flow-path")[index]),
        attached: chips.every(chip => chip.isConnected && chip.parentElement?.parentElement === root) };
    });
    expect(result).toEqual({ writes: 0, sameOverlay: true, sameChips: true, samePaths: true, attached: true });
    await expect(page.locator(".pr-stack-flow-path")).toHaveCount(80);
    await page.screenshot({ path: `/private/tmp/gsc-pr-reconcile-${width}.png`, animations: "disabled" });
  });
}

test("stack state, duplicate heads, missing nodes, a new canvas and clearing reconcile correctly", async ({ page }) => {
  const layer = { branch: "feature/a", parentBranch: "main", headHash: "child", parentHash: "local-base", depth: 0,
    childBranches: [], local: true, needsRestack: false, pullRequest: { number: 7, state: "OPEN" } };
  const snapshot = { repository: "fixture", stacks: [], layers: [layer, { ...layer, branch: "feature/b", depth: 1 }] };
  await mountPullRequestStackGraph(page, snapshot);
  await page.locator("#graph-content").evaluate(element => { element.style.display = "block"; });
  await expect(page.locator(".pr-stack-layer-chip")).toHaveCount(2);
  expect(await page.locator('.row[data-hash="child"] [data-stack-branch]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.stackBranch)))
    .toEqual(["feature/b", "feature/a"]);
  await page.locator('[data-stack-branch="feature/a"]').focus();
  await post(page, { type: "pullRequestStackSnapshot", snapshot });
  await expect(page.locator('[data-stack-branch="feature/a"]')).toBeFocused();
  await post(page, { type: "pullRequestStackSnapshot", snapshot: { ...snapshot, layers: [...snapshot.layers].reverse() } });
  await expect(page.locator('[data-stack-branch="feature/a"]')).toBeFocused();
  expect(await page.locator('.row[data-hash="child"] [data-stack-branch]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.stackBranch)))
    .toEqual(["feature/a", "feature/b"]);
  snapshot.layers[0] = { ...layer, needsRestack: true, depth: 3, pullRequest: { number: 99, state: "CLOSED" } };
  snapshot.layers[1] = { ...snapshot.layers[1], headHash: "missing" };
  await post(page, { type: "pullRequestStackSnapshot", snapshot });
  await expect(page.locator(".pr-stack-layer-chip")).toHaveCount(1);
  await expect(page.locator(".pr-stack-flow-path")).toHaveCount(1);
  await expect(page.locator(".pr-stack-layer-chip")).toHaveClass(/state-closed.*needs-restack/);
  await expect(page.locator(".pr-stack-chip-depth")).toHaveText("L4");
  await expect(page.locator(".pr-stack-layer-chip")).toHaveText(/#99/);
  await expect(page.locator(".pr-stack-flow-path")).toHaveClass(/needs-restack/);
  await page.evaluate(() => {
    document.getElementById("graph-content")!.innerHTML = '<svg width="300" height="200"><circle class="node" data-hash="child" cx="80" cy="40"></circle><circle class="node" data-hash="local-base" cx="80" cy="170"></circle></svg><div class="row" data-hash="child"></div>';
  });
  await post(page, { type: "graph" });
  await expect(page.locator(".pr-stack-flow-overlay")).toHaveAttribute("width", "300");
  await expect(page.locator(".pr-stack-flow-overlay")).toHaveAttribute("height", "200");
  await expect(page.locator(".pr-stack-flow-path")).toHaveAttribute("d", /M 80 40 .*80 170$/);
  for (const attribute of ["title", "data-tooltip", "aria-label"]) await expect(page.locator(".pr-stack-layer-chip")).toHaveAttribute(attribute, /.+/);
  await post(page, { type: "pullRequestStackSnapshot", snapshot: { ...snapshot, layers: [] } });
  await expect(page.locator(".pr-stack-layer-chip,.pr-stack-flow-overlay,.pr-stack-head-row")).toHaveCount(0);
  await post(page, { type: "pullRequestStackSnapshot", snapshot });
  await expect(page.locator(".pr-stack-layer-chip")).toHaveCount(1);
  await expect(page.locator(".pr-stack-flow-overlay")).toHaveCount(1);
});
