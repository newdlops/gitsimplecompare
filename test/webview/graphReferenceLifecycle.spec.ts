import { expect, test } from "@playwright/test";
import { mountReferenceGraph } from "./graphReferenceHarness";
import { readPostedMessages } from "./webviewHarness";

test("reference updates follow reordered and reset models while preserving reflog overlays and ref actions", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", error => { errors.push(error.message); });
  await mountReferenceGraph(page);
  await page.evaluate(() => {
    const w = window as any, hash = (index: number) => index.toString(16).padStart(40, "0");
    const row = (index: number, refs: string[], localOnlyBranches: string[] = []) => ({ hash: hash(index), refs, localOnlyBranches,
      parents: [], subject: `Lifecycle ${index}`, color: 0, column: 0, authorName: "Fixture", dateIso: "2026-10-17T00:00:00Z" });
    w.__referenceRows = [row(1, ["bench-1"]), row(4000, [], ["bench-0", "bench-1"]), row(0, ["bench-0"])];
    w.__sendReferenceGraph = (rows: unknown[]) => window.dispatchEvent(new MessageEvent("message", { data: { type: "graph",
      data: { rows, edges: [], laneCount: 1 }, state: { loadedCount: rows.length, reset: true, loading: false, hasMore: false, hasMoreBefore: false } } }));
    w.__sendReferenceGraph(w.__referenceRows);
    const overlay = document.createElement("div");
    overlay.className = "row reflog-virtual-row"; overlay.dataset.index = "0"; overlay.dataset.reflogVirtual = "1";
    overlay.dataset.hash = "virtual"; overlay.textContent = "Existing reflog annotation";
    document.getElementById("graph-content")!.append(overlay); w.__keptReferenceOverlay = overlay;
    const branches = structuredClone(w.__referenceFixture.branches);
    branches[0].subject = "Updated after reordering";
    window.dispatchEvent(new MessageEvent("message", { data: { type: "branchStatus", branches, worktrees: [] } }));
    branches.push({ name: "new-color-branch", current: false, hash: hash(4001) });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "branchStatus", branches, worktrees: [] } }));
  });
  await expect(page.locator('#graph-content .row[data-index="2"] [data-branch-name="bench-0"]')).toHaveAttribute("data-tooltip", /Updated after reordering/);
  expect(await page.evaluate(() => document.querySelector('[data-reflog-virtual="1"]') === (window as any).__keptReferenceOverlay)).toBe(true);

  await page.evaluate(() => {
    const w = window as any;
    w.__sendReferenceGraph([]);
    const branches = structuredClone(w.__referenceFixture.branches); branches[0].subject = "Changed while empty";
    window.dispatchEvent(new MessageEvent("message", { data: { type: "branchStatus", branches, worktrees: [] } }));
  });
  await expect(page.locator("#graph-content .row")).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any; w.__sendReferenceGraph([...w.__referenceRows].reverse());
    const branches = structuredClone(w.__referenceFixture.branches); branches[0].subject = "Updated after reset";
    window.dispatchEvent(new MessageEvent("message", { data: { type: "branchStatus", branches, worktrees: [] } }));
  });
  const chip = page.locator('#graph-content .row[data-index="0"] [data-branch-name="bench-0"]');
  await expect(chip).toHaveAttribute("data-tooltip", /Updated after reset/);
  await expect(chip).toHaveRole("button"); await expect(chip).toHaveAccessibleName("Branch actions for bench-0");
  await page.keyboard.press("Escape"); await chip.focus(); await expect(chip).toBeFocused(); await chip.press("Enter");
  expect((await readPostedMessages(page)).some((message: any) => message.type === "branchAction" && message.branch === "bench-0")).toBe(true);
  expect(errors).toEqual([]);
});
