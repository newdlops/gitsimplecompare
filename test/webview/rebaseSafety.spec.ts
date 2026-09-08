import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { graphRebaseResultProgress, graphRebaseStartingProgress } from "../../src/webview/graphRebaseProgress";
import { REBASE_RESTORE_CONFLICT_MESSAGE } from "../../src/git/rebasePlanSafety";
import { dispatchWebviewMessage, mountGraphRenderer, readPostedMessages } from "./webviewHarness";

for (const width of [390, 768, 1440]) {
  test(`rebase plan identity and persistent restore-conflict guidance at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await mountGraphRenderer(page);
    for (const file of ["graphRebase.css", "graphRebaseProgress.css"]) {
      await page.addStyleTag({ path: join(process.cwd(), "media/graph", file) });
    }
    for (const file of ["graphRebase.js", "graphRebaseProgress.js"]) {
      await page.addScriptTag({ path: join(process.cwd(), "media/graph", file) });
    }
    const checkout = { gitDir: "/fixture/.git", branch: "refs/heads/feature/rebase-safety", head: "a".repeat(40) };
    await dispatchWebviewMessage(page, { type: "graphRebasePlan", plan: {
      branch: "feature/rebase-safety", base: "b".repeat(40), baseReason: "selected", checkout,
      commits: [{ hash: checkout.head, subject: "Preserve user changes", body: "", files: [] }],
    } });
    const start = page.getByRole("button", { name: "Start rebase", exact: true });
    await expect(start).toHaveAttribute("title", "Start rebase");
    await start.focus();
    await page.keyboard.press("Enter");
    expect((await readPostedMessages(page)).find((message: any) => message.type === "runGraphRebase"))
      .toMatchObject({ checkout, base: "b".repeat(40), items: [{ hash: checkout.head, action: "pick" }] });
    await dispatchWebviewMessage(page, { type: "graphRebaseOperation", active: true });
    await expect(page.getByRole("button", { name: "Continue rebase", exact: true })).toBeVisible();
    await dispatchWebviewMessage(page, graphRebaseStartingProgress("continue"));
    await expect(page.locator("#graph-rebase-progress")).toContainText("Continuing rebase");
    await dispatchWebviewMessage(page, graphRebaseResultProgress("continue", { status: "conflicts" }));
    const proceed = page.getByRole("button", { name: "Continue rebase", exact: true });
    await expect(proceed).toBeEnabled();
    await proceed.click();
    expect((await readPostedMessages(page)).some((message: any) => message.type === "continueGraphRebase")).toBe(true);
    await page.mouse.click(380, 300);
    await expect(page.getByRole("tooltip")).toBeHidden();
    await page.screenshot({ path: `/tmp/gsc-72057-rebase-conflicts-${width}.png` });
    await dispatchWebviewMessage(page, graphRebaseResultProgress("continue", {
      status: "conflicts", restoringLocalChanges: true, message: REBASE_RESTORE_CONFLICT_MESSAGE,
    }));
    await dispatchWebviewMessage(page, { type: "graphRebaseOperation", active: false, restoringLocalChanges: true });
    const guidance = page.locator("#graph-rebase-progress");
    await expect(guidance).toBeVisible();
    await expect(guidance).toContainText("Local changes need conflict resolution");
    await expect(guidance).toContainText("autostash for recovery");
    await expect(page.locator("#graph-rebase-bar")).toHaveCount(0);
    await page.waitForTimeout(4700);
    await expect(guidance).toBeVisible();
    expect(await guidance.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await guidance.locator(".rebase-progress-detail").evaluate(element =>
      element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).toBe(true);
    await page.screenshot({ path: `/tmp/gsc-rebase-safety-${width}.png` });
    expect(errors).toEqual([]);
    await dispatchWebviewMessage(page, graphRebaseResultProgress("continue", { status: "completed" }));
    await expect(guidance).toContainText("Rebase completed");
    await expect(guidance).toContainText("Graph and Changes refresh in the background.");
    await page.screenshot({ path: `/tmp/gsc-72057-rebase-completed-${width}.png` });
  });
}
