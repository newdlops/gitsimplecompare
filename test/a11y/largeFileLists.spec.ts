import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mountSlowRebase } from "../webview/lowEndHarness";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { mountChanges } from "../webview/webviewHarness";

test("virtual rebase file controls keep accessible names, list positions and keyboard focus", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await mountSlowRebase(page, 100, 500);
  await page.locator('.row[data-index="0"]').click();
  await page.evaluate(() => {
    const w = window as any, { hash, files } = w.__lowEnd;
    w.GscGraphRebaseContext.updateAction(hash, "edit");
    window.dispatchEvent(new MessageEvent("message", { data: { type: "commitDetail", detail: {
      hash, message: "Accessible file controls", authorName: "Fixture", authorEmail: "fixture@example.test",
      authorDateIso: "2026-10-16T00:00:00.000Z", parents: [], branches: [], files,
    } } }));
  });
  const results = await new AxeBuilder({ page }).include(".rebase-detail-editor").analyze();
  expect(results.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
  const button = page.locator('.rebase-detail-files .file-row[data-file-index="0"] [data-exclude="commit"]');
  await button.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(button).toBeFocused();
  expect(await button.evaluate(element => element.matches(":focus-visible"))).toBe(true);
  await button.hover();
  await expect(page.getByRole("tooltip")).toContainText("Remove this file change");
  await expect(button.locator("..").locator("..")).toHaveAttribute("aria-setsize", "500");
});

test("virtual comparison names and explicit diff buttons pass the production accessibility audit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture: any = await loadWebviewFixture("changes.small.en.json");
  const nodes = Array.from({ length: 500 }, (_, index) => ({ kind: "file", change: {
    status: "M", path: `src/file-${index}.ts`, additions: 2, deletions: 1,
  } }));
  await mountChanges(page, { ...fixture, payload: { ...fixture.payload, compare: {
    mode: "comparison", from: "main", to: "feature/accessibility", nodes, viewMode: "list",
  } } });
  const results = await new AxeBuilder({ page }).include("#root").analyze();
  expect(results.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
});
