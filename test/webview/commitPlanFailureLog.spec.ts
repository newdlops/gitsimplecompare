import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { dispatchWebviewMessage, readPostedMessages } from "./webviewHarness";
import { failSecondCommit, mountCommitPlan } from "./commitPlanHarness";

const failureId = "11111111-1111-1111-1111-111111111111";
const nextId = "22222222-2222-2222-2222-222222222222";
const logText = "pre-commit: validation started\n  preserve indentation\n\n<img src=x onerror=alert(1)>\n" +
  Array.from({ length: 160 }, (_, i) => `src/long/path/${"validation-".repeat(14)}${i}.ts:12:4 오류: unexpected value`).join("\n") + "\nFINAL FAILURE";

for (const locale of ["en", "ko"] as const) for (const width of [390, 768, 1440]) {
  test(`failed commit log reads, toggles and copies with feedback ${locale} ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await mountCommitPlan(page, locale, locale === "ko");
    await failSecondCommit(page, { id: failureId, text: logText, canCopy: true, truncated: true });
    await expect(page.locator('.commit-group[data-index="1"]')).toHaveAttribute("data-execution-state", "hookFailed");
    await expect(page.locator(".execution-failure-title")).toContainText(locale === "ko" ? "2번째 커밋" : "Commit 2");
    const preview = page.locator("#commit-failure-log-text");
    await expect(preview).toHaveText(logText);
    await expect(page.locator(".execution-log img, .execution-log script")).toHaveCount(0);
    await expect(page.locator('[role="alert"] .execution-log')).toHaveCount(0);
    expect(await preview.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const copyName = locale === "ko" ? "로그 복사" : "Copy log";
    const copy = page.getByRole("button", { name: copyName, exact: true });
    await expect(copy).toHaveAttribute("title", copyName);
    await expect(copy).toHaveAttribute("data-tooltip", copyName);
    await copy.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: locale === "ko" ? "복사 중…" : "Copying…", exact: true })).toBeDisabled();
    const requests = (await readPostedMessages(page)).filter((message: any) => message.type === "copyFailureLog");
    expect(requests).toEqual([{ type: "copyFailureLog", failureId }]);
    await dispatchWebviewMessage(page, { type: "failureLogCopied", failureId, success: false, message: "Clipboard temporarily unavailable" });
    await expect(page.locator(".execution-log-copy-status")).toHaveText("Clipboard temporarily unavailable");
    await expect(preview).toHaveText(logText);
    await copy.click();
    await dispatchWebviewMessage(page, { type: "failureLogCopied", failureId, success: true,
      message: locale === "ko" ? "커밋 로그를 클립보드에 복사했습니다." : "Commit log copied to clipboard." });
    await expect(copy).toBeEnabled();
    await expect(page.locator(".execution-log-copy-status")).toHaveAttribute("data-kind", "success");
    const hide = page.getByRole("button", { name: locale === "ko" ? "로그 접기" : "Hide log", exact: true });
    await hide.focus();
    await page.keyboard.press("Enter");
    await expect(preview).toBeHidden();
    await expect(copy).toBeVisible();
    const show = page.getByRole("button", { name: locale === "ko" ? "로그 펼치기" : "Show log", exact: true });
    await expect(show).toHaveAttribute("aria-expanded", "false");
    await show.click();
    await expect(preview).toBeVisible();
    await page.locator(".execution-failure").scrollIntoViewIfNeeded();
    await page.mouse.move(width - 2, 2);
    expect(await page.locator(".execution-log").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    const layout = await page.evaluate(() => ({
      viewport: innerWidth, width: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll("body, .topbar, main, .actionbar, .execution-status, .execution-log")].map(el => {
        const rect = el.getBoundingClientRect();
        return { element: el.className || el.tagName, left: rect.left, right: rect.right, width: rect.width };
      }),
    }));
    expect(layout.width, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport);
    const axe = await new AxeBuilder({ page }).include(".execution-log").analyze();
    expect(axe.violations).toEqual([]);
    const screenshot = testInfo.outputPath(`commit-failure-log-${locale}-${width}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach("commit-failure-log", { path: screenshot, contentType: "image/png" });
    expect(errors).toEqual([]);
  });
}

test("new execution clears the old log and ignores its delayed copy reply", async ({ page }) => {
  await mountCommitPlan(page, "en");
  await failSecondCommit(page, { id: failureId, text: "first attempt", canCopy: true });
  await page.getByRole("button", { name: "Copy log", exact: true }).click();
  await dispatchWebviewMessage(page, { type: "executionStarted", total: 2 });
  await expect(page.locator(".execution-log")).toHaveCount(0);
  await failSecondCommit(page, { id: nextId, text: "second attempt", canCopy: true });
  await dispatchWebviewMessage(page, { type: "failureLogCopied", failureId, success: true, message: "OLD COPIED" });
  await expect(page.locator("#commit-failure-log-text")).toHaveText("second attempt");
  await expect(page.locator(".execution-log-copy-status")).toBeEmpty();
  await page.locator('.commit-group[data-index="1"] textarea').first().fill("fix: revised commit");
  await expect(page.locator(".execution-log")).toHaveCount(0);
});

test("failure without captured output explains the empty state and disables copying", async ({ page }) => {
  await mountCommitPlan(page, "en");
  await failSecondCommit(page, { id: failureId, text: "", canCopy: false });
  await expect(page.locator("#commit-failure-log-text")).toHaveText("No log output was captured for this failure.");
  await expect(page.getByRole("button", { name: "Copy log", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Hide log", exact: true })).toBeDisabled();
  expect((await readPostedMessages(page)).some((message: any) => message.type === "copyFailureLog")).toBe(false);
});
