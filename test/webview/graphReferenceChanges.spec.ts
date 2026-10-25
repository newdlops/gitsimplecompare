import { expect, test } from "@playwright/test";
import { mountReferenceGraph } from "./graphReferenceHarness";

for (const width of [390, 768, 1440]) {
  test(`changed branch and tag facts patch only dependent graph rows at ${width}px`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); });
    await mountReferenceGraph(page);
    await page.keyboard.press("Escape");
    await page.locator('#graph-content .row[data-index="1"] .commit-hash').click(); await page.keyboard.press("Escape");
    const measured = await page.evaluate(async () => {
      const w = window as any, fixture = w.__referenceFixture;
      w.__keptReferenceRow = document.querySelector('#graph-content .row[data-index="1500"]');
      fixture.badgeCalls = 0; fixture.resolverCalls = 0;
      const samples: number[] = [], painted: number[] = [];
      for (let round = 0; round < 3; round++) {
        const branches = structuredClone(fixture.branches), tags = structuredClone(fixture.tags);
        branches[0].current = round % 2 === 1; branches[1].current = round % 2 === 0;
        branches[1].ahead = round + 2; branches[1].subject = `Changed tooltip ${round}`;
        tags[0].remoteTargets[0].hash = (3000 + round).toString(16).padStart(40, "0");
        const start = performance.now();
        window.dispatchEvent(new MessageEvent("message", { data: { type: "branchStatus", branches, worktrees: [] } }));
        window.dispatchEvent(new MessageEvent("message", { data: { type: "tagStatus", tags } }));
        samples.push(+(performance.now() - start).toFixed(1));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        painted.push(+(performance.now() - start).toFixed(1));
      }
      return { badgeCalls: fixture.badgeCalls, resolverCalls: fixture.resolverCalls, samples, painted,
        kept: document.querySelector('#graph-content .row[data-index="1500"]') === w.__keptReferenceRow };
    });
    console.log(`[reference-changes:${width}] ${JSON.stringify(measured)}`);
    await info.attach("reference-change-metrics.json", { body: JSON.stringify(measured), contentType: "application/json" });
    expect(measured.kept).toBe(true);
    expect(measured.badgeCalls).toBeLessThanOrEqual(150);
    expect(measured.resolverCalls).toBe(0);
    await expect(page.locator('#graph-content .row.selected[data-index="1"]')).toHaveCount(1);
    await expect(page.locator('.ref.current-local[data-branch-name="bench-1"]')).toHaveCount(1);
    await expect(page.locator('.ref[data-branch-name="bench-1"]')).toHaveAttribute("data-tooltip", /Changed tooltip 2/);
    await expect(page.locator('#graph-content .row[data-index="3002"] [data-tag-name="release-0"][data-tag-remote="origin"]')).toHaveCount(1);
    await expect(page.locator('#graph-content .row[data-index="3000"] [data-tag-name="release-0"]')).toHaveCount(0);
    await expect(page.locator('#graph-content .row[data-index="3001"] [data-tag-name="release-0"]')).toHaveCount(0);
    await page.locator("#graph").evaluate(element => { element.scrollLeft = 0; });
    await page.screenshot({ path: info.outputPath(`reference-change-${width}.png`) });
    expect(errors).toEqual([]);
  });
}
