import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { mountList, overview } from "./prListHarness";
import { dispatchWebviewMessage, readPostedMessages } from "./webviewHarness";

/** 밝은 테마에서도 제품이 소유하지 않는 VS Code 토큰을 그대로 사용하게 한다. */
const light = `html,body{color-scheme:light;--vscode-foreground:#333;--vscode-descriptionForeground:#616161;--vscode-editor-background:#fff;--vscode-sideBar-background:#f3f3f3;--vscode-editorWidget-background:#f3f3f3;--vscode-icon-foreground:#424242;--vscode-button-secondaryForeground:#333;--vscode-disabledForeground:#616161;--vscode-input-background:#fff;--vscode-input-foreground:#333;--vscode-panel-border:#b9b9b9;--vscode-list-hoverBackground:#e8e8e8;--vscode-toolbar-hoverBackground:#ddd;--vscode-gitDecoration-addedResourceForeground:#24752b;--vscode-gitDecoration-deletedResourceForeground:#a31515;--vscode-gitDecoration-renamedResourceForeground:#075f99;--vscode-editorWarning-foreground:#795e00}`;

for (const [theme, width, height] of [["light",390,844],["high-contrast",768,1024],["dark",1440,900]] as const) {
  test(`PR list hierarchy, reviewer disclosure and accessible actions in ${theme} at ${width}px`, async ({page}) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({width,height}); await mountList(page,false);
    if (theme === "light") await page.addStyleTag({content:light});
    if (theme === "high-contrast") {
      // 강제 색상은 실제 화면을 시스템 색으로 바꾼다. fixture의 VS Code 토큰도 같은 색으로 맞춰
      // axe가 적용 전 어두운 글자 토큰과 적용 후 흰 배경을 섞어 계산하지 않게 한다.
      await page.addStyleTag({content:`html,body{--vscode-foreground:CanvasText;--vscode-descriptionForeground:CanvasText;--vscode-editor-background:Canvas;--vscode-editorWidget-background:Canvas;--vscode-sideBar-background:Canvas;--vscode-panel-border:CanvasText;--vscode-icon-foreground:CanvasText;--vscode-input-background:Canvas;--vscode-input-foreground:CanvasText;--vscode-gitDecoration-addedResourceForeground:CanvasText;--vscode-gitDecoration-renamedResourceForeground:CanvasText;--vscode-gitDecoration-deletedResourceForeground:CanvasText}`});
      await page.emulateMedia({forcedColors:"active",reducedMotion:"reduce"});
    }
    const prs = ["OPEN","OPEN","MERGED","CLOSED"].map((state,i) => ({...overview(true).pullRequests[0],
      number:42+i, state, isDraft:i===1, author:i===3 ? "" : "frontend-maintainer", updatedAt:i===3 ? "invalid" : "2026-10-21T04:20:00Z",
      title:i===0 ? "Improve pull request review context and preserve author and reviewer visibility in narrow editor panes" : `PR ${i+1}: ${state.toLowerCase()} change`,
      reviewers:i===2 ? [] : i===3 ? undefined : [{login:"requested-reviewer",kind:"user",state:"REQUESTED"},
        {login:"approved-reviewer",kind:"user",state:"APPROVED"}, {login:"platform-team",name:"Platform team",kind:"team",state:"CHANGES_REQUESTED"}],
      reviewersComplete:i!==0, reviewDecision:i===0 ? "REVIEW_REQUIRED" : i===1 ? "APPROVED" : undefined }));
    await dispatchWebviewMessage(page,{type:"pullRequestOverview",overview:{...overview(true),pullRequests:prs}});
    await page.getByRole("button",{name:"Show pull requests",exact:true}).click();
    const first = page.locator('[data-show-pr="42"]');
    await expect(first.locator(".pr-title")).toHaveText(/#42Improve pull request review context/);
    await expect(first.locator(".pr-meta-chips")).toContainText("Review required");
    await expect(page.locator(".pr-status")).toHaveText(["Open","Draft","Merged","Closed"]);
    await expect(page.locator('[data-show-pr="44"] .pr-reviewers')).toContainText("No reviewers");
    await expect(page.locator('[data-show-pr="45"] .pr-author')).toContainText("Unknown author");
    await expect(page.locator('[data-show-pr="45"] .pr-reviewers')).toContainText("Reviewers unavailable");
    await expect(page.locator('[data-show-pr="45"] time')).toHaveCount(0);
    const more = first.locator("[data-pr-reviewers-toggle]");
    await expect(more).toHaveAccessibleName("Show all 3 loaded reviewers");
    await more.focus(); await page.keyboard.press("Space");
    await expect(more).toHaveAttribute("aria-expanded","true");
    await expect(first.locator(".pr-reviewers")).toContainText("@platform-teamChanges requested");
    await expect(first.locator(".pr-reviewers")).toContainText("Partial reviewer list");
    expect((await readPostedMessages(page)).filter((m:any) => m.type==="refreshPullRequestDetail")).toHaveLength(0);
    const audit = await new AxeBuilder({page}).include("#detail").analyze();
    await writeFile(`/private/tmp/gsc-pr-list33-a11y-${theme}.json`, JSON.stringify(audit,null,2));
    expect(audit.violations.map(item => ({id:item.id,targets:item.nodes.map(node=>node.target)}))).toEqual([]);
    expect(await page.locator("#detail").evaluate(node => node.scrollWidth <= node.clientWidth+1 &&
      [...node.querySelectorAll(".pr-card-heading,.pr-reviewer,.pr-updated,.pr-actions")].every(child => {
        const rect = child.getBoundingClientRect(), panel = node.getBoundingClientRect(); return rect.left >= panel.left && rect.right <= panel.right+1;
      }))).toBe(true);
    await page.mouse.move(0,height-1); await more.blur();
    await page.screenshot({path:`/private/tmp/gsc-pr-list33-${theme}-${width}.png`,fullPage:true});
    await first.locator(".pr-card-heading").focus(); await page.keyboard.press("Enter");
    await expect(page.locator(".pr-detail-title")).toContainText("#42");
    expect((await readPostedMessages(page)).filter((m:any) => m.type==="refreshPullRequestDetail")).toHaveLength(1);
    expect(errors).toEqual([]);
  });
}
