import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { dispatchWebviewMessage, mountPullRequestPreview, readPostedMessages } from "./webviewHarness";

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`preview lazy loading, retry, empty success and stale reply at ${width}px`, async ({ page }) => {
    const fixture: any = await loadWebviewFixture("pr-preview.populated.en.json");
    fixture.payload.requestId = 10; fixture.payload.conversationLoaded = false;
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await mountPullRequestPreview(page, fixture);
    const font = (await readFile(join(process.cwd(), "media/codicons/codicon.ttf"))).toString("base64");
    await page.addStyleTag({ content: `
      @font-face{font-family:gsc-preview-icons;src:url(data:font/ttf;base64,${font}) format('truetype')}
      .codicon[class*="codicon-"]{font-family:gsc-preview-icons!important}
      html,body{--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;
        --vscode-editor-font-family:Menlo,monospace;--vscode-editor-font-size:12px;
        --vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-disabledForeground:#777;
        --vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#252526;--vscode-editorWidget-background:#252526;
        --vscode-panel-border:#454545;--vscode-widget-border:#454545;--vscode-focusBorder:#007fd4;--vscode-icon-foreground:#c5c5c5;
        --vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#1177bb;
        --vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#fff;
        --vscode-input-background:#3c3c3c;--vscode-input-foreground:#ccc;--vscode-input-border:#454545;
        --vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#094771;--vscode-list-activeSelectionForeground:#fff;
        --vscode-errorForeground:#f48771;--vscode-gitDecoration-addedResourceForeground:#81b88b;
        --vscode-gitDecoration-deletedResourceForeground:#c74e39;--vscode-gitDecoration-modifiedResourceForeground:#e2c08d;
        --vscode-diffEditor-insertedTextBackground:#9ccc2c33;--vscode-diffEditor-removedTextBackground:#ff000033;}
    ` });
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole("status").filter({ hasText: "Loading conversation" })).toBeVisible();
    expect(await readPostedMessages(page)).toContainEqual({ type: "loadConversation", requestId: 10 });
    await dispatchWebviewMessage(page, { type: "previewConversation", requestId: 10, error: "Temporary network failure. Retry when the connection is available." });
    const retry = page.getByRole("button", { name: "Retry loading", exact: true });
    await expect(retry).toHaveAttribute("title", "Retry loading");
    await retry.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Loading conversation" })).toBeVisible();
    await dispatchWebviewMessage(page, { type: "previewConversation", requestId: 10, conversation: fixture.payload.conversation });
    await page.getByRole("tab", { name: /Commits/ }).click();
    await expect(page.getByText("Loading commit files…", { exact: true })).toBeVisible();
    await dispatchWebviewMessage(page, { type: "commitFiles", requestId: 9, hash: "1111111", files: [{ path: "stale.txt" }] });
    await expect(page.getByText("stale.txt", { exact: true })).toHaveCount(0);
    await dispatchWebviewMessage(page, { type: "commitFiles", requestId: 10, hash: "1111111", error: "Could not read this commit." });
    await expect(retry).toBeVisible();
    await page.mouse.move(2, 2);
    await page.screenshot({ path: `/tmp/gsc-pr-preview-error-${width}.png`, fullPage: true });
    await retry.click();
    await dispatchWebviewMessage(page, { type: "commitFiles", requestId: 10, hash: "1111111", files: [] });
    await expect(page.getByText("No changed files.", { exact: true })).toBeVisible();
    const before = (await readPostedMessages(page)).filter((message: any) => message.type === "loadCommitFiles").length;
    await page.getByRole("tab", { name: /Changed files/ }).click();
    await page.mouse.move(2, 2);
    await page.getByRole("tab", { name: /Commits/ }).click();
    expect((await readPostedMessages(page)).filter((message: any) => message.type === "loadCommitFiles").length).toBe(before);
    await page.getByRole("tab", { name: /Changed files/ }).click();
    await page.screenshot({ path: `/tmp/gsc-pr-preview-files-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  });
}
