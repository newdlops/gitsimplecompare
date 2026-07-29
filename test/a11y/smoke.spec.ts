import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { dispatchWebviewMessage, mountChanges, mountPullRequestPreview, readPostedMessages } from "../webview/webviewHarness";

/** 실패한 Axe 규칙을 사람이 바로 확인할 수 있게 짧게 요약한다. */
function violationSummary(results: { violations: Array<{ id: string; nodes: unknown[] }> }): string { return results.violations.map((item) => `${item.id}:${item.nodes.length}`).join(", "); }

test("Changes production renderer supports Axe, keyboard, forced colors, and reduced motion", async ({ page }) => {
  const fixture = await loadWebviewFixture("changes.small.en.json");
  await page.setViewportSize(fixture.viewport);
  await mountChanges(page, fixture);
  const row = page.locator('.section[data-section="changes"] #changes-group-files-staged .row.file[data-stage="staged"][data-path="src/app.ts"] > .name');
  await expect(row).toBeVisible();
  await expect(page.locator("#section-body-history")).toHaveAttribute("tabindex", "0");
  await expect(page.locator("#section-body-stashes")).toHaveAttribute("tabindex", "0");
  const axe = await new AxeBuilder({ page }).include("#root").analyze();
  expect(axe.violations, violationSummary(axe)).toEqual([]);
  const header = page.locator('.section[data-section="changes"] > .section-header');
  await expect(header).toHaveAttribute("aria-expanded", "true"); await header.press("Enter"); await expect(header).toHaveAttribute("aria-expanded", "false"); await header.press(" "); await expect(header).toHaveAttribute("aria-expanded", "true");
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" }); await page.locator('.section[data-section="history"] > .section-header').focus(); await page.keyboard.press("Tab"); const focusedBody=page.locator("#section-body-history"); await expect(focusedBody).toBeFocused();
  expect(await page.evaluate(() => ({ forced: matchMedia("(forced-colors: active)").matches, reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, focus: document.activeElement?.matches(":focus-visible"), style: getComputedStyle(document.activeElement!).outlineStyle, adjust: getComputedStyle(document.activeElement!).forcedColorAdjust }))).toEqual({ forced: true, reduced: true, focus: true, style: expect.not.stringMatching("none"), adjust: "auto" });
  await dispatchWebviewMessage(page, { type:"workingOperation", active:true, action:"unstage", paths:["src/app.ts"], phase:"git" });
  await expect(page.locator(".working-op-track > span")).toHaveCSS("animation-duration", "0.001s"); await expect(page.locator(".working-op-track > span")).toHaveCSS("animation-iteration-count", "1");
});

test("Preview production renderer supports Axe and toolbar keyboard order", async ({ page }) => {
  const fixture = await loadWebviewFixture("pr-preview.populated.en.json"); await page.setViewportSize(fixture.viewport); await mountPullRequestPreview(page, fixture);
  const create = page.getByRole("button", { name:"Create Pull Request on GitHub" });
  await create.focus(); await expect(create).toBeFocused(); await page.keyboard.press("Enter");
  await expect.poll(() => readPostedMessages(page)).toContainEqual({ type:"publishPullRequest", sourceBranch:fixture.payload.sourceBranch, targetBranch:fixture.payload.targetBranch, title:fixture.payload.title, body:fixture.payload.body });
  await dispatchWebviewMessage(page,{type:"preview",preview:{...fixture.payload,existingPr:{number:1,url:"https://example.test/pr/1"}}});
  const open = page.getByRole("button", { name:"Open pull request on GitHub" }); await expect(page.locator("#pr-preview-tabpanel")).toBeVisible(); await expect(open).toBeVisible();
  const axe = await new AxeBuilder({ page }).include("#content").analyze(); expect(axe.violations, violationSummary(axe)).toEqual([]);
  await page.locator("#refresh").focus(); for (const selector of ["#generate-pr-message", "#configure-ai-cli", "#copy-pr-message", "#open-pr"]) { await page.keyboard.press("Tab"); await expect(page.locator(selector)).toBeFocused(); }
  await page.keyboard.press("Enter"); await expect.poll(() => readPostedMessages(page)).toContainEqual({ type:"openExistingPr" });
  await page.emulateMedia({ forcedColors:"active", reducedMotion:"reduce" }); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab"); await expect(open).toBeFocused();
  expect(await page.evaluate(() => ({ forced: matchMedia("(forced-colors: active)").matches, reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, focus: document.activeElement?.matches(":focus-visible"), style: getComputedStyle(document.activeElement!).outlineStyle, adjust: getComputedStyle(document.activeElement!).forcedColorAdjust }))).toEqual({ forced:true, reduced:true, focus:true, style:expect.not.stringMatching("none"), adjust:"auto" });
  await expect(page.locator("#pr-preview-tab-conversation")).toHaveCSS("animation-duration", "0.001s"); await expect(page.locator("#pr-preview-tab-conversation")).toHaveCSS("animation-iteration-count", "1");
});
