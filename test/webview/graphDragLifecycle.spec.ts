import { expect, test, type Locator, type Page } from "@playwright/test";
import { mountReferenceGraph } from "./graphReferenceHarness";

/** 실제 마우스로 pointer capture가 있는 drag를 수행한다. @returns release 뒤 마지막 frame까지 기다린다. */
async function drag(page: Page, handle: Locator) {
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox(); expect(box).not.toBeNull();
  const x = box!.x + Math.min(20, box!.width / 2), y = box!.y + box!.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 42, y + 18, { steps: 3 }); await page.mouse.up();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** 실제 fixture 위에서 drag 이벤트와 오류를 관찰한다. 계측은 성능 비교와 별개다. */
async function mount(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountReferenceGraph(page, true, 1); await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const w: any = window; w.__dragEvents = [];
    for (const name of ["gsc-node-drag-start", "gsc-node-drag", "gsc-node-drag-end"]) {
      window.addEventListener(name, (event: Event) => w.__dragEvents.push({ name, ...(event as CustomEvent).detail }));
    }
  });
}

test("row and SVG node drag retain pointer lifecycle and existing preview transforms after a full refresh", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await mount(page);
  const hash = (1500).toString(16).padStart(40, "0"), row = page.locator(`.row[data-hash="${hash}"]`);
  const node = page.locator(`.node[data-hash="${hash}"]`);
  await node.evaluate(element => element.setAttribute("transform", "translate(3 4)"));
  await drag(page, row.locator(".commit-hash"));
  let events = await page.evaluate(() => (window as any).__dragEvents);
  expect(events[0]).toMatchObject({ name: "gsc-node-drag-start", hash });
  expect(events.at(-1)).toMatchObject({ name: "gsc-node-drag-end", hash, dx: 42, dy: 18 });
  expect(events.filter((event: any) => event.name === "gsc-node-drag").length).toBeGreaterThan(0);
  await expect(node).toHaveAttribute("transform", "translate(3 4)");
  await expect(node).not.toHaveClass(/dragging-node/); await expect(row).not.toHaveClass(/dragging-row/);
  await page.evaluate(() => {
    const w: any = window; w.__dragEvents = [];
    window.dispatchEvent(new MessageEvent("message", { data: { type: "graph", data: {
      rows: w.__referenceFixture.rows, edges: w.__referenceFixture.edges, laneCount: 1 },
      state: { reset: true, loadedCount: 5000, hasMore: false, hasMoreBefore: false, loading: false, colorScope: "/fixture/references" } } }));
  });
  await drag(page, node);
  events = await page.evaluate(() => (window as any).__dragEvents);
  expect(events.filter((event: any) => event.name === "gsc-node-drag-start")).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ name: "gsc-node-drag-end", hash, dx: 42, dy: 18 });
  await expect(node).not.toHaveAttribute("transform", /translate/);
  expect(errors).toEqual([]);
});

test("ref chips, row action buttons, right clicks and reflog virtual rows keep their own interactions", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const root = document.getElementById("graph-content")!;
    const row = root.querySelector('.row[data-index="2"]')!;
    const button = document.createElement("button"); button.textContent = "Row action"; button.title = "Row action";
    button.setAttribute("aria-label", "Row action"); row.append(button);
    const virtual = row.cloneNode(true) as HTMLElement;
    virtual.dataset.reflogVirtual = "1"; virtual.dataset.hash = "recovery"; virtual.style.top = "90px";
    root.append(virtual);
  });
  await page.locator('.row[data-index="2"]:not([data-reflog-virtual]) [data-branch-name="bench-2"]').click();
  await page.getByRole("button", { name: "Row action", exact: true }).first().click();
  await page.locator('.row[data-index="4"] .commit-hash').click({ button: "right" });
  await page.locator('.row[data-reflog-virtual] .commit-hash').click();
  expect(await page.evaluate(() => (window as any).__dragEvents)).toEqual([]);
});
