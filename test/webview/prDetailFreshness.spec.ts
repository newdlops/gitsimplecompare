import { expect, test } from "@playwright/test";
import { mountList, overview } from "./prListHarness";
import { dispatchWebviewMessage, readPostedMessages } from "./webviewHarness";
import AxeBuilder from "@axe-core/playwright";

/** 같은 PR snapshot의 전체 파일을 만들어 갱신 전후에 사용 가능한 파일 수를 비교한다. */
function detail(count = 105) {
  return { number: 42, fileCount: 105, fileCommentCount: 0, commentCount: 0,
    files: Array.from({ length: count }, (_, index) => ({ path: `src/file-${index}.ts`, status: "M", additions: 1, deletions: 0, commentCount: 0 })) };
}

/** 현재 웹뷰가 실제로 게시한 n번째 PR 파일 요청의 identity를 반환한다. */
async function request(page: import("@playwright/test").Page, count: number) {
  await expect.poll(async () => (await readPostedMessages(page)).filter((message: any) => message.type === "refreshPullRequestDetail").length).toBe(count);
  return (await readPostedMessages(page)).filter((message: any) => message.type === "refreshPullRequestDetail").at(-1);
}

test("completed files stay usable during background refresh, partial pages and refresh failure", async ({ page }) => {
  await mountList(page, false);
  await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: overview(true) });
  await page.getByRole("button", { name: "Show pull requests", exact: true }).click(); await page.locator(".pr-card-heading").click();
  const first = await request(page, 1);
  await dispatchWebviewMessage(page, { type: "pullRequestDetail", number: 42, requestId: first.requestId, detail: detail() });
  await expect(page.locator(".pr-file-row")).toHaveCount(105);
  const file = await page.locator(".pr-file-row").first().elementHandle();
  await page.locator(".pr-file-row").first().focus();
  await page.evaluate(() => { const now = Date.now(); Date.now = () => now + 31_000; });
  await dispatchWebviewMessage(page, { type: "tagStatus", tags: [] }); const second = await request(page, 2);
  await expect(page.locator(".pr-file-row")).toHaveCount(105);
  expect(await file!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
  await expect(page.getByText("Loading changed files...", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Refreshing changed files" })).toBeVisible();
  await dispatchWebviewMessage(page, { type: "pullRequestDetail", number: 42, requestId: second.requestId, partial: true,
    detail: { ...detail(20), filesLoading: true, reviewThreadsLoading: true } });
  await expect(page.locator(".pr-file-row")).toHaveCount(105);
  await dispatchWebviewMessage(page, { type: "pullRequestDetailError", number: 42, requestId: second.requestId, message: "Temporary network failure" });
  await expect(page.locator(".pr-file-row")).toHaveCount(105);
  await expect(page.getByRole("status").filter({ hasText: "Changed files could not be refreshed" })).toBeVisible();
  await page.locator("[data-pr-detail-retry]").click(); const third = await request(page, 3);
  await expect(page.locator(".pr-file-row")).toHaveCount(105);
  await dispatchWebviewMessage(page, { type: "pullRequestDetail", number: 42, requestId: third.requestId, detail: detail() });
  await expect(page.getByRole("status").filter({ hasText: /Refreshing changed files|could not be refreshed/ })).toHaveCount(0);
  expect(await file!.evaluate(node => node.isConnected)).toBe(true);
});

for (const filesFirst of [true, false]) test(`lightweight PR metadata enrichment preserves its one file request (files first: ${filesFirst})`, async ({ page }) => {
  await mountList(page, false);
  const data = overview(true), headHash = "a".repeat(40), baseHash = "b".repeat(40);
  const light = structuredClone(data); Object.assign(light.pullRequests[0], { headHash: undefined, baseHash: undefined });
  await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: light });
  await page.getByRole("button", { name: "Show pull requests", exact: true }).click(); await page.locator(".pr-card-heading").click();
  const pending = await request(page, 1), value = { ...detail(20), headHash, baseHash, filesLoading: true };
  if (filesFirst) await dispatchWebviewMessage(page, { type: "pullRequestDetail", number: 42, requestId: pending.requestId, partial: true, detail: value });
  Object.assign(data.pullRequests[0], { headHash, baseHash });
  await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: data });
  if (!filesFirst) await dispatchWebviewMessage(page, { type: "pullRequestDetail", number: 42, requestId: pending.requestId, partial: true, detail: value });
  await expect(page.locator(".pr-file-row")).toHaveCount(20);
  expect((await readPostedMessages(page)).filter((message: any) => message.type === "refreshPullRequestDetail")).toHaveLength(1);
  await dispatchWebviewMessage(page, { type: "pullRequestDetail", number: 42, requestId: pending.requestId,
    detail: { ...detail(), headHash, baseHash } });
  await expect(page.locator(".pr-file-row")).toHaveCount(105);
});

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`PR commit metadata and direct details work without any graph rows at ${width}px`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height }); await mountList(page, width === 390);
    const data = overview(true), hashes = ["a", "b", "c", "d"].map(letter => letter.repeat(40));
    Object.assign(data.pullRequests[0], { headHash: hashes[2], mergeHash: hashes[3], state: "MERGED",
      commitHashes: hashes.slice(0, 3),
      commitSummaries: hashes.slice(0, 3).map((hash, index) => ({ hash, title: `Actual PR commit ${index + 1}: preserve changes outside the current graph window`,
        author: `Contributor ${index + 1}`, dateIso: "2026-10-30T09:00:00Z" })),
      mergeCommitSummary: { hash: hashes[3], title: "Squash merge result", author: "Maintainer", dateIso: "2026-10-30T10:00:00Z" } });
    await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: data });
    await page.getByRole("button", { name: "Show pull requests", exact: true }).click(); await page.locator(".pr-card-heading").click();
    const files = await request(page, 1);
    await dispatchWebviewMessage(page, { type: "pullRequestDetail", number: 42, requestId: files.requestId, detail: detail(105) });
    await expect(page.locator("#graph-content .row")).toHaveCount(0);
    await expect(page.locator("[data-open-pr-commit]")).toHaveCount(4);
    await expect(page.locator(".pr-commit-list")).toContainText("Actual PR commit 1");
    await expect(page.locator(".pr-commit-list")).toContainText("Contributor 1");
    await expect(page.locator(".pr-commit-list")).toContainText("Squash merge result");
    await expect(page.getByText("Commit is not loaded in the graph yet.", { exact: true })).toHaveCount(0);
    expect(await page.locator(".pr-commit-row").evaluateAll(rows => rows.every(row => {
      const bounds = row.getBoundingClientRect(), panel = document.querySelector("#detail")!.getBoundingClientRect();
      return bounds.left >= panel.left && bounds.right <= panel.right + 1;
    }))).toBe(true);
    await page.locator(".pr-commit-list").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/private/tmp/gsc-pr-commit-metadata-${width}.png` });
    expect((await new AxeBuilder({ page }).include("#detail").analyze()).violations.map(item => ({ id: item.id,
      nodes: item.nodes.map(node => ({ target: node.target, checks: node.any.map(check => check.data) })) }))).toEqual([]);
    const jump = page.locator(`[data-focus-commit="${hashes[0]}"]`);
    await expect(jump).toHaveAttribute("title", /graph|그래프/); await jump.click();
    await expect(jump).toBeDisabled();
    const open = page.locator(`[data-open-pr-commit="${hashes[0]}"]`);
    await expect(open).toBeEnabled(); await expect(open).toHaveAttribute("title", /details|상세/);
    await open.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText(width === 390 ? "커밋 상세를 불러오는 중" : "Loading commit details");
    const messages = await readPostedMessages(page);
    expect(messages).toContainEqual({ type: "selectCommit", hash: hashes[0], pullRequestNumber: 42 });
    expect(messages.filter((message: any) => message.type === "ensureCommitVisible")).toHaveLength(1);
    await dispatchWebviewMessage(page, { type: "graphDetailResume" });
    if (width === 390) await page.keyboard.press("Escape"); else await page.locator("#toggle-detail").click();
    await page.locator("#toggle-detail").click();
    const resumed = (await readPostedMessages(page)).filter((message: any) => message.type === "selectCommit");
    expect(resumed).toHaveLength(3);
    expect(resumed.every((message: any) => message.hash === hashes[0] && message.pullRequestNumber === 42)).toBe(true);
    expect(errors).toEqual([]);
  });
}
