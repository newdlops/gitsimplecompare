import { expect, test, type Page } from "@playwright/test";
import { mountList, overview } from "./prListHarness";
import { dispatchWebviewMessage, readPostedMessages } from "./webviewHarness";
import AxeBuilder from "@axe-core/playwright";

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({page}) => { const list: string[] = []; errors.set(page, list); page.on("pageerror", error => list.push(error.message)); });
test.afterEach(({page}) => { expect(errors.get(page)).toEqual([]); });

/** Native OID와 같은 모양의 값으로 PR의 대표 row와 깊은 스크롤 위치를 구분한다. */
const hash = (index: number) => (index + 1).toString(16).padStart(40, "0");

/** production Graph/PR renderer에 깊은 선형 이력과 실제 목록 버튼을 함께 mount한다. */
async function mount(page: Page, korean = false): Promise<void> {
  await mountList(page, korean);
  const rows = Array.from({ length: 240 }, (_, i) => ({ hash: hash(i), parents: i < 239 ? [hash(i+1)] : [],
    refs: i === 0 ? ["HEAD", "main"] : [], authorName: "Fixture", authorEmail: "fixture@example.test",
    dateIso: "2026-10-21T00:00:00Z", subject: `Commit ${i}`, column: 0, color: 0 }));
  await dispatchWebviewMessage(page, { type: "graph", revision: 1, data: { rows, edges: [], laneCount: 1 },
    state: { loadedCount: rows.length, hasMore: false, loading: false, reset: true, colorScope: "/fixture" } });
  await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: { ...overview(true), pullRequests: [
    { ...overview(true).pullRequests[0], headHash: hash(180), commitHashes: [hash(180)] },
  ] } });
  await expect(page.locator("#graph-content > .row")).toHaveCount(240);
  await page.getByRole("button", { name: "Show pull requests", exact: true }).click();
}

for (const [width, height] of [[390,844],[768,1024],[1440,900]]) test(`PR row jump reveals and focuses the graph at ${width}px`, async ({page}) => {
  await page.setViewportSize({width,height}); await mount(page);
  const jump = page.getByRole("button", { name: "Jump to pull request #42 row in the graph", exact: true });
  await jump.focus(); await page.keyboard.press("Enter");
  const target = page.locator(`#graph-content > .row[data-hash="${hash(180)}"]`);
  await expect(target).toHaveClass(/pr-focused-row/);
  await expect(target).toBeInViewport();
  await page.screenshot({path:`/private/tmp/gsc-pr-row-jump-${width}.png`});
  expect(await target.evaluate(row => {
    const subject = row.querySelector(".subject") || row, box = subject.getBoundingClientRect();
    return row.contains(document.elementFromPoint(Math.min(innerWidth - 20, box.left + 20), box.top + box.height / 2));
  })).toBe(true);
  await expect(page.locator("#graph")).toBeFocused();
  expect((await readPostedMessages(page)).filter((m:any) => m.type === "ensureCommitVisible")).toHaveLength(0);
});

/** 일반 목록 갱신 메시지로 로드되지 않은 대표 OID 또는 다중 PR 선택을 만든다. */
async function setPrs(page: Page, prs: object[]): Promise<void> {
  await dispatchWebviewMessage(page, { type: "pullRequestOverview", overview: { ...overview(true), pullRequests: prs } });
}

/** 사용자가 실제로 보낸 최신 이동 메시지를 기다린다. 임의의 sleep으로 요청 완료를 추측하지 않는다. */
async function latestRequest(page: Page): Promise<any> {
  await expect.poll(async () => (await readPostedMessages(page)).filter((m: any) => m.type === "ensureCommitVisible").length).toBeGreaterThan(0);
  return (await readPostedMessages(page)).filter((m: any) => m.type === "ensureCommitVisible").at(-1);
}

