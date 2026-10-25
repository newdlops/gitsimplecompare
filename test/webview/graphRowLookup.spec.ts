import { expect, test } from "@playwright/test";
import { mountGraphRenderer } from "./webviewHarness";

test("shared row lookup follows metadata replacement, reorder and detached/virtual rows", async ({ page }) => {
  await mountGraphRenderer(page);
  const result = await page.evaluate(() => {
    const w = window as any, root = document.getElementById("graph-content")!;
    const rows = ["a", "b", "c"].map(hash => ({ hash, parents: [], refs: hash === "a" ? ["HEAD"] : [],
      subject: hash, authorName: "Fixture", authorEmail: "fixture@example.test", dateIso: "2026-10-25T00:00:00Z", color: 0, column: 0 }));
    const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data }));
    const state = { loadedCount: rows.length, loading: false, hasMore: false, colorScope: "/fixture/lookup" };
    send({ type: "graph", revision: 1, data: { rows, edges: [], laneCount: 1 }, state: { ...state, reset: true } });
    const lookup = (hash: string) => w.GscGraphRowSync.rowForHash(root, hash), first = lookup("a");
    send({ type: "graphDelta", delta: { baseRevision: 1, revision: 2, rowStart: rows.length, rows: [],
      rowUpdates: [{ index: 0, row: { ...rows[0], subject: "Changed" } }], edgeStart: 0, edges: [], edgeUpdates: [], laneCount: 1 }, state });
    const replacement = lookup("a"), replaced = replacement !== first && replacement.textContent.includes("Changed");
    send({ type: "graph", revision: 3, data: { rows: rows.slice().reverse(), edges: [], laneCount: 1 }, state: { ...state, reset: true } });
    const reordered = lookup("a"), newIndex = reordered.dataset.index;
    const virtual = reordered.cloneNode(true) as HTMLElement; virtual.dataset.reflogVirtual = "1";
    reordered.replaceWith(virtual);
    return { replaced, newIndex, detachedIgnored: !lookup("a"), missing: !lookup("unknown"), otherRoot: !w.GscGraphRowSync.rowForHash(document.body, "a") };
  });
  expect(result).toEqual({ replaced: true, newIndex: "2", detachedIgnored: true, missing: true, otherRoot: true });
});
