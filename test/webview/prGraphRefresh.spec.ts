import { expect, test, type Page } from "@playwright/test";
import { mountList, overview } from "./prListHarness";
import { dispatchWebviewMessage, readPostedMessages } from "./webviewHarness";

/** Native OID 형태와 고정 row를 사용해 PR 내용 변경과 Graph 이동을 구분한다. */
const hash = (index: number) => (index+1).toString(16).padStart(40,"0");
const row = (index: number) => ({hash:hash(index),parents:[],refs:[],authorName:"Fixture",authorEmail:"fixture@example.test",
  dateIso:"2026-10-22T00:00:00Z",subject:`Graph commit ${index}`,column:0,color:0});
const errors=new WeakMap<Page,string[]>();
test.beforeEach(({page})=>{const list:string[]=[];errors.set(page,list);page.on("pageerror",error=>list.push(error.message));});
test.afterEach(({page})=>expect(errors.get(page)).toEqual([]));

/** 실제 renderer의 예약된 PR HTML 갱신까지 기다리고 고정 sleep 없이 다음 관찰을 시작한다. */
async function frames(page: Page): Promise<void> {
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
}

/** 80개 실제 목록 카드를 표시하고 HTML 재생성 경계만 관찰한다. DOM 동작은 대체하지 않는다. */
async function mount(page: Page, fileCount = 105) {
  await mountList(page,false);
  const prs=Array.from({length:80},(_,index)=>({...overview(true).pullRequests[0],number:42+index,
    title:`Pull request ${index} keeps author, reviewers and actions current`,headHash:hash(index),commitHashes:[hash(index)],fileCount}));
  await dispatchWebviewMessage(page,{type:"graph",revision:1,data:{rows:[row(0)],edges:[],laneCount:1},
    state:{loadedCount:1,hasMore:false,loading:false,reset:true,colorScope:"/fixture"}});
  await dispatchWebviewMessage(page,{type:"pullRequestOverview",overview:{...overview(true),pullRequests:prs}});
  await page.getByRole("button",{name:"Show pull requests",exact:true}).click(); await frames(page);
  await expect(page.locator(".pr-card")).toHaveCount(80);
  await page.evaluate(()=>{
    const w:any=window,original=w.GscGraphPrViewState.updateHtml;w.__prHtmlUpdates=0;
    w.GscGraphPrViewState.updateHtml=(...args:any[])=>{w.__prHtmlUpdates++;return original(...args);};
  });
  return prs;
}

