import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { dispatchWebviewMessage, mountChanges, readPostedMessages } from "./webviewHarness";

const hash = "a".repeat(40);
const firstRoot = "/fixture/first repository";
const secondRoot = "/fixture/second repository";
const stashMessage = "작업 중인 변경 — preserve selected stash across repositories and list updates";

/** VS Code가 주입하는 테마 변수만 브라우저 fixture에 제공한다. 제품 CSS는 그대로 사용한다. */
async function hostTheme(page: Page): Promise<void> {
  const font = (await readFile(join(process.cwd(), "media/codicons/codicon.ttf"))).toString("base64");
  await page.addStyleTag({ content: `
    @font-face { font-family: gsc-test-codicon; src: url(data:font/ttf;base64,${font}) format("truetype"); }
    .codicon[class*="codicon-"] { font-family: gsc-test-codicon !important; }
    :root {
    --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif; --vscode-font-size: 13px;
    --vscode-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d;
    --vscode-editor-background: #1e1e1e; --vscode-sideBar-background: #252526;
    --vscode-sideBarSectionHeader-background: #303030; --vscode-editorWidget-background: #252526;
    --vscode-panel-border: #454545; --vscode-widget-border: #454545;
    --vscode-input-background: #3c3c3c; --vscode-input-foreground: #cccccc;
    --vscode-focusBorder: #007fd4; --vscode-button-background: #0e639c; --vscode-button-foreground: white;
    --vscode-list-hoverBackground: #2a2d2e; --vscode-list-activeSelectionBackground: #094771;
    --vscode-menu-background: #252526; --vscode-menu-foreground: #cccccc;
    --vscode-menu-selectionBackground: #094771; --vscode-menu-selectionForeground: white;
    --vscode-menu-border: #454545; --vscode-icon-foreground: #c5c5c5;
  } body { background: var(--vscode-editor-background); }` });
}

/** stash section이 접혀 있으면 사용자 disclosure 동작으로 연다. */
async function revealStashes(page: Page): Promise<void> {
  const section = page.locator('.section[data-section="stashes"]');
  if (await section.evaluate(element => element.classList.contains("collapsed"))) {
    await section.locator(":scope > .section-header").click();
  }
}

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
  test(`stash selection remains bound to the rendered repository at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = await loadWebviewFixture<any>("changes.small.en.json");
    fixture.payload.commit.repoRoot = firstRoot;
    fixture.payload.repos = [{ root: firstRoot, name: "first repository", branch: "main", active: true }];
    fixture.payload.stashes = [{ ref: "stash@{0}", hash, index: 0, message: stashMessage, branch: "main", date: "2 minutes ago" }];
    // 기존 section 표시 설정을 사용해 현재 검증할 Stashes 작업 영역을 충분히 노출한다.
    Object.assign(fixture.payload.visibleSections, { history: false, compare: false, worktrees: false });
    await mountChanges(page, fixture);
    await hostTheme(page);
    await revealStashes(page);
    const stash = page.locator(".stash");
    const header = stash.locator(".stash-header");
    await expect(header).toHaveAttribute("title", `Expand ${stashMessage}`);
    await header.focus();
    await page.keyboard.press("Enter");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(stash).toHaveAttribute("aria-busy", "true");
    expect((await readPostedMessages(page)).find((message: any) => message.type === "loadStashFiles"))
      .toMatchObject({ ref: "stash@{0}", hash, repoRoot: firstRoot, stashKey: `${firstRoot}@${hash}` });

    for (const [label, type] of [["Apply Stash", "applyStash"], ["Pop Stash", "popStash"],
      ["Create Branch from Stash", "branchStash"], ["Drop Stash", "dropStash"]]) {
      await header.hover();
      const button = stash.locator('[data-act="stashMenu"]');
      await expect(button).toHaveAttribute("title", "More Actions...");
      await button.click();
      const item = page.getByRole("menuitem", { name: label, exact: true });
      await expect(item).toHaveAttribute("title", label);
      if (type === "applyStash") { await item.focus(); await page.keyboard.press("Enter"); }
      else await item.click();
      expect((await readPostedMessages(page)).find((message: any) => message.type === type))
        .toMatchObject({ ref: "stash@{0}", hash, repoRoot: firstRoot });
    }

    // 같은 hash/번호가 다른 저장소에도 있을 때 이전 저장소의 늦은 응답이 새 요청을 완료시키지 않는다.
    fixture.payload.commit.repoRoot = secondRoot;
    fixture.payload.repos = [{ root: secondRoot, name: "second repository", branch: "main", active: true }];
    await dispatchWebviewMessage(page, { type: "render", payload: fixture.payload });
    await header.click();
    await expect(stash).toHaveAttribute("aria-busy", "true");
    await dispatchWebviewMessage(page, { type: "stashFilesLoadComplete", ref: "stash@{0}", stashKey: `${firstRoot}@${hash}`,
      result: { ref: "stash@{0}", key: `${firstRoot}@${hash}`, files: [{ path: "wrong-repository.txt", status: "M" }] } });
    await expect(stash).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".stash-file")).toHaveCount(0);

    // 조회 실패 후 disclosure를 다시 열면 요청을 재시도하며 성공한 파일만 현재 저장소에 연결한다.
    await dispatchWebviewMessage(page, { type: "stashFilesLoadComplete", ref: "stash@{0}", stashKey: `${secondRoot}@${hash}` });
    await expect(stash).not.toHaveAttribute("aria-busy", "true");
    await header.click();
    await header.click();
    await expect(stash).toHaveAttribute("aria-busy", "true");
    await dispatchWebviewMessage(page, { type: "stashFilesLoadComplete", ref: "stash@{0}", stashKey: `${secondRoot}@${hash}`,
      result: { ref: "stash@{1}", key: `${secondRoot}@${hash}`, files: [{ path: "src/very-long-directory-name/선택한 파일.ts", status: "M" }] } });
    const file = page.locator(".stash-file");
    await expect(file).toBeVisible();
    await file.click();
    expect((await readPostedMessages(page)).find((message: any) => message.type === "openStashFile"))
      .toMatchObject({ hash, repoRoot: secondRoot, path: "src/very-long-directory-name/선택한 파일.ts" });
    await header.hover();
    await stash.locator('[data-act="stashMenu"]').click();
    await expect(page.getByRole("menuitem", { name: "Drop Stash", exact: true })).toBeVisible();
    expect(await page.locator("#root").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.mouse.move(5, 5);
    await testInfo.attach(`stash-selection-${viewport.width}.png`, { body: await page.screenshot(), contentType: "image/png" });
    await page.screenshot({ path: `/tmp/gsc-stash-selection-${viewport.width}.png` });
    await page.keyboard.press("Escape");
    await expect(stash.locator('[data-act="stashMenu"]')).toBeFocused();
    fixture.payload.stashes = [];
    await dispatchWebviewMessage(page, { type: "render", payload: fixture.payload });
    await expect(page.getByText("No stashes.", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