for (const [width,height] of [[390,844],[768,1024],[1440,900]]) test(`unloaded PR jump shows loading and reveals the returned commit at ${width}px`, async ({page}) => {
  await page.setViewportSize({width,height});
  if (width === 768) await page.emulateMedia({reducedMotion:"reduce"});
  await mount(page);
  const pr = {...overview(true).pullRequests[0], headHash:hash(400), commitHashes:[hash(400)]}; await setPrs(page,[pr]);
  await page.locator('[data-focus-pr="42"]').click(); const request = await latestRequest(page);
  const jump = page.locator('[data-focus-pr="42"]');
  await expect(jump).toBeDisabled(); await expect(jump).toHaveAttribute("aria-busy","true");
  await expect(jump).toHaveAccessibleName("Locating pull request #42 in the graph…");
  await setPrs(page,[{...pr, commentCount:20}]); await expect(jump).toBeDisabled();
  if (width === 768) await expect(jump.locator(".codicon")).not.toHaveClass(/codicon-modifier-spin/);
  await page.mouse.move(0,height-1); await page.screenshot({path:`/private/tmp/gsc-pr-row-jump-loading-${width}.png`});
  await dispatchWebviewMessage(page,{type:"graph",revision:2,data:{rows:[{hash:hash(400),parents:[],refs:[],authorName:"Fixture",authorEmail:"fixture@example.test",dateIso:"2026-10-21T00:00:00Z",subject:"Previously unloaded pull request",column:0,color:0}],edges:[],laneCount:1},state:{loadedCount:1,hasMore:false,loading:false,reset:true,colorScope:"/fixture"}});
  await dispatchWebviewMessage(page,{type:"commitVisibility",requestId:request.requestId,found:true,hash:hash(400)});
  await expect(page.locator('.row.pr-focused-row')).toHaveAttribute("data-hash",hash(400));
  await expect(page.locator('.row.pr-focused-row')).toBeInViewport(); await expect(page.locator("#graph")).toBeFocused();
  await expect(jump).toBeEnabled(); await expect(jump).not.toHaveAttribute("aria-busy");
});

test("missing PR commit explains recovery in Korean and the same keyboard action retries", async ({page}) => {
  await page.setViewportSize({width:390,height:844}); await mount(page,true);
  await setPrs(page,[{...overview(true).pullRequests[0],headHash:hash(400),commitHashes:[hash(400)]}]);
  let jump = page.locator('[data-focus-pr="42"]'); await jump.focus(); await page.keyboard.press("Space");
  const first = await latestRequest(page);
  await dispatchWebviewMessage(page,{type:"commitVisibility",requestId:first.requestId,found:false});
  const notice = page.locator(".pr-jump-message"); await expect(notice).toContainText("브랜치 필터를 조정");
  await expect(jump).toBeEnabled(); await expect(jump).toHaveAccessibleName("그래프의 PR #42 행으로 이동");
  await expect(jump).toBeFocused();
  const audit = await new AxeBuilder({page}).include("#detail").analyze(); expect(audit.violations.map(item=>item.id)).toEqual([]);
  expect(await notice.evaluate(node => node.scrollWidth <= node.clientWidth+1)).toBe(true);
  await page.mouse.move(0,843); await page.screenshot({path:"/private/tmp/gsc-pr-row-jump-error-390.png"});
  await page.keyboard.press("Enter"); await expect(jump).toBeDisabled();
  await expect.poll(async ()=>(await latestRequest(page)).requestId).not.toBe(first.requestId);
  const second = await latestRequest(page); expect(second.requestId).not.toBe(first.requestId);
  await expect(notice).toHaveCount(0);
});

test("a newer local jump cancels an older unloaded request and ignores its late reply", async ({page}) => {
  await page.setViewportSize({width:1440,height:900}); await mount(page);
  await setPrs(page,[{...overview(true).pullRequests[0],headHash:hash(400),commitHashes:[hash(400)]},
    {...overview(true).pullRequests[0],number:43,headHash:hash(180),commitHashes:[hash(180)]}]);
  await page.locator('[data-focus-pr="42"]').click(); const old = await latestRequest(page);
  await page.locator('[data-focus-pr="43"]').click();
  await expect(page.locator(".pr-focused-row")).toHaveAttribute("data-hash",hash(180));
  expect((await readPostedMessages(page)).filter((m:any)=>m.type === "cancelCommitFocus")).toContainEqual({type:"cancelCommitFocus",requestId:old.requestId});
  await dispatchWebviewMessage(page,{type:"commitVisibility",requestId:old.requestId,found:true,hash:hash(400)});
  await expect(page.locator(".pr-focused-row")).toHaveAttribute("data-hash",hash(180));
  await expect(page.locator(".pr-jump-message")).toHaveCount(0);
  // 늦은 metadata가 row DOM을 교체해도 강조를 유지하되 현재 사용자 스크롤/포커스는 빼앗지 않는다.
  await page.locator("#graph").evaluate(node=>{node.scrollTop=50;});
  const search = page.locator("[data-pr-search-input]"); await search.focus();
  await dispatchWebviewMessage(page,{type:"branchStatus",branches:[]});
  await expect(page.locator(".pr-focused-row")).toHaveAttribute("data-hash",hash(180));
  await expect(search).toBeFocused(); expect(await page.locator("#graph").evaluate(node=>node.scrollTop)).toBe(50);
});

