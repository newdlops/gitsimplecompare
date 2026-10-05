import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { dispatchWebviewMessage, mountChanges, readPostedMessages } from "./webviewHarness";

/** 실제 native History와 같은 불변 OID/rename/통계를 가진 표시 fixture다. */
function commits(count: number) {
  return Array.from({ length: count }, (_, index) => ({ hash: (index + 1).toString(16).padStart(40, "0"),
    shortHash: (index + 1).toString(16).padStart(7, "0"), baseRef: "a".repeat(40),
    title: `파일 이력과 변경 통계를 보존하는 긴 커밋 제목 ${index + 1}`, message: "Title\n\nFull commit message",
    author: "History author", dateIso: "2026-10-06T00:00:00Z", relativeDate: "2 days ago",
    status: "R", path: "src/long-directory/renamed-file-with-a-long-name.ts", oldPath: "src/old-file.ts", additions: 3, deletions: 2 }));
}

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
  test(`History loading, usable first commits and full completion preserve focus at ${viewport.width}px`, async ({ page }, info) => {
    const errors: Error[] = []; page.on("pageerror", error => errors.push(error));
    const fixture: any = await loadWebviewFixture("changes.small.en.json");
    await page.setViewportSize(viewport);
    const records = commits(27), history = { repoRoot: "/fixture/demo", path: records[0].path, commits: [], loading: true };
    await mountChanges(page, { ...fixture, payload: { ...fixture.payload, history } });
    const font = (await readFile("media/codicons/codicon.ttf")).toString("base64");
    await page.addStyleTag({ content: `@font-face{font-family:codicon;src:url(data:font/ttf;base64,${font}) format("truetype")}\n:root {
      --vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;
      --vscode-editor-font-family:Menlo,monospace;--vscode-editor-font-size:12px;
      --vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-disabledForeground:#777777;
      --vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#181818;--vscode-panel-border:#2b2b2b;
      --vscode-input-background:#313131;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;
      --vscode-button-background:#007acc;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#0062a3;
      --vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#ffffff;
      --vscode-focusBorder:#007fd4;--vscode-widget-border:#454545;--vscode-list-hoverBackground:#2a2d2e;
      --vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;
      --vscode-badge-background:#4d4d4d;--vscode-badge-foreground:#ffffff;--vscode-gitDecoration-addedResourceForeground:#81b88b;
      --vscode-gitDecoration-modifiedResourceForeground:#e2c08d;--vscode-gitDecoration-deletedResourceForeground:#c74e39;
    }` });
    const section = page.locator('.section[data-section="history"]'), body = section.locator(".section-body");
    const header = section.locator(":scope > .section-header");
    if (await header.getAttribute("aria-expanded") === "false") await header.click();
    await expect(body.getByRole("status")).toHaveText("Loading file history...");
    await expect(body.getByText("No commits for the current file.")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`history-loading-${viewport.width}.png`) });
    const message = page.locator("#commit-msg"); await message.fill("Keep this draft while history loads");
    await dispatchWebviewMessage(page, { type: "render", payload: { ...fixture.payload, history: { ...history, commits: records.slice(0, 1) } } });
    await expect(message).toHaveValue("Keep this draft while history loads");
    await expect(body.getByRole("status")).toHaveText("Loading earlier commits...");
    const status = await body.getByRole("status").boundingBox(), bounds = await body.boundingBox();
    expect(status && bounds && status.y + status.height <= bounds.y + bounds.height).toBe(true);
    expect(status && status.x + status.width <= viewport.width).toBe(true);
    await expect(body.locator(".history-files")).toHaveAttribute("aria-busy", "true");
    await page.screenshot({ path: info.outputPath(`history-partial-${viewport.width}.png`) });
    const row = body.locator(".history-commit").first(); await row.focus(); await page.keyboard.press("Enter");
    await expect(row).toHaveAttribute("aria-expanded", "true");
    const diff = body.locator(".history-file-link").first();
    for (const attribute of ["title", "aria-label", "data-tooltip"]) expect(await diff.getAttribute(attribute)).toBeTruthy();
    await diff.focus();
    await dispatchWebviewMessage(page, { type: "render", payload: { ...fixture.payload, history: { ...history, commits: records, loading: false } } });
    await expect(diff).toBeFocused(); await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(body.locator(".history-item")).toHaveCount(27); await expect(body.getByRole("status")).toHaveCount(0);
    await expect(body.locator(".history-files")).toHaveAttribute("aria-busy", "false");
    await page.keyboard.press("Enter"); expect(await readPostedMessages(page)).toContainEqual({ type: "openFileHistoryCommit",
      repoRoot: history.repoRoot, path: records[0].path, oldPath: records[0].oldPath, baseRef: records[0].baseRef,
      headRef: records[0].hash, shortHash: records[0].shortHash, title: records[0].title });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`history-complete-${viewport.width}.png`) });
    await dispatchWebviewMessage(page, { type: "render", payload: { ...fixture.payload, history: { ...history, loading: false, message: "Could not load file history." } } });
    await expect(body.getByText("Could not load file history.")).toBeVisible(); await expect(body.getByRole("status")).toHaveCount(0);
    await dispatchWebviewMessage(page, { type: "render", payload: { ...fixture.payload, history: { ...history, loading: false } } });
    await expect(body.getByText("No commits for the current file.")).toBeVisible(); expect(errors).toEqual([]);
  });
}
