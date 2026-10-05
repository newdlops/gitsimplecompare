import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { dispatchWebviewMessage, readPostedMessages } from "./webviewHarness";
import { mountList, overview } from "./prListHarness";

/** 요청 ID는 실제 클릭이 게시한 값을 읽어 이전 응답과 현재 응답을 구분한다. */
async function latestRequest(page: Page, count: number) {
  await expect.poll(async () => (await readPostedMessages(page)).filter((m: any) => m.type === "refreshPullRequestDetail").length).toBe(count);
  return (await readPostedMessages(page)).filter((m: any) => m.type === "refreshPullRequestDetail").at(-1);
}

/** 긴 파일 이름과 105개 변경 파일을 포함해 임의 상한 없이 표시하는 상세를 만든다. */
function detail() {
  return { number: 42, fileCount: 105, fileCommentCount: 5, commentCount: 12,
    files: Array.from({ length: 105 }, (_, i) => ({ path: `src/file-${String(i).padStart(3, "0")}-preserve-all-changed-files.ts`,
      status: "M", additions: 3, deletions: 1, commentCount: i === 0 ? 5 : 0 })) };
}

/** drawer의 진입 애니메이션이 끝난 실제 표시 영역에서 제목·버튼·내용이 잘리지 않는지 확인한다. */
async function expectErrorWithinDrawer(page: Page) {
  await expect.poll(() => page.locator("#detail").evaluate(node => {
    const panel = node.getBoundingClientRect(), shell = node.querySelector(".pr-detail-shell")!;
    return panel.right <= innerWidth + 1 && shell.scrollWidth <= shell.clientWidth + 1 &&
      Array.from(node.querySelectorAll(".pr-detail-title h2, [data-pr-detail-retry], .pr-branch-flow, .pr-commit-item"))
        .every(child => {
          const rect = child.getBoundingClientRect();
          return rect.left >= panel.left && rect.right <= panel.right + 1;
        });
  })).toBe(true);
}

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`PR detail retry, partial rendering and full file list at ${width}px`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height }); await mountList(page, width === 390);
    await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: overview(true) });
    await page.getByRole("button", { name: "Show pull requests", exact: true }).click();
    await page.locator(".pr-card").focus(); await page.keyboard.press("Enter");
    const first = await latestRequest(page, 1);
    await dispatchWebviewMessage(page, { type: "pullRequestDetailError", number: 42, requestId: first.requestId, message: "Temporary API failure" });
    const retry = page.getByRole("button", { name: width === 390 ? "변경 파일 다시 불러오기" : "Retry loading changed files", exact: true });
    await expect(retry).toBeVisible(); await expect(retry).toHaveAttribute("title", /불러오기|Retry/);
    await expectErrorWithinDrawer(page);
    await page.screenshot({ path: `/tmp/gsc-optimization-pr-error-${width}.png` });
    await retry.focus(); await page.keyboard.press("Enter"); const second = await latestRequest(page, 2);
    expect(second.requestId).not.toBe(first.requestId);
    await dispatchWebviewMessage(page, { type: "pullRequestDetail", number: 42, requestId: first.requestId, detail: { ...detail(), files: [] } });
    await expect(page.locator(".pr-file-row")).toHaveCount(0);
    await dispatchWebviewMessage(page, { type: "pullRequestDetail", number: 42, requestId: second.requestId, detail: detail() });
    await expect(page.locator(".pr-file-row")).toHaveCount(105);
    expect(await page.locator(".pr-file-row").first().evaluate(node => {
      const row = node.getBoundingClientRect(), detail = document.getElementById("detail")!.getBoundingClientRect();
      const stats = node.querySelector(".stat")!.getBoundingClientRect();
      return row.right <= detail.right + 1 && stats.right <= detail.right + 1;
    })).toBe(true);
    const file = page.locator(".pr-file-row").first(), handle = await file.elementHandle(); await file.focus();
    const tree = await page.locator(".pr-file-tree").elementHandle();
    const next = overview(true); next.pullRequests[0].title = "Updated PR title";
    await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: next });
    await expect(page.locator(".pr-detail-title h2")).toContainText("Updated PR title");
    expect(await handle!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
    expect(await tree!.evaluate(node => node.isConnected)).toBe(true);
    expect((await readPostedMessages(page)).filter((m: any) => m.type === "refreshPullRequestDetail")).toHaveLength(2);
    await page.keyboard.press("Enter");
    expect(await readPostedMessages(page)).toContainEqual(expect.objectContaining({ type: "openPullRequestFileDiff", number: 42 }));
    await page.mouse.move(0, height - 1); await file.blur();
    await page.screenshot({ path: `/tmp/gsc-optimization-pr-detail-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const audit = await new AxeBuilder({ page }).include("#detail").analyze();
    expect(audit.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("closing a pending PR drawer ignores late responses and reopening starts just one new request", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await mountList(page, false);
  await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: overview(true) });
  await page.getByRole("button", { name: "Show pull requests", exact: true }).click(); await page.locator(".pr-card").click();
  const first = await latestRequest(page, 1); await page.locator("#toggle-detail").click();
  await expect(page.locator("body")).not.toHaveClass(/detail-open/);
  await dispatchWebviewMessage(page, { type: "pullRequestDetail", number: 42, requestId: first.requestId, detail: detail() });
  await page.locator("#toggle-detail").click(); const second = await latestRequest(page, 2);
  expect(second.requestId).not.toBe(first.requestId); await expect(page.locator(".pr-file-row")).toHaveCount(0);
  await dispatchWebviewMessage(page, { type: "graphDetailCancelled", number: 42, requestId: second.requestId, reason: "windowUnfocused" });
  await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: overview(true) });
  expect((await readPostedMessages(page)).filter((m: any) => m.type === "refreshPullRequestDetail")).toHaveLength(2);
  await dispatchWebviewMessage(page, { type: "graphDetailResume" }); await latestRequest(page, 3);
});

test("visited detail cache has count and byte bounds, preserves active huge results and separates auth context", async ({ page }) => {
  await mountList(page, false);
  const result = await page.evaluate(() => {
    const requests: any[] = [], state = (window as any).GscGraphPrViewState.create((message: any) => requests.push(message));
    for (let number = 1; number <= 80; number++) {
      const pr = { number, headHash: "head", baseHash: "base" }; state.request(pr);
      state.accept(requests.at(-1), pr, { status: "ready", detail: { files: [], description: "x".repeat(200) } });
    }
    const counts = state.stats(); const large = { number: 81, headHash: "head", baseHash: "base" };
    state.request(large); state.accept(requests.at(-1), large, { status: "ready", detail: { text: "x".repeat(5 * 1024 * 1024) } });
    const bytes = state.stats(), active = Boolean(state.get(large)); state.setContext("new-account");
    return { counts, bytes, active, afterContext: state.stats(), previous: Boolean(state.get(large)) };
  });
  expect(result.counts.entries).toBe(32); expect(result.bytes.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(result.active).toBe(true); expect(result.afterContext.entries).toBe(0); expect(result.previous).toBe(false);
});
