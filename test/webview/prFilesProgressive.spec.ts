import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mountList, overview } from "./prListHarness";
import { dispatchWebviewMessage, readPostedMessages } from "./webviewHarness";

/** 여러 페이지의 파일과 지연된 댓글을 실제 상세 메시지 형식으로 만든다. */
function detail(count: number, filesLoading: boolean, reviewThreadsLoading: boolean) {
  return { number: 42, fileCount: 105, fileCommentCount: 0, commentCount: 0, filesLoading, reviewThreadsLoading,
    filesTruncated: false, reviewThreadsTruncated: false,
    files: Array.from({ length: count }, (_, index) => ({ path: `src/long-nested-folder/component-${String(index).padStart(3, "0")}.ts`,
      status: "M", additions: 2, deletions: 1, commentCount: 0 })) };
}

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`partial PR files stay interactive through later file pages and comment errors at ${width}px`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height }); await mountList(page, width === 390);
    await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: overview(true) });
    await page.getByRole("button", { name: "Show pull requests", exact: true }).click();
    await page.locator(".pr-card-heading").click();
    await expect.poll(async () => (await readPostedMessages(page)).filter((m: any) => m.type === "refreshPullRequestDetail").length).toBe(1);
    const request = (await readPostedMessages(page)).find((m: any) => m.type === "refreshPullRequestDetail");
    await dispatchWebviewMessage(page, { type: "pullRequestDetail", number: 42, requestId: request.requestId, partial: true, detail: detail(20, true, true) });
    await expect(page.locator(".pr-file-row")).toHaveCount(20);
    await expect(page.getByRole("status").filter({ hasText: width === 390 ? "변경 파일을 불러오는 중 (20/105)" : "Loading changed files (20 of 105)" })).toBeVisible();
    const first = page.locator(".pr-file-row").first(), handle = await first.elementHandle();
    await first.focus(); await page.keyboard.press("Enter");
    expect(await readPostedMessages(page)).toContainEqual(expect.objectContaining({ type: "openPullRequestFileDiff", number: 42, path: "src/long-nested-folder/component-000.ts" }));
    await dispatchWebviewMessage(page, { type: "pullRequestDetail", number: 42, requestId: request.requestId, partial: true, detail: detail(105, false, true) });
    await expect(page.locator(".pr-file-row")).toHaveCount(105);
    expect(await handle!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
    await expect(page.locator(".pr-files-section")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("status").filter({ hasText: width === 390 ? "파일 댓글을 불러오는 중" : "Loading file comments" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: width === 390 ? "파일 댓글을 불러오는 중" : "Loading file comments" })).toBeInViewport();
    await page.screenshot({ path: `/private/tmp/gsc-pr-progressive-files-${width}.png` });
    await dispatchWebviewMessage(page, { type: "pullRequestDetail", number: 42, requestId: request.requestId,
      detail: { ...detail(105, false, false), reviewThreadsError: "Network unavailable" } });
    await expect(page.locator(".pr-file-row")).toHaveCount(105);
    await expect(page.getByRole("status").filter({ hasText: width === 390 ? "파일 댓글을 불러오지 못했습니다" : "File comments could not be loaded" })).toBeVisible();
    await expect(page.locator("[data-pr-detail-retry]")).toBeInViewport();
    expect(await handle!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
    await page.mouse.move(0, height - 1); await first.blur();
    await page.screenshot({ path: `/private/tmp/gsc-pr-progressive-comments-error-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).include("#detail").analyze();
    expect(audit.violations.map(item => item.id)).toEqual([]); expect(errors).toEqual([]);
    await page.locator("[data-pr-detail-retry]").click();
    await expect.poll(async () => (await readPostedMessages(page)).filter((m: any) => m.type === "refreshPullRequestDetail").length).toBe(2);
  });
}

test("closing a partially loaded drawer discards its unfinished response and starts a fresh request on reopen", async ({ page }) => {
  await mountList(page, false);
  await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: overview(true) });
  await page.getByRole("button", { name: "Show pull requests", exact: true }).click(); await page.locator(".pr-card-heading").click();
  const request = (await readPostedMessages(page)).find((m: any) => m.type === "refreshPullRequestDetail");
  await dispatchWebviewMessage(page, { type: "pullRequestDetail", number: 42, requestId: request.requestId, partial: true, detail: detail(20, true, true) });
  await expect(page.locator(".pr-file-row")).toHaveCount(20);
  await page.locator("#toggle-detail").click();
  await dispatchWebviewMessage(page, { type: "pullRequestDetail", number: 42, requestId: request.requestId, detail: detail(105, false, false) });
  await page.locator("#toggle-detail").click();
  await expect.poll(async () => (await readPostedMessages(page)).filter((m: any) => m.type === "refreshPullRequestDetail").length).toBe(2);
  await expect(page.locator(".pr-file-row")).toHaveCount(0);
});

test("an unloaded related commit carries PR recovery context and preserves the exact requested commit", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const exactHash = "a".repeat(40), headHash = "b".repeat(40);
  await page.setViewportSize({ width: 1440, height: 900 }); await mountList(page, false);
  const data = overview(true); data.pullRequests[0].headHash = headHash; data.pullRequests[0].commitHashes = [exactHash, headHash];
  await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: data });
  await page.getByRole("button", { name: "Show pull requests", exact: true }).click(); await page.locator(".pr-card-heading").click();
  const button = page.locator(`[data-focus-commit="${exactHash}"]`);
  await button.focus(); await page.keyboard.press("Enter");
  await expect(button).toBeDisabled(); await expect(button).toHaveAttribute("aria-busy", "true");
  const request = (await readPostedMessages(page)).find((m: any) => m.type === "ensureCommitVisible");
  expect(request).toMatchObject({ pullRequestNumber: 42, hashes: [exactHash], exactHash });
  await dispatchWebviewMessage(page, { type: "commitVisibility", requestId: request.requestId, found: true, hash: headHash });
  await expect(button).toBeEnabled(); await expect(page.locator(".pr-jump-message")).toBeVisible();
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await readPostedMessages(page)).filter((m: any) => m.type === "ensureCommitVisible").length).toBe(2);
  expect(errors).toEqual([]);
});
