import { expect, test } from "@playwright/test";
import { dispatchWebviewMessage, readPostedMessages } from "./webviewHarness";
import { mountList, overview } from "./prListHarness";

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`PR first page, cached reopen, keyboard retry and completion at ${width}px`, async ({ page }) => {
    const ko = width === 390;
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height }); await mountList(page, ko);
    await page.getByRole("button", { name: "Show pull requests", exact: true }).click();
    await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: overview(false) });
    await expect(page.locator(".pr-card")).toBeVisible();
    await expect(page.locator(".pr-list-footer[role=status]")).toContainText(ko ? "나머지 커밋" : "Loading remaining commits");
    await expect(page.locator("#pr-op-42-squash")).toBeDisabled();
    await expect(page.locator(".pr-meta-chip[title=Commits]")).toHaveText("…");
    await expect(page.locator('.pr-meta-chip[title="Total PR comments"]')).toHaveText("…");
    const firstCalls = (await readPostedMessages(page)).filter((message: any) => message.type === "refreshPullRequests").length;
    // 실제 키보드로 상세에 진입하고 완성 전에도 GitHub 열기와 목록 복귀가 가능한지 확인한다.
    await page.locator(".pr-card").focus(); await page.keyboard.press("Enter");
    await expect(page.locator("[data-open-pr]")).toBeEnabled();
    await page.getByRole("button", { name: "Show pull request list", exact: true }).click();
    expect((await readPostedMessages(page)).filter((message: any) => message.type === "refreshPullRequests").length).toBe(firstCalls);
    await page.screenshot({ path: `/tmp/gsc-72056-pr-loading-${width}.png`, fullPage: true });
    await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: { ...overview(false), available: false, detailsLoading: false, error: "Temporary network failure" } });
    const retry = page.getByRole("button", { name: ko ? "PR 다시 불러오기" : "Retry loading pull requests", exact: true });
    await expect(retry).toHaveAttribute("title", ko ? "PR 다시 불러오기" : "Retry loading pull requests");
    await page.mouse.move(0, height - 1);
    await page.screenshot({ path: `/tmp/gsc-72056-pr-error-${width}.png`, fullPage: true });
    await retry.focus(); await page.keyboard.press("Enter");
    await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: overview(false) });
    const input = page.getByRole("searchbox"); await input.fill("large"); await expect(input).toBeFocused();
    await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: overview(true) });
    await expect(input).toBeFocused(); await expect(input).toHaveValue("large");
    await expect(page.locator("#pr-op-42-squash")).toBeEnabled();
    await expect(page.locator('.pr-meta-chip[title="Total PR comments"]')).toHaveText("12");
    await page.getByRole("button", { name: "Clear pull request search", exact: true }).click();
    await page.locator("#pr-op-42-squash").click();
    expect(await readPostedMessages(page)).toContainEqual({ type: "pullRequestAction", number: 42, action: "squash", busyId: "pr-op-42-squash" });
    const beforeReopen = (await readPostedMessages(page)).filter((message: any) => message.type === "refreshPullRequests").length;
    // 모바일에서는 drawer가 toolbar를 가리키므로 목록 복귀를 검증하고, 넓은 폭에서는 toolbar도 다시 누른다.
    if (width >= 768) await page.getByRole("button", { name: "Show pull requests", exact: true }).click();
    expect((await readPostedMessages(page)).filter((message: any) => message.type === "refreshPullRequests").length).toBe(beforeReopen);
    await page.mouse.move(0, height - 1); await page.locator(".pr-card").blur();
    await page.screenshot({ path: `/tmp/gsc-72056-pr-ready-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("background completion preserves a Korean IME composition until it ends", async ({ page }) => {
  await mountList(page, true);
  await page.getByRole("button", { name: "Show pull requests", exact: true }).click();
  await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: overview(false) });
  const input = page.getByRole("searchbox"); await input.focus();
  await input.dispatchEvent("compositionstart");
  const handle = await input.elementHandle();
  await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: overview(true) });
  expect(await handle!.evaluate(element => element.isConnected)).toBe(true);
  await input.dispatchEvent("compositionend");
  await expect(page.locator("#pr-op-42-squash")).toBeEnabled();
});

test("initial automatic loading unlocks the PR toolbar before background pagination finishes", async ({ page }) => {
  await mountList(page, false);
  await dispatchWebviewMessage(page, { type: "graphBusy", key: "graph-pr-list", busy: true });
  const button = page.getByRole("button", { name: "Show pull requests", exact: true });
  await expect(button).toBeDisabled();
  await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: overview(false) });
  await expect(button).toBeEnabled(); await button.click();
  await expect(page.locator(".pr-card")).toBeVisible();
  await expect(page.locator("#pr-op-42-squash")).toBeDisabled();
  expect((await readPostedMessages(page)).filter((message: any) => message.type === "refreshPullRequests")).toHaveLength(0);
  await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: overview(true) });
  await dispatchWebviewMessage(page, { type: "graphBusy", key: "graph-pr-list", busy: false });
  await expect(button).not.toHaveAttribute("aria-busy", "true");
});

test("an unchanged refresh clears loading and renews the list cache without replacing rows", async ({ page }) => {
  await mountList(page, false);
  await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: overview(true) });
  const button = page.getByRole("button", { name: "Show pull requests", exact: true });
  await button.click();
  await page.evaluate(() => { const now = Date.now; Date.now = () => now() + 31000; });
  await button.click();
  await expect(page.locator(".pr-list-footer")).toContainText("Loading pull requests");
  const row = await page.locator(".pr-card").elementHandle();
  await dispatchWebviewMessage(page, { type: "pullRequestOverviewRetained" });
  await expect(page.locator(".pr-list-footer")).toHaveText("All loaded");
  expect(await row!.evaluate(element => element.isConnected)).toBe(true);
  await button.click();
  expect((await readPostedMessages(page)).filter((message: any) => message.type === "refreshPullRequests")).toHaveLength(1);
});

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`eighty summary rows are interactive while metadata streams without losing focus at ${width}px`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height }); await mountList(page, width === 390);
    const basic = { ...overview(false), pullRequests: Array.from({ length: 80 }, (_, index) => ({
      ...overview(false).pullRequests[0], number: 42 + index, commitHashes: ["head"], commentCount: 0, fileCountComplete: false,
      title: `Improve loading ${index + 1}: preserve complete histories and long branch names`,
    })) };
    await dispatchWebviewMessage(page, { type: "graphBusy", key: "graph-pr-list", busy: true });
    await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: basic });
    const toolbar = page.getByRole("button", { name: "Show pull requests", exact: true });
    await expect(toolbar).toBeEnabled(); await toolbar.click();
    await expect(page.locator(".pr-card")).toHaveCount(80);
    await expect(page.locator("#pr-op-42-squash")).toBeDisabled();
    await expect(page.locator('.pr-meta-chip[title="Total PR comments"]').first()).toHaveText("…");
    await expect(page.locator('.pr-meta-chip[title="Changed files"]').first()).toHaveText("…");
    const input = page.getByRole("searchbox"); await input.fill("loading");
    const card = await page.locator('[data-show-pr="42"]').elementHandle();
    await page.screenshot({ path: `/private/tmp/gsc-history-pr-20261006/pr-summary-${width}.png`, fullPage: true });
    const streamed = { ...basic, pullRequests: basic.pullRequests.map((pr, index) => index < 20
      ? { ...pr, fileCountComplete: true, commitHashesComplete: true, commentCountComplete: true, commitHashes: ["first", "head"], commentCount: 12 }
      : pr) };
    await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: streamed });
    await expect(input).toBeFocused(); await expect(input).toHaveValue("loading");
    expect(await card!.evaluate(element => element.isConnected)).toBe(true);
    await expect(page.locator("#pr-op-42-squash")).toBeEnabled();
    await expect(page.locator("#pr-op-121-squash")).toBeDisabled();
    const complete = { ...streamed, detailsLoading: false, pullRequests: streamed.pullRequests.map(pr => ({ ...pr,
      fileCountComplete: true, commitHashesComplete: true, commentCountComplete: true, commitHashes: ["first", "head"], commentCount: 12 })) };
    await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: complete });
    await expect(page.locator("#pr-op-121-squash")).toBeEnabled();
    await expect(input).toBeFocused();
    await expect(page.locator(".pr-list-footer")).toHaveText("All loaded");
    await page.screenshot({ path: `/private/tmp/gsc-history-pr-20261006/pr-complete-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  });
}