test("merged PRs prefer the resulting merge commit and repository changes cancel pending navigation", async ({page}) => {
  await page.setViewportSize({width:1440,height:900}); await mount(page);
  await setPrs(page,[{...overview(true).pullRequests[0],state:"MERGED",mergeHash:hash(100),headHash:hash(180),commitHashes:[hash(180)]}]);
  await page.locator('[data-focus-pr="42"]').click();
  await expect(page.locator(".pr-focused-row")).toHaveAttribute("data-hash",hash(100));
  await setPrs(page,[{...overview(true).pullRequests[0],headHash:hash(400),commitHashes:[hash(400)]}]);
  await page.locator('[data-focus-pr="42"]').click(); const old = await latestRequest(page);
  await dispatchWebviewMessage(page,{type:"pullRequestContext",context:"replacement-repository"});
  await dispatchWebviewMessage(page,{type:"commitVisibility",requestId:old.requestId,found:false});
  await expect(page.locator(".pr-focused-row,.pr-jump-message")).toHaveCount(0); await expect(page.locator('[data-focus-pr="42"]')).toBeEnabled();
});

test("the first lightweight PR list can jump before commit metadata arrives", async ({page}) => {
  await mount(page);
  await setPrs(page, [{ ...overview(false).pullRequests[0], headHash: undefined, commitHashes: [], commitHashesComplete: false }]);
  await page.locator('[data-focus-pr="42"]').click();
  const request = await latestRequest(page);
  expect(request).toMatchObject({ type: "ensureCommitVisible", hashes: [], pullRequestNumber: 42 });
  await expect(page.locator('[data-focus-pr="42"]')).toBeDisabled();
  await dispatchWebviewMessage(page, { type: "commitVisibility", requestId: request.requestId, found: true, hash: hash(180) });
  await expect(page.locator(".pr-focused-row")).toHaveAttribute("data-hash", hash(180));
  await expect(page.locator(".pr-focused-row")).toBeInViewport();
  await expect(page.locator("#graph")).toBeFocused();
  await page.locator('[data-focus-pr="42"]').click();
  expect((await readPostedMessages(page)).filter((m: any) => m.type === "ensureCommitVisible")).toHaveLength(1);
  await setPrs(page, [{ ...overview(false).pullRequests[0], headHash: undefined, commitHashes: [], updatedAt: "2026-10-22T03:00:00Z" }]);
  await page.locator('[data-focus-pr="42"]').click();
  await expect.poll(async () => (await readPostedMessages(page)).filter((m: any) => m.type === "ensureCommitVisible").length).toBe(2);
  await expect(page.locator('[data-focus-pr="42"]')).toBeDisabled();
  await dispatchWebviewMessage(page, { type: "pullRequestContext", context: "different-repository" });
  await page.locator('[data-focus-pr="42"]').click();
  await expect.poll(async () => (await readPostedMessages(page)).filter((m: any) => m.type === "ensureCommitVisible").length).toBe(3);
});

