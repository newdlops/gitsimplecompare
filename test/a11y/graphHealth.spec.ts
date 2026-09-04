import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { dispatchWebviewMessage, mountGraphRenderer } from "../webview/webviewHarness";

/** Axe 위반을 규칙과 영향 노드 수만 남겨 테스트 실패에서 바로 읽을 수 있게 만든다. */
function violationSummary(results: { violations: Array<{ id: string; nodes: unknown[] }> }): string {
  return results.violations.map((item) => `${item.id}:${item.nodes.length}`).join(", ");
}

test("Graph ref health warning supports Axe, live announcements, and keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await mountGraphRenderer(page);
  await dispatchWebviewMessage(page, {
    type: "graphHealth",
    notice: {
      level: "warning",
      title: "Damaged local branch refs were skipped (1).",
      detail: "The remaining graph is available. Restore or delete these refs, then refresh.",
      items: [{ label: "broken-local", description: "refs/heads/broken-local → missing-object" }],
    },
  });

  const health = page.locator("#graph-health");
  await expect(health).toHaveAttribute("role", "status");
  await expect(health).toHaveAttribute("aria-live", "polite");
  const output = page.getByRole("button", { name: "Show Git Simple Compare Output" });
  await output.focus();
  await expect(output).toBeFocused();
  const axe = await new AxeBuilder({ page }).include("#graph-pane").analyze();
  expect(axe.violations, violationSummary(axe)).toEqual([]);

  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  expect(await output.evaluate((element) => ({
    focus: element.matches(":focus-visible"),
    outline: getComputedStyle(element).outlineStyle,
  }))).toEqual({ focus: true, outline: expect.not.stringMatching("none") });
});
