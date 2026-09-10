import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadWebviewFixture } from "../helpers/webviewFixture";
import { mountChanges, readPostedMessages } from "./webviewHarness";

/** 테스트 브라우저에 VS Code가 실제로 제공하는 테마 변수와 아이콘 폰트만 설정한다. */
async function hostTheme(page: Page): Promise<void> {
  const font = (await readFile(join(process.cwd(), "media/codicons/codicon.ttf"))).toString("base64");
  await page.addStyleTag({ content: `
    @font-face { font-family: gsc-test-codicon; src: url(data:font/ttf;base64,${font}) format("truetype"); }
    .codicon[class*="codicon-"] { font-family: gsc-test-codicon !important; }
    :root {
      --vscode-font-family: -apple-system,BlinkMacSystemFont,sans-serif; --vscode-font-size: 13px;
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
    }
    body { background: var(--vscode-editor-background); }
  ` });
}

const viewports = [{ width: 280, height: 844 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }];
for (const locale of ["en", "ko"] as const) {
  for (const viewport of viewports) {
    test(`stale branch cleanup is reachable from the real Changes menu: ${locale} ${viewport.width}px`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setViewportSize(viewport);
      await mountChanges(page, await loadWebviewFixture("changes.small.en.json"));
      await hostTheme(page);
      const nls = JSON.parse(await readFile(locale === "en" ? "package.nls.json" : "package.nls.ko.json", "utf8"));
      const label = nls["cmd.cleanupStaleBranches"];
      // 실제 host와 같이 SCM 트리의 하위 메뉴에 넣어, 섹션 메뉴가 이 액션을 선택해 노출하는지 검증한다.
      await page.evaluate(label => {
        (window as any).__gscMenu.push(
          { label: "Branch", submenu: [{ id: "cleanupStaleBranches", label }] },
          { label: "Remote", submenu: [{ id: "configureRemoteBranch", label: "Set Remote Branch..." }] },
        );
      }, label);
      const anchor = page.locator('.section[data-section="changes"] .meatball');
      await page.locator('.section[data-section="changes"] > .section-header').hover();
      await anchor.click();
      const action = page.getByRole("menuitem", { name: label, exact: true });
      await expect(action).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Set Remote Branch...", exact: true })).toBeVisible();
      for (const attribute of ["title", "data-tooltip", "aria-label"]) await expect(action).toHaveAttribute(attribute, label);
      const bounds = await page.getByRole("menu").boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      await action.focus();
      await expect(action).toBeFocused();
      const screenshot = testInfo.outputPath(`stale-branch-menu-${locale}-${viewport.width}.png`);
      await page.screenshot({ path: screenshot });
      await testInfo.attach(`stale-branch-menu-${locale}-${viewport.width}.png`, { path: screenshot, contentType: "image/png" });
      await page.keyboard.press("Enter");
      expect(await readPostedMessages(page)).toContainEqual({ type: "scmAction", action: "cleanupStaleBranches" });
      await expect(page.getByRole("menu")).toHaveCount(0);

      // 같은 메뉴의 기존 보기 전환과 Escape 포커스 복원도 유지되는지 확인한다.
      await anchor.click();
      await page.keyboard.press("Escape");
      await expect(anchor).toBeFocused();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await anchor.click();
      await page.getByRole("menuitem", { name: /View as (List|Tree)/ }).click();
      expect(await readPostedMessages(page)).toContainEqual({ type: "toggleViewMode", section: "changes" });
      expect(errors).toEqual([]);
    });
  }
}
