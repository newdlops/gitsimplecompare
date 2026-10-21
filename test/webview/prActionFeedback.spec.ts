import { expect, test } from "@playwright/test";
import { dispatchWebviewMessage, readPostedMessages } from "./webviewHarness";
import { mountList, overview } from "./prListHarness";

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`PR action pending, completion, keyboard and reduced motion at ${width}px`, async ({ page }, info) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height }); await page.emulateMedia({ reducedMotion: "reduce" });
    await mountList(page, width === 390);
    // 목록 fixture의 단순 transport를 production feedback 경유로 연결한다. 알림/Native 안전성은 별도 router 테스트가 검증한다.
    await page.evaluate(() => {
      const w = window as any;
      w.GscGraphPostMessage = (message: unknown) => w.GscGraphActionFeedback.post({
        postMessage: (value: unknown) => w.__gscFixtureMessages.push(structuredClone(value)),
      }, message);
    });
    await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: overview(true) });
    await page.getByRole("button", { name: "Show pull requests", exact: true }).click();
    const button = page.locator("#pr-op-42-squash");
    await expect(button).toHaveAttribute("title", "Squash cherry-pick PR #42");
    await expect(button).toHaveAttribute("aria-label", "Squash cherry-pick PR #42");
    await button.focus(); await page.keyboard.press("Enter");
    await expect(button).toBeDisabled(); await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(button.locator(".codicon")).toHaveClass(/codicon-loading/);
    await expect(button.locator(".codicon")).not.toHaveClass(/codicon-modifier-spin/);
    await button.dispatchEvent("click");
    expect((await readPostedMessages(page)).filter((message: any) => message.type === "pullRequestAction")).toHaveLength(1);
    await page.mouse.move(0, height - 1); await page.screenshot({ path: info.outputPath(`pr-action-pending-${width}.png`) });
    await dispatchWebviewMessage(page, { type: "graphBusy", key: "pr-op-42-squash", busy: false });
    await expect(button).toBeEnabled(); await expect(button).not.toHaveAttribute("aria-busy", "true");
    await expect(button.locator(".codicon")).toHaveClass(/codicon-combine/);
    await button.focus(); await expect(button).toBeFocused();
    await page.screenshot({ path: info.outputPath(`pr-action-completed-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  });
}
