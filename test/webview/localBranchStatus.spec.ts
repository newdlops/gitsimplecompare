import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { branchInspection, mountStaleBranches } from "./staleBranchHarness";
import { dispatchWebviewMessage, readPostedMessages } from "./webviewHarness";

for (const locale of ["en", "ko"] as const) for (const width of [390, 768, 1440]) {
  test(`local branch status, filtering and protected selection ${locale} ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await mountStaleBranches(page, locale);
    await expect(page.locator(".branch-row")).toHaveCount(6);
    await expect(page.locator("#summary")).toHaveText(locale === "ko" ? "로컬 6개 · stale 4개 · 삭제 가능 3개" : "6 local · 4 stale · 3 removable");
    await expect(page.locator(".branch-row input:disabled")).toHaveCount(3);
    await expect(page.locator('[data-branch="main"] .branch-protection')).toContainText(locale === "ko" ? "현재 브랜치" : "Current branch");
    await expect(page.locator('[data-branch="feature/in-worktree"] .branch-protection')).toContainText("/worktrees/active feature");
    await expect(page.locator(".branch-row img, .branch-row script")).toHaveCount(0);
    await expect(page.locator("#review")).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const initial = testInfo.outputPath(`local-branches-${locale}-${width}-initial.png`);
    await page.screenshot({ path: initial });
    await testInfo.attach("local-branch-status", { path: initial, contentType: "image/png" });

    await page.locator("#filter").selectOption("stale");
    await expect(page.locator(".branch-row:visible")).toHaveCount(4);
    await page.locator("#select-visible").check();
    await expect(page.locator(".branch-row input:checked")).toHaveCount(3);
    await page.locator("#filter").selectOption("all");
    await page.locator("#search").fill("main");
    await expect(page.locator(".branch-row:visible")).toHaveCount(1);
    await expect(page.locator("#hidden-selection")).toContainText("3");
    await expect(page.locator("#select-visible")).toBeDisabled();
    await page.locator("#clear").click();
    await expect(page.locator("#review")).toBeDisabled();
    await expect(page.locator("#hidden-selection")).toBeHidden();
    await page.locator("#search").fill("");
    const chosen = page.locator('[data-branch="feature/finished-local"] input');
    await chosen.focus();
    await page.keyboard.press("Space");
    await expect(chosen).toBeChecked();
    await expect(page.locator("#review")).toBeEnabled();
    await page.mouse.move(width - 2, 2);
    // 공용 tooltip의 Escape 닫기도 검증한 뒤 안정된 페이지 영역을 접근성 검사한다.
    await page.keyboard.press("Escape");
    await expect(page.locator(".gsc-instant-tooltip")).toBeHidden();
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
    const selected = testInfo.outputPath(`local-branches-${locale}-${width}-selected.png`);
    await page.screenshot({ path: selected });
    await testInfo.attach("local-branch-selection", { path: selected, contentType: "image/png" });
    await page.locator("#review").click();
    await expect(page.locator("#review")).toHaveAttribute("aria-busy", "true");
    expect(await readPostedMessages(page)).toContainEqual({ type: "select", names: ["feature/finished-local"] });
    await dispatchWebviewMessage(page, { type: "error", message: "Selection changed; review again." });
    await expect(page.locator("#error")).toHaveText("Selection changed; review again.");
    await expect(page.locator("#review")).toBeEnabled();
    await expect(chosen).toBeChecked();
    expect(errors).toEqual([]);
  });
}

test("no remotes keeps all local branches visible as unchecked and blocks all selection", async ({ page }) => {
  const snapshot = branchInspection();
  snapshot.remotes = [];
  snapshot.branches = [];
  snapshot.localBranches = snapshot.localBranches.map(branch => ({ ...branch, remoteState: "unconfigured", matchingRemotes: [] }));
  await mountStaleBranches(page, "en", snapshot);
  await expect(page.locator(".branch-row")).toHaveCount(6);
  await expect(page.locator(".branch-row input:disabled")).toHaveCount(6);
  await expect(page.locator("#notice")).toContainText("stale status cannot be checked");
  await expect(page.locator(".branch-status").first()).toHaveText("Not checked");
  await page.locator("#cancel").click();
  expect(await readPostedMessages(page)).toEqual([{ type: "cancel" }]);
});

test("an all-protected stale snapshot remains visible with its protection reason", async ({ page }) => {
  const snapshot = branchInspection();
  snapshot.localBranches = snapshot.localBranches.filter(branch => branch.name === "feature/in-worktree");
  snapshot.branches = snapshot.localBranches;
  await mountStaleBranches(page, "en", snapshot);
  await expect(page.locator(".branch-row")).toHaveCount(1);
  await expect(page.locator("#notice")).toContainText("in use by worktrees");
  await expect(page.locator("#select-visible")).toBeDisabled();
  await expect(page.locator("#review")).toBeDisabled();
});

test("no stale branches and no search matches are distinct from no local branches", async ({ page }) => {
  const snapshot = branchInspection();
  snapshot.localBranches = snapshot.localBranches.filter(branch => branch.remoteState === "present");
  snapshot.branches = [];
  await mountStaleBranches(page, "en", snapshot);
  await expect(page.locator("#notice")).toContainText("Every local branch name exists on a remote");
  await expect(page.locator(".branch-row:visible")).toHaveCount(2);
  await page.locator("#search").fill("does-not-exist");
  await expect(page.locator("#empty")).toHaveText("No local branches match this search or filter.");
});

test("an empty local repository has an explicit empty state and no deletion action", async ({ page }) => {
  const snapshot = { ...branchInspection(), localBranches: [], branches: [] };
  await mountStaleBranches(page, "en", snapshot);
  await expect(page.locator("#empty")).toHaveText("No local branches found.");
  await expect(page.locator("#review")).toBeDisabled();
});

test("dense local branch data can be searched and selected without adding remote-only rows", async ({ page }) => {
  const snapshot = branchInspection();
  snapshot.localBranches = Array.from({ length: 1000 }, (_, index) => ({ ...snapshot.localBranches[0], name: `local/branch-${index}` }));
  snapshot.branches = snapshot.localBranches;
  await mountStaleBranches(page, "en", snapshot);
  await expect(page.locator(".branch-row")).toHaveCount(1000);
  await page.locator("#search").fill("local/branch-999");
  await expect(page.locator(".branch-row:visible")).toHaveCount(1);
  await page.locator("#select-visible").check();
  await page.locator("#review").click();
  expect(await readPostedMessages(page)).toContainEqual({ type: "select", names: ["local/branch-999"] });
});
