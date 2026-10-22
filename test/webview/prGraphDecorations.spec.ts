import { expect, test, type Page } from "@playwright/test";
import { mountList, overview } from "./prListHarness";
import { dispatchWebviewMessage } from "./webviewHarness";

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({page}) => { const value: string[] = []; errors.set(page,value); page.on("pageerror", error => value.push(error.message)); });
test.afterEach(({page}) => { expect(errors.get(page)).toEqual([]); });

/** 실물 OID와 같은 길이의 hash로 표시 중인 커밋과 페이지 밖 PR 커밋을 구분한다. */
const hash = (index: number) => (index+1).toString(16).padStart(40,"0");

/** 현재 production 스케줄러가 적용한 장식과 그 다음 폭 측정 frame까지 기다린다. */
async function settle(page:Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** 300개 Graph 행과 80개 PR·각 100개 commit으로 실제 목록과 배지 표시를 함께 준비한다. */
async function mount(page:Page) {
  await mountList(page,false);
  const rows=Array.from({length:300},(_,index)=>({hash:hash(index),parents:index<299?[hash(index+1)]:[],refs:index===0?["HEAD","main"]:[],
    authorName:"Fixture",authorEmail:"fixture@example.test",dateIso:"2026-10-22T00:00:00Z",subject:`Commit ${index}`,column:0,color:0}));
  const prs=Array.from({length:80},(_,index)=>({...overview(true).pullRequests[0],number:42+index,title:`Pull request ${index}: preserve complete histories and keyboard navigation`,
    headHash:hash(index*3),commitHashes:[hash(index*3),...Array.from({length:99},(_,at)=>hash(1000+index*100+at))]}));
  await dispatchWebviewMessage(page,{type:"graph",revision:1,data:{rows,edges:[],laneCount:1},state:{loadedCount:300,hasMore:false,loading:false,reset:true,colorScope:"/fixture"}});
  await dispatchWebviewMessage(page,{type:"pullRequestOverview",overview:{...overview(true),pullRequests:prs}});
  await settle(page);
  return {rows,prs};
}

test("unchanged metadata keeps PR badge identity and keyboard focus",async({page})=>{
  await mount(page);
  const button=page.locator('#graph-content .row[data-index="0"] .pr-row-button'), handle=await button.elementHandle();
  await button.focus();
  for(const message of [{type:"tagStatus",tags:[]},{type:"branchStatus",branches:[]},{type:"tagStatus",tags:[]}]) {
    await dispatchWebviewMessage(page,message); await settle(page);
  }
  expect(await handle!.evaluate(node=>node.isConnected)).toBe(true);
  await expect(button).toBeFocused();
  await expect(page.locator("#graph-content .pr-badges")).toHaveCount(80);
});

test("changed PR content, moved hashes and removed PRs update only current decorations",async({page})=>{
  const {prs}=await mount(page);
  const untouched=await page.locator('#graph-content .row[data-index="3"] .pr-row-button').elementHandle();
  await page.locator('#graph-content .row[data-index="0"] .pr-row-button').focus();
  let changed={...prs[0],title:'Updated <safe> title',commentCount:21};
  await dispatchWebviewMessage(page,{type:"pullRequestOverview",overview:{...overview(true),pullRequests:[changed,...prs.slice(1)]}});
  await settle(page);
  const first=page.locator('#graph-content .row[data-index="0"] .pr-row-button');
  await expect(first).toHaveAccessibleName('Show PR #42 details: Updated <safe> title');
  await expect(first.locator('.pr-comment-count')).toHaveText('21');
  await expect(first).toBeFocused();
  expect(await untouched!.evaluate(node=>node.isConnected)).toBe(true);
  changed={...changed,headHash:hash(30),commitHashes:[]};
  await dispatchWebviewMessage(page,{type:"pullRequestOverview",overview:{...overview(true),pullRequests:[changed,...prs.slice(1)]}});
  await settle(page);
  await expect(page.locator('#graph-content .row[data-index="0"]')).not.toHaveClass(/pr-row/);
  await expect(page.locator(`#graph-content .node[data-hash="${hash(0)}"]`)).not.toHaveClass(/pr-node/);
  await expect(page.locator('#graph-content .row[data-index="30"] [data-pr-number="42"]')).toHaveCount(1);
  await dispatchWebviewMessage(page,{type:"pullRequestOverview",overview:{...overview(true),pullRequests:[]}}); await settle(page);
  await expect(page.locator('#graph-content .pr-row,#graph-content .pr-badges,#graph-content .pr-node')).toHaveCount(0);
});

test("shared commits keep the three-badge limit and update the first PR node color",async({page})=>{
  const {prs}=await mount(page);
  const shared=prs.slice(0,4).map(pr=>({...pr,headHash:hash(0),commitHashes:[]}));
  await dispatchWebviewMessage(page,{type:"pullRequestOverview",overview:{...overview(true),pullRequests:shared}}); await settle(page);
  const buttons=page.locator('#graph-content .row[data-index="0"] .pr-row-button');
  await expect(buttons).toHaveCount(3); await expect(buttons.first()).toHaveAttribute('data-pr-number','42');
  await expect(page.locator(`#graph-content .node[data-hash="${hash(0)}"]`)).toHaveClass(/pr-color-2/);
  await dispatchWebviewMessage(page,{type:"pullRequestOverview",overview:{...overview(true),pullRequests:[...shared.slice(1),shared[0]]}}); await settle(page);
  await expect(buttons).toHaveCount(3); await expect(buttons.first()).toHaveAttribute('data-pr-number','43');
  const node=page.locator(`#graph-content .node[data-hash="${hash(0)}"]`);
  await expect(node).toHaveClass(/pr-color-3/); await expect(node).not.toHaveClass(/pr-color-2/);
});

test("a newly loaded window matches PR history that was outside the previous page",async({page})=>{
  const {rows}=await mount(page);
  await dispatchWebviewMessage(page,{type:"graph",revision:2,data:{rows:[{...rows[0],hash:hash(1000),parents:[],refs:[]}],edges:[],laneCount:1},
    state:{loadedCount:1,hasMore:false,loading:false,reset:true,colorScope:"/fixture"}}); await settle(page);
  await expect(page.locator('#graph-content .pr-row-button')).toHaveCount(1);
  await expect(page.locator('#graph-content .pr-row-button')).toHaveAttribute('data-pr-number','42');
  await expect(page.locator('#graph-content .pr-row')).toHaveAttribute('data-hash',hash(1000));
});

for(const [width,height] of [[390,844],[768,1024],[1440,900]]) test(`dense PR decorations survive row replacement and jump at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height}); const {rows}=await mount(page);
  await page.getByRole('button',{name:'Show pull requests',exact:true}).click();
  await expect(page.locator('#detail .pr-card')).toHaveCount(80);
  if(width===390)await expect(page.locator('#detail')).toHaveCSS('transform','matrix(1, 0, 0, 1, 0, 0)');
  await page.mouse.move(0,height-1); await page.screenshot({path:`/private/tmp/gsc-goal52-pr-dense-${width}.png`});
  await page.locator('[data-focus-pr="42"]').click();
  await expect(page.locator('.pr-focused-row')).toHaveAttribute('data-hash',hash(0));
  if(width===390)await expect.poll(async()=>page.locator('#detail').evaluate(node=>node.getBoundingClientRect().left>=innerWidth)).toBe(true);
  await dispatchWebviewMessage(page,{type:'graph',revision:2,data:{rows,edges:[],laneCount:1},state:{loadedCount:300,hasMore:false,loading:false,reset:false,colorScope:'/fixture'}});
  await settle(page);
  await expect(page.locator('#graph-content .pr-badges')).toHaveCount(80);
  await expect(page.locator('.pr-focused-row')).toHaveAttribute('data-hash',hash(0));
  await expect(page.locator('.pr-focused-row')).toBeInViewport();
  await page.mouse.move(0,height-1);
  await page.screenshot({path:`/private/tmp/gsc-goal52-pr-jump-${width}.png`});
});
