import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { graphRebaseResultProgress, graphRebaseStartingProgress } from "../../src/webview/graphRebaseProgress";
import { REBASE_RESTORE_CONFLICT_MESSAGE } from "../../src/git/rebasePlanSafety";
import { dispatchWebviewMessage, mountGraphRenderer, readPostedMessages } from "./webviewHarness";

for (const width of [390, 768, 1440]) {
  test(`external rebase completion removes paused controls and allows a new plan at ${width}px`, async ({ page }) => {
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
    const hash = "a".repeat(40);
    const plan = { branch: "feature/external-rebase", base: "b".repeat(40), baseReason: "selected",
      commits: [{ hash, subject: "Edit commit in the terminal", body: "", files: [] }] };
    await dispatchWebviewMessage(page, { type: "graph", data: {
      rows: [hash, plan.base].map((commit, index) => ({
        hash: commit, parents: index ? [] : [plan.base], refs: index ? ["main"] : ["HEAD"],
        authorName: "Fixture", authorEmail: "fixture@example.test", dateIso: "2026-09-10T00:00:00.000Z",
        subject: index ? "Base commit" : plan.commits[0].subject, color: 0, column: 0,
      })),
      edges: [{ fromRow: 0, toRow: 1, column: 0, fromColumn: 0, toColumn: 0, color: 0 }], laneCount: 1,
    }, state: { loadedCount: 2, hasMore: false, loading: false, reset: true } });
    await dispatchWebviewMessage(page, { type: "graphRebasePlan", plan });
    await page.getByRole("button", { name: "Start rebase", exact: true }).click();
    await dispatchWebviewMessage(page, { type: "graphRebasePaused", paused: {
      hash, originalHash: hash, parent: plan.base, subject: "Edit commit in the terminal", files: [],
    } });
    await expect(page.getByRole("button", { name: "Continue rebase", exact: true })).toBeVisible();
    await expect(page.locator("#graph-rebase-progress")).toContainText("Paused");
    await page.mouse.move(10, 240);
    await expect(page.getByRole("tooltip")).toBeHidden();
    await page.screenshot({ path: `/tmp/gsc-external-rebase-paused-${width}.png` });
    // native Git 종료 확인 뒤 production coordinator가 보내는 기존 정리 메시지다.
    await dispatchWebviewMessage(page, { type: "graphRebaseClear" });
    await expect(page.locator("#graph-rebase-bar")).toHaveCount(0);
    await expect(page.locator("#graph-rebase-progress")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveClass(/graph-rebase-mode/);
    await expect(page.locator(".row")).toHaveCount(2);
    await expect(page.locator(".rebase-row")).toHaveCount(0);
    await page.screenshot({ path: `/tmp/gsc-external-rebase-cleared-${width}.png` });
    await dispatchWebviewMessage(page, { type: "graphRebasePlan", plan });
    const start = page.getByRole("button", { name: "Start rebase", exact: true });
    await expect(start).toBeVisible();
    await start.focus();
    await page.keyboard.press("Enter");
    expect((await readPostedMessages(page)).filter((message: any) => message.type === "runGraphRebase")).toHaveLength(2);
    expect(errors).toEqual([]);
  });

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
