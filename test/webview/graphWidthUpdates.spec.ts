import { expect, test } from "@playwright/test";
import { mountReferenceGraph } from "./graphReferenceHarness";

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
    annotation.remove();
    const removedWidth = await resize();
    return { textWidth, textRight, restoredWidth, annotationWidth, annotationRight, changedAnnotationWidth, changedAnnotationRight, removedWidth };
  });
  expect(measured.textWidth).toBeGreaterThanOrEqual(measured.textRight);
  expect(measured.restoredWidth).toBeLessThan(measured.textWidth);
  expect(measured.annotationWidth).toBeGreaterThanOrEqual(measured.annotationRight);
  expect(measured.changedAnnotationWidth).toBeGreaterThanOrEqual(measured.changedAnnotationRight);
  expect(measured.removedWidth).toBeLessThan(measured.changedAnnotationWidth);
});
