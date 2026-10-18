import { expect, test } from "@playwright/test";
import { dispatchWebviewMessage } from "./webviewHarness";
import { mountReferenceGraph } from "./graphReferenceHarness";

for (const width of [390, 768, 1440]) {
  test(`repeated reference snapshots preserve a dense graph without recomputing badges at ${width}px`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); });
    await mountReferenceGraph(page);
    await page.keyboard.press("Escape");
    await page.locator('#graph-content > .row[data-index="1"] .commit-hash').click(); await page.keyboard.press("Escape");
    await page.locator("#graph").evaluate(element => { element.scrollTop = 4000; });
    const before = await page.locator("#graph").evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }));
    const measured = await page.evaluate(() => {
      const w = window as any, fixture = w.__referenceFixture;
      fixture.badgeCalls = 0; fixture.resolverCalls = 0;
      const samples: number[] = [];
      for (let round = 0; round < 3; round++) {
        const start = performance.now();
        for (const data of [{ type: "branchStatus", branches: fixture.branches, worktrees: [] }, { type: "tagStatus", tags: fixture.tags }]) {
          window.dispatchEvent(new MessageEvent("message", { data: structuredClone(data) }));
        }
        samples.push(+(performance.now() - start).toFixed(1));
      }
      return { badgeCalls: fixture.badgeCalls, resolverCalls: fixture.resolverCalls, samples };
    });
    console.log(`[reference-updates:${width}] ${JSON.stringify(measured)}`);
    expect(measured.badgeCalls).toBe(0); expect(measured.resolverCalls).toBe(0);
    await info.attach("reference-update-metrics.json", { body: JSON.stringify(measured), contentType: "application/json" });
    expect(await page.locator("#graph").evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }))).toEqual(before);
    await expect(page.locator('#graph-content > .row.selected[data-index="1"]')).toHaveCount(1);
    const changed = await page.evaluate(() => {
      const fixture = (window as any).__referenceFixture;
      const branches = structuredClone(fixture.branches), tags = structuredClone(fixture.tags);
      branches[0].current = false; branches[1].current = true; branches[1].ahead = 2; branches[1].subject = "Updated branch tooltip";
      tags[0].remoteTargets[0].hash = (3000).toString(16).padStart(40, "0");
      return { branches, tags };
    });
    await dispatchWebviewMessage(page, { type: "branchStatus", branches: changed.branches, worktrees: [] });
    await dispatchWebviewMessage(page, { type: "tagStatus", tags: changed.tags });
    await expect(page.locator('.ref.current-local[data-branch-name="bench-1"]')).toHaveCount(1);
    await expect(page.locator('.ref[data-branch-name="bench-1"]')).toHaveAttribute("data-tooltip", /Updated branch tooltip/);
    await expect(page.locator('.ref.tag-diverged[data-tag-name="release-0"][data-tag-local="1"]')).toHaveCount(1);
    await expect(page.locator('#graph-content > .row[data-index="3000"] [data-tag-name="release-0"][data-tag-remote="origin"]')).toHaveCount(1);
    await page.locator('#graph-content > .row[data-index="0"]').scrollIntoViewIfNeeded();
    await page.locator("#graph").evaluate(element => { element.scrollLeft = 0; });
    await page.screenshot({ path: info.outputPath(`reference-update-${width}.png`) });
    expect(errors).toEqual([]);
  });
}