for(const [width,height] of [[390,844],[768,1024],[1440,900]]) {
  test(`Graph-only updates preserve 80 PR cards without regenerating their HTML at ${width}px`,async({page})=>{
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    await page.setViewportSize({width,height});await mount(page);
    const search=page.locator("[data-pr-search-input]");await search.focus();
    await page.locator(".pr-detail-shell").evaluate(node=>{node.scrollTop=120;});
    const scroll=await page.locator(".pr-detail-shell").evaluate(node=>node.scrollTop);
    for(const message of [
      {type:"branchStatus",branches:[]},
      {type:"tagStatus",tags:[]},
      {type:"graph",revision:2,data:{rows:[row(0),row(1)],edges:[],laneCount:1},
        state:{loadedCount:2,hasMore:false,loading:false,reset:false,colorScope:"/fixture"}},
    ]) {await dispatchWebviewMessage(page,message);await frames(page);}
    await expect(page.locator('.row[data-hash="'+hash(1)+'"] [data-pr-number="43"]')).toHaveCount(1);
    await expect(search).toBeFocused();await expect(page.locator(".pr-card")).toHaveCount(80);
    expect(await page.locator(".pr-detail-shell").evaluate(node=>node.scrollTop)).toBe(scroll);
    expect(await page.evaluate(()=>(window as any).__prHtmlUpdates)).toBe(0);
    await page.screenshot({path:`/private/tmp/gsc-pr-refresh-dense-${width}.png`});expect(errors).toEqual([]);
  });

  for(const graphLast of [true,false]) test(`PR metadata and Graph updates coalesce without losing content (${graphLast?"Graph last":"PR last"}, ${width}px)`,async({page})=>{
    await page.setViewportSize({width,height});const prs=await mount(page);
    await page.evaluate(({prs,graphLast})=>{
      const pr={type:"pullRequestOverview",overview:{available:true,hasMore:false,pullRequests:prs.map((value:any,index:number)=>
        index?value:{...value,title:"Changed PR title remains visible",commentCount:27})}};
      const graph={type:"branchStatus",branches:[]};
      for(const data of graphLast?[pr,graph]:[graph,pr])window.dispatchEvent(new MessageEvent("message",{data}));
    },{prs,graphLast});await frames(page);
    await expect(page.locator('[data-show-pr="42"]')).toContainText("Changed PR title remains visible");
    await expect(page.locator('.row [data-pr-number="42"]')).toHaveAccessibleName(/Changed PR title remains visible/);
    await expect(page.locator('.row [data-pr-number="42"] .pr-comment-count')).toHaveText("27");
    expect(await page.evaluate(()=>(window as any).__prHtmlUpdates)).toBe(1);
  });

  test(`PR related commits hydrate after a Graph window arrives at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height});const prs=await mount(page,1);
    await page.locator('[data-show-pr="43"] .pr-card-heading').click();
    const commit=page.locator('[data-focus-commit="'+hash(1)+'"]');
    await expect(commit).toHaveClass(/unloaded/);
    const request=(await readPostedMessages(page)).filter((message:any)=>message.type==="refreshPullRequestDetail").at(-1);
    await dispatchWebviewMessage(page,{type:"pullRequestDetail",number:43,requestId:request.requestId,
      detail:{number:43,fileCount:1,commentCount:12,fileCommentCount:0,files:[{path:"src/preserved.ts",status:"M",additions:1,deletions:0,commentCount:0}]}});
    await expect(page.locator(".pr-file-row")).toHaveCount(1);
    await page.locator(".pr-file-row").evaluate(node=>(window as any).__preservedFile=node);
    await commit.focus();
    await dispatchWebviewMessage(page,{type:"graph",revision:2,data:{rows:[row(0),row(1)],edges:[],laneCount:1},
      state:{loadedCount:2,hasMore:false,loading:false,reset:false,colorScope:"/fixture"}});await frames(page);
    await expect(commit).not.toHaveClass(/unloaded/);await expect(commit).toContainText("Graph commit 1");
    await expect(commit).toHaveAttribute("title",/Jump to commit/);
    await expect(commit).toBeFocused();
    expect(await page.locator(".pr-file-row").evaluate(node=>node===(window as any).__preservedFile)).toBe(true);
    await commit.blur();await page.mouse.move(0,height-1);await frames(page);
    await page.screenshot({path:`/private/tmp/gsc-pr-refresh-related-${width}.png`});
    await dispatchWebviewMessage(page,{type:"graph",revision:3,data:{rows:[row(0)],edges:[],laneCount:1},
      state:{loadedCount:1,hasMore:false,loading:false,reset:false,colorScope:"/fixture"}});await frames(page);
    await expect(commit).toHaveClass(/unloaded/);await expect(commit).toHaveAttribute("title",/is not loaded/);
    expect(prs).toHaveLength(80);
  });
}

test("opening the overview consumes pending content before a following Graph-only frame",async({page})=>{
  const prs=await mount(page);
  await page.evaluate(prs=>{
    window.dispatchEvent(new MessageEvent("message",{data:{type:"pullRequestOverview",overview:{available:true,hasMore:false,pullRequests:prs}}}));
    document.getElementById("graph-pr-list")!.click();
    window.dispatchEvent(new MessageEvent("message",{data:{type:"branchStatus",branches:[]}}));
  },prs);await frames(page);
  expect(await page.evaluate(()=>(window as any).__prHtmlUpdates)).toBe(1);
  await expect(page.locator(".pr-card")).toHaveCount(80);
});
