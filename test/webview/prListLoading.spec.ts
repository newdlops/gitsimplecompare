import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { mountGraphRenderer, dispatchWebviewMessage, readPostedMessages } from "./webviewHarness";

/** 기존 Graph DOM·테마·실제 PR JS/CSS로 목록의 점진적 표시를 재현한다. */
async function mountList(page: Page, korean: boolean) {
  await mountGraphRenderer(page);
  await page.evaluate(ko => {
    const w: any = window;
    const button = document.createElement("button"); button.id = "graph-pr-list"; button.className = "icon-button";
    button.title = "Show pull requests"; button.setAttribute("aria-label", "Show pull requests");
    button.innerHTML = '<span class="codicon codicon-git-pull-request" aria-hidden="true"></span>';
    document.querySelector("#graph-toolbar")!.append(button);
    w.GscGraphPostMessage = (message: unknown) => w.__gscFixtureMessages.push(structuredClone(message));
    w.GscGraphDetailHost = { root: document.getElementById("detail"), show: () => document.body.classList.add("detail-open") };
    w.GscPrStackI18n = {
      loadingPullRequests: ko ? "PR을 불러오는 중…" : "Loading pull requests…",
      loadingPrDetails: ko ? "나머지 커밋과 댓글을 불러오는 중…" : "Loading remaining commits and comments…",
      loadingPrCommits: ko ? "PR 커밋을 불러오는 중…" : "Loading pull request commits…",
      retryPullRequests: ko ? "PR 다시 불러오기" : "Retry loading pull requests",
      openPullRequest: "Open pull request #{0} in browser",
    };
  }, korean);
  await page.addStyleTag({ content: `html,body{--vscode-disabledForeground:#777;--vscode-button-secondaryForeground:#ddd;--vscode-button-secondaryBackground:#3a3d41;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#ccc;--vscode-editor-font-family:Menlo,monospace}` });
  for (const file of ["graphPr.css", "graphControls.css"]) await page.addStyleTag({ path: join(process.cwd(), "media/graph", file) });
  for (const file of ["graphPrActions.js", "graphPrSearch.js", "graphPrMatching.js", "graphPrFiles.js", "graphPr.js"]) {
    await page.addScriptTag({ path: join(process.cwd(), "media/graph", file) });
  }
}

/** 긴 제목·branch를 포함한 첫 목록을 만들어 좁은 drawer의 overflow를 검증한다. */
function overview(complete: boolean) {
  return { available: true, repository: "owner/repo", detailsLoading: !complete, hasMore: false,
    pullRequests: [{ number: 42, title: "Speed up large pull request loading while preserving complete commit snapshots",
      state: "OPEN", author: "contributor", headRefName: "feature/large-pull-request-loading", baseRefName: "main",
      headHash: "head", fileCount: 105, commitHashes: complete ? ["first", "middle", "head"] : ["first", "head"],
      commitHashesComplete: complete, commentCount: complete ? 12 : 5, commentCountComplete: complete }] };
}

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