for (const [width,height] of [[390,844],[768,1024],[1440,900]]) test(`an unchanged PR context refresh preserves an active jump at ${width}px`, async ({page}) => {
  await page.setViewportSize({width,height}); await mount(page);
  await dispatchWebviewMessage(page,{type:"pullRequestContext",context:"same-repository-and-auth"});
  const pr = {...overview(false).pullRequests[0],headHash:undefined,commitHashes:[],commitHashesComplete:false};
  await setPrs(page,[pr]);
  const jump = page.locator('[data-focus-pr="42"]'); await jump.click();
  const request = await latestRequest(page);
  // host는 매 목록 refresh마다 같은 context를 다시 보낸다. 이 알림은 저장소 교체가 아니다.
  await dispatchWebviewMessage(page,{type:"pullRequestContext",context:"same-repository-and-auth"});
  await setPrs(page,[{...pr,commentCount:20}]);
  expect((await readPostedMessages(page)).filter((m:any)=>m.type === "cancelCommitFocus")).toEqual([]);
  await expect(jump).toBeDisabled();
  await dispatchWebviewMessage(page,{type:"commitVisibility",requestId:request.requestId,found:true,hash:hash(180)});
  const row = page.locator(".pr-focused-row");
  await expect(row).toHaveAttribute("data-hash",hash(180)); await expect(row).toBeInViewport();
  await expect(page.locator("#graph")).toBeFocused(); await expect(jump).toBeEnabled();
  // 완료 후 같은 context 알림도 강조와 가벼운 목록의 마지막 OID 재사용을 보존한다.
  await dispatchWebviewMessage(page,{type:"pullRequestContext",context:"same-repository-and-auth"});
  await expect(row).toHaveAttribute("data-hash",hash(180));
  if (width < 800) await page.getByRole("button",{name:"Show pull requests",exact:true}).click();
  await jump.click();
  expect((await readPostedMessages(page)).filter((m:any)=>m.type === "ensureCommitVisible")).toHaveLength(1);
  if (width === 390) await expect.poll(async () => page.locator("#detail").evaluate(node =>
    node.getBoundingClientRect().left >= innerWidth)).toBe(true);
  await page.mouse.move(0,height-1);
  await page.screenshot({path:`/private/tmp/gsc-pr-row-context-${width}.png`});
});

for (const [width,height] of [[390,844],[768,1024],[1440,900]]) test(`a retained search result remains navigable after overview refresh at ${width}px`, async ({page}) => {
  await page.setViewportSize({width,height}); await mount(page);
  await page.locator("[data-pr-search-input]").fill("Remote PR");
  const requests = async () => (await readPostedMessages(page)).filter((message:any) => message.type === "searchPullRequests");
  await expect.poll(async () => (await requests()).length).toBe(1);
  const search = (await requests())[0], pr = {...overview(true).pullRequests[0], title:"Remote PR", headHash:hash(400), commitHashes:[hash(400)]};
  await dispatchWebviewMessage(page,{type:"pullRequestSearchResult",requestId:search.requestId,
    result:{query:"Remote PR",pullRequests:[pr],hasMore:false,totalCount:1}});
  await dispatchWebviewMessage(page,{type:"pullRequestOverview",overview:{...overview(true),pullRequests:[]}});
  await expect(page.locator(".pr-card")).toHaveCount(1);
  await page.locator('[data-focus-pr="42"]').click(); const request = await latestRequest(page);
  expect(request).toMatchObject({hashes:[hash(400)],pullRequestNumber:42});
  await dispatchWebviewMessage(page,{type:"graph",revision:2,data:{rows:[{hash:hash(400),parents:[],refs:[],authorName:"Fixture",authorEmail:"fixture@example.test",dateIso:"2026-10-21T00:00:00Z",subject:"Remote PR search result",column:0,color:0}],edges:[],laneCount:1},state:{loadedCount:1,hasMore:false,loading:false,reset:true,colorScope:"/fixture"}});
  await dispatchWebviewMessage(page,{type:"commitVisibility",requestId:request.requestId,found:true,hash:hash(400)});
  await expect(page.locator(".pr-focused-row")).toHaveAttribute("data-hash",hash(400));
  await expect(page.locator(".pr-focused-row")).toBeInViewport(); await expect(page.locator("#graph")).toBeFocused();
  if (width === 390) await expect.poll(async () => page.locator("#detail").evaluate(node =>
    node.getBoundingClientRect().left >= innerWidth)).toBe(true);
  await page.mouse.move(0,height-1); await page.screenshot({path:`/private/tmp/gsc-pr-row-search-${width}.png`});
});
