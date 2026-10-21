import { expect, test } from "@playwright/test";
import { dispatchWebviewMessage, readPostedMessages } from "./webviewHarness";
import { mountList, overview } from "./prListHarness";

for (const [width, height] of [[390,844],[768,1024],[1440,900]]) {
  test(`PR people stay readable, searchable and keyboard operable with eighty rows at ${width}px`, async ({page}) => {
    const ko = width === 390, errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({width,height}); await mountList(page,ko);
    const basic = { ...overview(false), pullRequests: Array.from({length:80}, (_,i) => ({ ...overview(false).pullRequests[0], number:42+i,
      author: "author-with-a-very-long-account-name", title: `PR ${i+1}: a useful change with enough context to identify the work` })) };
    await dispatchWebviewMessage(page,{type:"pullRequestOverview", overview:basic});
    await page.getByRole("button",{name:"Show pull requests",exact:true}).click();
    const card = page.locator('[data-show-pr="42"]');
    await expect(card.locator(".pr-author")).toContainText("@author-with-a-very-long-account-name");
    await expect(card.locator(".pr-reviewers")).toContainText(ko ? "리뷰어를 불러오는 중" : "Loading reviewers");
    const people = [{login:"reviewer-with-a-very-long-name",kind:"user",state:"REQUESTED"}, {login:"approved-user",kind:"user",state:"APPROVED"},
      {login:"platform",name:"Platform team",kind:"team",state:"CHANGES_REQUESTED"}];
    const ready = { ...basic, detailsLoading:false, pullRequests:basic.pullRequests.map((pr,i) => ({...pr, reviewers:i===1 ? [] : people, reviewersComplete:i!==2,
      commitHashesComplete:true, fileCountComplete:true, commentCountComplete:true })) };
    await dispatchWebviewMessage(page,{type:"pullRequestOverview",overview:ready});
    await expect(page.locator(".pr-card")).toHaveCount(80);
    await expect(card.locator(".pr-reviewers")).toContainText(ko ? "승인됨" : "Approved");
    await expect(card.locator(".pr-review-more")).toHaveText("+1");
    await expect(page.locator('[data-show-pr="43"] .pr-reviewers')).toContainText(ko ? "리뷰어 없음" : "No reviewers");
    await expect(page.locator('[data-show-pr="44"] .pr-review-more')).toHaveText("+1…");
    const input = page.getByRole("searchbox"); await input.fill("approved-user"); await expect(page.locator(".pr-card")).toHaveCount(79);
    await input.fill(""); await card.focus(); await page.keyboard.press("Enter"); await expect(page.locator(".pr-detail-header")).toContainText("approved-user");
    await page.getByRole("button",{name:"Show pull request list",exact:true}).click();
    await page.mouse.move(0,height-1); await page.locator(".pr-card").first().blur();
    await page.screenshot({path:`/private/tmp/gsc-pr-people31-${width}.png`,fullPage:true});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1)).toBe(true);
    expect((await readPostedMessages(page)).filter((m:any) => m.type==="refreshPullRequests")).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}
