import { expect, test } from "@playwright/test";
import { dispatchWebviewMessage, mountGraphRenderer, readPostedMessages } from "./webviewHarness";

/** 원격 hydration과 사용자 선택이 바뀌는 현실적인 대량 목록을 만든다. */
function snapshot(count = 1000, current = 0) {
  return { mode: "all", selected: [] as string[], compact: true, remoteStatus: "ready", branches: Array.from({ length: count }, (_, index) => ({
    name: `feature/${String(index).padStart(4, "0")}-한글-long-branch-name`, kind: index % 2 ? "remote" : "local",
    checked: true, current: index === current,
  })) };
}

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`closed branch catalogs stay deferred and opening shows the latest snapshot at ${width}px`, async ({ page }, info) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height }); await mountGraphRenderer(page, false, { branchFilter: true });
    await page.keyboard.press("Escape");
    await dispatchWebviewMessage(page, { type: "branchFilterOptions", filter: snapshot() });
    await dispatchWebviewMessage(page, { type: "branchFilterOptions", filter: snapshot(1000, 5) });
    const menu = page.locator("#graph-branch-filter-menu"), button = page.getByRole("button", { name: /Filter visible branches/ });
    await expect(menu).toBeHidden(); await expect(menu.locator("*")).toHaveCount(0);
    await button.click(); await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await expect(menu.locator("[data-branch-filter-checkbox]")).toHaveCount(1000);
    await expect(menu.locator(".current")).toContainText("0005");
    await page.screenshot({ path: info.outputPath(`branch-filter-dense-${width}.png`) });
    const search = menu.getByRole("searchbox"); await search.fill("0005");
    await expect(menu.locator("[data-branch-filter-checkbox]")).toHaveCount(1);
    await expect(search).toBeFocused();
    await dispatchWebviewMessage(page, { type: "branchFilterOptions", filter: snapshot(1000, 5) });
    await expect(search).toBeFocused(); await expect(search).toHaveValue("0005");
    await page.screenshot({ path: info.outputPath(`branch-filter-search-${width}.png`) });
    await button.click(); await expect(menu).toBeHidden();
    await dispatchWebviewMessage(page, { type: "branchFilterOptions", filter: { ...snapshot(), remoteStatus: "error", remoteError: "Native catalog read failed; refresh to retry." } });
    await expect(menu.locator("*")).toHaveCount(0);
    await button.click(); await expect(search).toHaveValue("0005");
    await expect(menu).toContainText("Remote branches unavailable. Refresh to retry.");
    await page.screenshot({ path: info.outputPath(`branch-filter-error-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("closing and reopening before the host responds preserves unchecked and compact controls", async ({ page }) => {
  await mountGraphRenderer(page, false, { branchFilter: true });
  await dispatchWebviewMessage(page, { type: "branchFilterOptions", filter: snapshot(10) });
  const button = page.getByRole("button", { name: /Filter visible branches/ }), menu = page.locator("#graph-branch-filter-menu");
  await button.click();
  const first = menu.locator("[data-branch-filter-checkbox]").first(), compact = menu.getByRole("checkbox", { name: "Compact graph" });
  await first.uncheck(); await compact.uncheck(); await button.click(); await button.click();
  await expect(first).not.toBeChecked(); await expect(compact).not.toBeChecked();
  const posted = await readPostedMessages(page);
  expect(posted.some((message: any) => message.type === "setBranchFilter" && message.mode === "custom" && message.branches.length === 9)).toBe(true);
  expect(posted.some((message: any) => message.type === "setBranchFilter" && message.compact === false)).toBe(true);
  expect(posted.at(-1)).toMatchObject({ type: "setBranchFilter", mode: "custom", compact: false });
  expect(posted.at(-1).branches).toHaveLength(9);
});

test("changed metadata preserves the search cursor, checkbox focus and list scroll", async ({ page }) => {
  await mountGraphRenderer(page, false, { branchFilter: true });
  await dispatchWebviewMessage(page, { type: "branchFilterOptions", filter: snapshot() });
  const button = page.getByRole("button", { name: /Filter visible branches/ }), menu = page.locator("#graph-branch-filter-menu");
  await button.click(); const search = menu.getByRole("searchbox"); await search.fill("feature 00");
  await search.press("Home"); await search.press("ArrowRight");
  const cursor = await search.evaluate((input: HTMLInputElement) => input.selectionStart);
  await dispatchWebviewMessage(page, { type: "branchFilterOptions", filter: snapshot(1000, 5) });
  await expect(search).toBeFocused(); expect(await search.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(cursor);
  const branch = menu.locator("[data-branch-filter-checkbox]").nth(60); await branch.focus();
  const top = await menu.locator(".branch-filter-list").evaluate(element => element.scrollTop);
  await branch.press("Space"); await expect(branch).toBeFocused();
  expect(await menu.locator(".branch-filter-list").evaluate(element => element.scrollTop)).toBe(top);
  await branch.press("Escape"); await expect(menu).toBeHidden(); await expect(button).toBeFocused();
});

test("pending and empty catalogs recover into immediate clear-all and select-all states", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await mountGraphRenderer(page, false, { branchFilter: true });
  await dispatchWebviewMessage(page, { type: "branchFilterOptions", filter: { ...snapshot(0), remoteStatus: "pending" } });
  await page.getByRole("button", { name: /Filter visible branches/ }).click();
  const menu = page.locator("#graph-branch-filter-menu");
  await expect(menu).toContainText("Loading remote branches"); await expect(menu).toContainText("No branches found");
  await page.screenshot({ path: info.outputPath("branch-filter-pending-390.png") });
  await dispatchWebviewMessage(page, { type: "branchFilterOptions", filter: snapshot(4) });
  await menu.getByRole("button", { name: "Hide every branch from the graph" }).click();
  await expect(menu).toBeVisible();
  await expect(menu.locator("[data-branch-filter-checkbox]:checked")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filter visible branches: 0 checked branches are shown" })).toHaveAttribute("data-active-count", "0");
  await menu.getByRole("button", { name: "Show every local and remote branch in the graph" }).click();
  await expect(menu.locator("[data-branch-filter-checkbox]:checked")).toHaveCount(4);
  await menu.getByRole("searchbox").fill("missing-branch"); await expect(menu).toContainText("No branches match");
  await page.screenshot({ path: info.outputPath("branch-filter-empty-search-390.png") });
});

test("offscreen rows keep correct geometry and remain keyboard reachable with larger text", async ({ page }) => {
  await mountGraphRenderer(page, false, { branchFilter: true });
  await page.addStyleTag({ content: "html,body{--vscode-font-size:20px!important}" });
  expect(await page.locator("body").evaluate(element => getComputedStyle(element).fontSize)).toBe("20px");
  await dispatchWebviewMessage(page, { type: "branchFilterOptions", filter: snapshot() });
  await page.getByRole("button", { name: /Filter visible branches/ }).click();
  const menu = page.locator("#graph-branch-filter-menu"), rows = menu.locator(".branch-filter-row");
  const first = await rows.first().boundingBox();
  const list = menu.locator(".branch-filter-list"), before = await list.evaluate(element => element.scrollHeight);
  const last = rows.last().getByRole("checkbox"); await last.focus(); await last.press("Space");
  await expect(last).toBeFocused(); await expect(last).not.toBeChecked();
  const final = await rows.last().boundingBox(); expect(first!.height).toBeCloseTo(final!.height, 0);
  expect(await list.evaluate(element => element.scrollHeight)).toBeCloseTo(before, 0);
  // VS Code가 공식 제공하는 모드 클래스를 재현한다. VoiceOver/NVDA 세션 자체를 실행하는 검사는 아니다.
  await page.locator("body").evaluate(element => element.classList.add("vscode-using-screen-reader"));
  expect(await rows.first().evaluate(element => getComputedStyle(element).contentVisibility)).toBe("visible");
  const accessibility = await page.context().newCDPSession(page);
  await accessibility.send("Accessibility.enable");
  await expect.poll(async () => {
    const tree = await accessibility.send("Accessibility.getFullAXTree");
    return tree.nodes.filter((node: { ignored: boolean; role?: { value: string } }) => !node.ignored && node.role?.value === "checkbox").length;
  }).toBe(1001);
  await accessibility.detach();
});

test("local and compact changes preserve a selected remote that has not hydrated yet", async ({ page }) => {
  await mountGraphRenderer(page, false, { branchFilter: true });
  const initial = snapshot(2), waiting = "origin/not-loaded-yet";
  await dispatchWebviewMessage(page, { type: "branchFilterOptions", filter: { ...initial, mode: "custom", selected: [waiting],
    remoteStatus: "pending", branches: initial.branches.map(branch => ({ ...branch, checked: false })) } });
  await page.getByRole("button", { name: /Filter visible branches/ }).click();
  const menu = page.locator("#graph-branch-filter-menu");
  await menu.locator("[data-branch-filter-checkbox]").first().check();
  await menu.getByRole("checkbox", { name: "Compact graph" }).uncheck();
  const posted = await readPostedMessages(page), latest = posted.at(-1);
  expect(latest).toMatchObject({ type: "setBranchFilter", mode: "custom", compact: false });
  expect(latest.branches).toContain(waiting); expect(latest.branches).toContain(initial.branches[0].name);
});
