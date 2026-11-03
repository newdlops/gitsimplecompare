import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { join } from "node:path";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { dispatchWebviewMessage, mountChanges, readPostedMessages } from "./webviewHarness";

let splitHtml: string;
test.beforeAll(async () => {
  const root = process.cwd(), result = await build({ stdin: { contents: `
    import { SplitPanel } from './src/webview/splitPanel'; import { Uri } from 'vscode'; import { join } from 'node:path';
    const resource = (file:string):any => ({fsPath:file,toString:()=>file,with:()=>resource(file)});
    (Uri as any).joinPath = (base:any,...parts:string[]) => resource(join(base.fsPath,...parts));
    export const html = (SplitPanel.prototype as any).buildHtml.call({extensionUri: resource(${JSON.stringify(root)}),
      panel:{webview:{asWebviewUri:(uri:any)=>uri,cspSource:'https://fixture'}}});`, resolveDir: root, loader: "ts" },
  bundle: true, platform: "node", format: "cjs", write: false, alias: { vscode: join(root, "test/helpers/vscodeMock.ts") } });
  const module = { exports: {} as { html: string } };
  new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(join(root, "package.json")), module, module.exports);
  splitHtml = module.exports.html;
});

/** 실제 SplitPanel HTML과 renderer를 사용하고 VS Code의 메시지 transport만 브라우저 fixture로 대체한다. */
async function mountSplit(page: Page) {
  await page.setContent(splitHtml.replace(/<meta[^>]*Content-Security-Policy[^>]*>/gi, "")
    .replace(/<link[^>]*>/g, "").replace(/<script[^>]*src=[^>]*><\/script>/g, ""));
  await page.evaluate(() => {
    const w = window as any; w.__gscFixtureMessages = [];
    w.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => w.__gscFixtureMessages.push(message) });
  });
  for (const name of ["shared/reset.css", "shared/tokens.css", "shared/controls.css", "split/split.css"]) {
    await page.addStyleTag({ path: join(process.cwd(), "media", name) });
  }
  await page.addStyleTag({ content: `:root{--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#252526;--vscode-panel-border:#555;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-descriptionForeground:#aaa;--vscode-focusBorder:#007fd4}` });
  for (const name of ["splitEditableDiff.js", "splitDeferredFiles.js", "split.js"]) {
    await page.addScriptTag({ path: join(process.cwd(), "media/split", name) });
  }
}

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
  test(`stash pagination retains rows through loading, errors and retry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await loadWebviewFixture<any>("changes.small.en.json");
    fixture.payload.stashes = [{ ref: "stash@{0}", hash: "a".repeat(40), message: "Saved work", branch: "main", date: "now" }];
    fixture.payload.stashPagination = { hasMore: true, loading: false };
    await mountChanges(page, fixture);
    const section = page.locator('.section[data-section="stashes"]');
    if (await section.evaluate(element => element.classList.contains("collapsed"))) await section.locator(":scope > .section-header").click();
    const more = page.getByRole("button", { name: "Load more stashes", exact: true });
    await expect(more).toHaveAttribute("title", "Load more stashes"); await more.focus(); await page.keyboard.press("Enter");
    expect((await readPostedMessages(page)).filter((message: any) => message.type === "loadMoreStashes")).toHaveLength(1);
    await expect(more).toBeDisabled();
    fixture.payload.stashPagination = { hasMore: true, loading: true };
    await dispatchWebviewMessage(page, { type: "render", payload: fixture.payload });
    await expect(page.getByRole("button", { name: "Loading more stashes..." })).toBeDisabled();
    await expect(page.locator(".stash")).toHaveCount(1);
    fixture.payload.stashPagination = { hasMore: true, loading: false, error: "Could not load more stashes. Try again." };
    await dispatchWebviewMessage(page, { type: "render", payload: fixture.payload });
    await expect(section.getByRole("alert")).toBeVisible(); await expect(more).toBeEnabled();
    await more.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/stash-pagination-${width}.png` });
    await more.click();
    fixture.payload.stashes.push({ ref: "stash@{1}", hash: "b".repeat(40), message: "Older saved work" });
    fixture.payload.stashPagination = { hasMore: false, loading: false };
    await dispatchWebviewMessage(page, { type: "render", payload: fixture.payload });
    await expect(page.locator(".stash")).toHaveCount(2); await expect(more).toHaveCount(0);
  });

  test(`deferred split details preserve partial selection and retry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height }); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await mountSplit(page);
    const file = { stage: "unstaged", path: "new.txt", header: "new file mode 100644", binary: false, hunks: [], deferred: true };
    await dispatchWebviewMessage(page, { type: "changes", files: [file], generation: 1 });
    await expect(page.locator("#hunks")).toContainText("Loading file changes...");
    await expect(page.locator("#select-file")).toBeDisabled();
    expect((await readPostedMessages(page)).filter((message: any) => message.type === "loadFileDetails")).toEqual([{ type: "loadFileDetails", path: "new.txt", generation: 1 }]);
    await dispatchWebviewMessage(page, { type: "fileDetailsError", path: file.path, generation: 1, message: "Read failed. Try again." });
    await expect(page.locator("#hunks").getByRole("alert")).toHaveText("Read failed. Try again.");
    const retry = page.locator("#hunks").getByRole("button", { name: "Load file changes" }); await retry.focus(); await page.keyboard.press("Enter");
    const loaded = { ...file, deferred: undefined, hunks: [{ id: "unstaged:new.txt#0", text: "@@ -0,0 +1,2 @@\n+one\n+two" }] };
    await dispatchWebviewMessage(page, { type: "fileDetails", path: file.path, generation: 0, files: [loaded] });
    await expect(page.locator("#hunks")).toContainText("Loading file changes...");
    await dispatchWebviewMessage(page, { type: "fileDetails", path: file.path, generation: 1, files: [loaded], workingFile: { path: file.path, baseText: "", text: "one\ntwo\n" } });
    await expect(page.locator("#select-file")).toBeEnabled(); await page.locator("#select-file").click();
    await expect(page.locator("#commit")).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const changed = await page.locator(".right-edit").first().boundingBox();
    expect(changed!.x).toBeGreaterThanOrEqual(0); expect(changed!.x + changed!.width).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `test-results/split-deferred-${width}.png` });
    await page.locator("#commit").click();
    const staged = (await readPostedMessages(page)).find((message: any) => message.type === "stage");
    expect(staged.selections[0]).toMatchObject({ path: file.path, stage: "unstaged", binary: false });
    expect(errors).toEqual([]);
  });
}
