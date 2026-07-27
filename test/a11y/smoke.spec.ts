// PR-00 접근성 smoke: fixture로 mount한 실제 Review renderer의 기본 자동 규칙을 검사한다.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { mountReviews, mountReviewWorkspace } from "../webview/webviewHarness";

/** Axe 결과를 사람이 읽을 수 있는 CSS target과 함께 assertion 오류로 바꾼다. */
function violationSummary(violations: ReadonlyArray<{ id: string; nodes: ReadonlyArray<{ target: readonly string[] }> }>): string {
  return violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`).join("\n");
}

test("Reviews populated management fixture는 자동 a11y 위반이 없다", async ({ page }) => {
  const fixture = await loadWebviewFixture("reviews.management.ko.json");
  await page.setViewportSize(fixture.viewport);
  await mountReviews(page, fixture);
  await page.getByRole("tab", { name: /Management/ }).click();

  const results = await new AxeBuilder({ page }).include("#root").analyze();
  expect(results.violations, violationSummary(results.violations)).toEqual([]);
});

test("Review Workspace error fixture는 alert와 retry action을 제공한다", async ({ page }) => {
  const fixture = await loadWebviewFixture("review-workspace.error.en.json");
  await page.setViewportSize(fixture.viewport);
  await mountReviewWorkspace(page, fixture);

  await expect(page.getByRole("alert")).toContainText("Fixture permission error");
  await expect(page.getByRole("button", { name: "Retry loading review" })).toBeVisible();
  const results = await new AxeBuilder({ page }).include("#root").analyze();
  expect(results.violations, violationSummary(results.violations)).toEqual([]);
});

test("공통 surface는 forced-colors에서 native control과 keyboard focus를 유지한다", async ({ page }) => {
  const fixture = await loadWebviewFixture("reviews.management.ko.json");
  await page.emulateMedia({ forcedColors: "active" });
  await page.setViewportSize(fixture.viewport);
  await mountReviews(page, fixture);

  const refresh = page.getByRole("button", { name: /Refresh/ });
  await refresh.focus();
  await expect(refresh).toBeFocused();
  await expect(refresh).toHaveCSS("forced-color-adjust", "auto");
  expect(await refresh.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
});

test("Reviews cached count summary는 tabpanel·retry action을 접근 가능하게 제공한다", async ({ page }) => {
  const fixture = await loadWebviewFixture("reviews.cached.en.json");
  await page.setViewportSize(fixture.viewport);
  await mountReviews(page, fixture);

  await expect(page.getByRole("tabpanel", { name: "Cached review summary" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry loading pull request reviews" })).toBeVisible();
  const results = await new AxeBuilder({ page }).include("#root").analyze();
  expect(results.violations, violationSummary(results.violations)).toEqual([]);
});

test("Reviews auth shell은 sign-in과 diagnostics action을 접근 가능하게 제공한다", async ({ page }) => {
  const fixture = await loadWebviewFixture("reviews.auth-required.en.json");
  await page.setViewportSize(fixture.viewport);
  await mountReviews(page, fixture);

  await expect(page.getByRole("button", { name: "Start GitHub CLI sign-in in a terminal" })).toBeVisible();
  const results = await new AxeBuilder({ page }).include("#root").analyze();
  expect(results.violations, violationSummary(results.violations)).toEqual([]);
});
