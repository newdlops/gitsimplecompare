import { expect, test, type Page } from "@playwright/test";
import { dispatchWebviewMessage, mountGraphRenderer, readPostedMessages } from "./webviewHarness";

const actions = [["fetch-graph", "fetch"], ["fetch-tags-graph", "fetchTags"], ["pull-graph", "pull"],
  ["push-graph", "push"], ["force-push-graph", "forcePush"]] as const;

/**
 * 실제 graph renderer에 많은 행을 넣고 기존 선택·스크롤을 유지하는 상태에서 액션을 검증한다.
 * @param page Chromium 페이지 @returns CPU 6배 지연을 적용한 CDP 세션
 */
async function mountDenseGraph(page: Page) {
  await mountGraphRenderer(page, true);
  await page.evaluate(() => {
    const rows = Array.from({ length: 1500 }, (_, index) => ({ hash: `hash-${index}`, parents: index < 1499 ? [`hash-${index + 1}`] : [],
      refs: index === 0 ? ["HEAD", "feature/long-branch-name-for-responsive-sync"] : [], subject: `Commit ${index}: preserve editing and responsive branch operations`,
      authorName: "Fixture", authorEmail: "fixture@example.test", dateIso: "2026-10-17T00:00:00Z", color: 0, column: 0 }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "graph", data: { rows, edges: [], laneCount: 1 },
      state: { loadedCount: rows.length, hasMore: false, hasMoreBefore: false, loading: false, reset: true, colorScope: "/fixture" } } }));
    const w = window as any, push = w.__gscFixtureMessages.push.bind(w.__gscFixtureMessages);
    w.__syncFeedback = [];
    w.__gscFixtureMessages.push = (message: any) => {
      const id = ({ fetch: "fetch-graph", fetchTags: "fetch-tags-graph", pull: "pull-graph", push: "push-graph", forcePush: "force-push-graph" } as any)[message.type];
      if (id) w.__syncFeedback.push({ type: message.type, busyBeforeIPC: document.getElementById(id)?.getAttribute("aria-busy") === "true" });
      return push(message);
    };
  });
  await page.keyboard.press("Escape");
  await page.locator('#graph-content > .row[data-hash="hash-0"]').click();
  await page.keyboard.press("Escape");
  await page.locator("#graph").evaluate(element => { element.scrollTop = 3000; });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  return cdp;
}

for (const width of [390, 768, 1440]) {
  test(`sync actions show pending before IPC and preserve a dense graph at ${width}px`, async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); });
    await mountDenseGraph(page);
    const before = await page.locator("#graph").evaluate(element => element.scrollTop);
    for (const [id, type] of actions) {
      const button = page.locator(`#${id}`);
      const original = await button.locator(".codicon").getAttribute("class");
      await button.click();
      await expect(button).toHaveAttribute("aria-busy", "true"); await expect(button).toBeDisabled();
      await button.dispatchEvent("click");
      expect((await readPostedMessages(page)).filter((message: any) => message.type === type)).toHaveLength(1);
      await dispatchWebviewMessage(page, { type: "graphBusy", key: id, busy: true });
      await dispatchWebviewMessage(page, { type: "graphBusy", key: id, busy: false });
      await expect(button).toBeEnabled(); await expect(button.locator(".codicon")).toHaveAttribute("class", original!);
      await button.focus(); await button.press("Enter");
      expect((await readPostedMessages(page)).filter((message: any) => message.type === type)).toHaveLength(2);
      await dispatchWebviewMessage(page, { type: "graphBusy", key: id, busy: false });
    }
    const observed = await page.evaluate(() => (window as any).__syncFeedback);
    expect(observed).toHaveLength(10); expect(observed.every((item: any) => item.busyBeforeIPC)).toBe(true);
    await expect(page.locator('#graph-content > .row.selected[data-hash="hash-0"]')).toHaveCount(1);
    expect(await page.locator("#graph").evaluate(element => element.scrollTop)).toBe(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(errors).toEqual([]);
    await page.locator("#fetch-graph").click();
    await expect(page.locator("#fetch-graph .codicon")).toHaveClass(/codicon-loading/);
    await page.screenshot({ path: info.outputPath(`graph-action-${width}.png`) });
  });
}

test("failed or cancelled actions restore controls and reduced motion keeps a static pending icon", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mountDenseGraph(page);
  await page.locator("#pull-graph").click();
  await expect(page.locator("#pull-graph")).toBeDisabled();
  await expect(page.locator("#pull-graph .codicon")).not.toHaveClass(/codicon-modifier-spin/);
  await dispatchWebviewMessage(page, { type: "graphBusy", key: "pull-graph", busy: false });
  await dispatchWebviewMessage(page, { type: "error", message: "Pull failed. Check Git Simple Compare Output." });
  await expect(page.locator("#pull-graph")).toBeEnabled();
  await expect(page.locator("#detail")).toContainText("Pull failed");
  await page.locator("#force-push-graph").click();
  await dispatchWebviewMessage(page, { type: "graphBusy", key: "force-push-graph", busy: false });
  await expect(page.locator("#force-push-graph")).toBeEnabled();
});

test("a late completion cannot change a replacement detail button or enable a previously disabled control", async ({ page }) => {
  await mountGraphRenderer(page, true);
  const state = await page.evaluate(() => {
    const w = window as any, button = document.getElementById("push-graph") as HTMLButtonElement;
    button.disabled = true;
    w.GscGraphActionFeedback.setBusy(button.id, true); w.GscGraphActionFeedback.setBusy(button.id, false);
    const keptDisabled = button.disabled;
    button.disabled = false; w.GscGraphActionFeedback.setBusy(button.id, true);
    const replacement = document.createElement("button"); replacement.id = button.id; replacement.disabled = true;
    replacement.innerHTML = '<span class="codicon codicon-check"></span>'; button.replaceWith(replacement);
    w.GscGraphActionFeedback.setBusy(replacement.id, false);
    return { keptDisabled, replacementDisabled: replacement.disabled, icon: replacement.querySelector("span")?.className };
  });
  expect(state).toEqual({ keptDisabled: true, replacementDisabled: true, icon: "codicon codicon-check" });
});
