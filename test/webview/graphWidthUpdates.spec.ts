import { expect, test, type Page } from "@playwright/test";
import { mountReferenceGraph } from "./graphReferenceHarness";

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on("pageerror", error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

test("unchanged resize and short row replacements avoid another full width-candidate traversal", async ({ page }, info) => {
  test.setTimeout(90_000);
  await mountReferenceGraph(page);
  const measured = await page.evaluate(async () => {
    const root = document.getElementById("graph-content")!;
    /** 기존 예약 frame과 이번 폭 측정을 분리하고 실제 렌더된 폭만 읽는다. */
    const resize = async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    };
    await resize();
    const query = Element.prototype.querySelectorAll;
    let fullTraversals = 0;
    Element.prototype.querySelectorAll = function (selector: string) {
      if (this === root && selector === ":scope > .row") fullTraversals++;
      return query.call(this, selector);
    } as typeof query;
    try {
      for (let index = 0; index < 3; index++) await resize();
      const unchanged = fullTraversals;
      root.querySelector('.row[data-index="0"]')!.classList.toggle("selected");
      root.querySelector('.row[data-index="4000"]')!.classList.toggle("search-hit");
      await resize();
      const afterDecorations = fullTraversals;
      const old = root.querySelector('.row[data-index="4000"]')!, replacement = old.cloneNode(true) as HTMLElement;
      replacement.textContent = "short"; old.replaceWith(replacement);
      await resize();
      return { unchanged, afterDecorations, afterShortReplacement: fullTraversals, width: parseFloat(root.style.width),
        right: replacement.offsetLeft + replacement.scrollWidth };
    } finally { Element.prototype.querySelectorAll = query; }
  });
  await info.attach("width-candidate-traversals.json", { body: JSON.stringify(measured), contentType: "application/json" });
  expect(measured.unchanged).toBe(0);
  expect(measured.afterDecorations).toBe(0);
  expect(measured.afterShortReplacement).toBe(0);
  expect(measured.width).toBeGreaterThanOrEqual(measured.right);
});

test("a small reference change reuses width scores from unchanged graph rows", async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountReferenceGraph(page);
  const measured = await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const w = window as any, root = document.getElementById("graph-content")!;
    const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!;
    let rowTextReads = 0;
    Object.defineProperty(Node.prototype, "textContent", { ...descriptor, get() {
      if (this.parentElement === root && this.classList?.contains("row")) rowTextReads++;
      return descriptor.get!.call(this);
    } });
    const tags = structuredClone(w.__referenceFixture.tags);
    tags[0].remoteTargets[0].hash = (3000).toString(16).padStart(40, "0");
    const start = performance.now();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "tagStatus", tags } }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { rowTextReads, paintedMs: +(performance.now() - start).toFixed(1), width: root.style.width };
  });
  console.log(`[graph-width-update] ${JSON.stringify(measured)}`);
  await info.attach("width-update-metrics.json", { body: JSON.stringify(measured), contentType: "application/json" });
  await expect(page.locator('#graph-content > .row[data-index="3000"] [data-tag-name="release-0"]')).toHaveCount(1);
  expect(measured.rowTextReads).toBeLessThanOrEqual(20);
});

test("in-place row edits and reflog-style annotations invalidate width scores before the next resize", async ({ page }) => {
  test.setTimeout(90_000);
  await mountReferenceGraph(page);
  const measured = await page.evaluate(async () => {
    const root = document.getElementById("graph-content")!, row = root.querySelector('.row[data-index="4000"]') as HTMLElement;
    const subject = row.querySelector(".subject")!;
    /** DOM 변경이 observer에 전달되고 실제 폭 측정 frame이 끝날 때까지 기다린다. */
    const resize = async () => {
      window.dispatchEvent(new Event("resize"));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return parseFloat(root.style.width);
    };
    await resize();
    const original = subject.textContent!;
    subject.firstChild!.textContent = "A long edited subject ".repeat(200);
    const textWidth = await resize(), textRight = row.offsetLeft + row.scrollWidth;
    subject.replaceChildren(document.createTextNode(original));
    const restoredWidth = await resize();
    const annotation = document.createElement("div"); annotation.className = "row reflog-virtual-row";
    annotation.dataset.reflogVirtual = "1"; annotation.style.left = "600px";
    annotation.textContent = "Recovery annotation ".repeat(250); root.append(annotation);
    const annotationWidth = await resize(), annotationRight = annotation.offsetLeft + annotation.scrollWidth;
    annotation.replaceChildren(document.createTextNode("An even longer annotation ".repeat(350)));
    const changedAnnotationWidth = await resize(), changedAnnotationRight = annotation.offsetLeft + annotation.scrollWidth;
    annotation.classList.remove("row");
    const excludedWidth = await resize();
    annotation.classList.add("row");
    const includedWidth = await resize();
    annotation.remove();
    const removedWidth = await resize();
    root.replaceChildren();
    const emptyWidth = await resize();
    const first = document.createElement("div"); first.className = "row"; first.style.left = "52px";
    first.textContent = "First row after a complete graph replacement ".repeat(100); root.append(first);
    const firstWidth = await resize(), firstRight = first.offsetLeft + first.scrollWidth;
    return { textWidth, textRight, restoredWidth, annotationWidth, annotationRight, changedAnnotationWidth, changedAnnotationRight,
      excludedWidth, includedWidth, removedWidth, emptyWidth, firstWidth, firstRight };
  });
  expect(measured.textWidth).toBeGreaterThanOrEqual(measured.textRight);
  expect(measured.restoredWidth).toBeLessThan(measured.textWidth);
  expect(measured.annotationWidth).toBeGreaterThanOrEqual(measured.annotationRight);
  expect(measured.changedAnnotationWidth).toBeGreaterThanOrEqual(measured.changedAnnotationRight);
  expect(measured.excludedWidth).toBeLessThan(measured.changedAnnotationWidth);
  expect(measured.includedWidth).toBe(measured.changedAnnotationWidth);
  expect(measured.removedWidth).toBeLessThan(measured.changedAnnotationWidth);
  expect(measured.emptyWidth).toBeLessThan(measured.removedWidth);
  expect(measured.firstWidth).toBeGreaterThanOrEqual(measured.firstRight);
});
