import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { layoutGraph } from "../../src/graph/graphLayout";
import type { GraphData } from "../../src/graph/graphTypes";
import { dispatchWebviewMessage, mountGraphRenderer, readPostedMessages } from "./webviewHarness";
import { mountList, overview } from "./prListHarness";

/** 상태 전환과 별개로 유지할 충분히 긴 실제 Graph 모델을 만든다. */
function history(count = 240): GraphData {
  return layoutGraph(Array.from({ length: count }, (_, index) => ({ hash: `state-${index}`,
    parents: index + 1 < count ? [`state-${index + 1}`] : [], refs: index === 0 ? ["HEAD", "main"] : [],
    authorName: "Fixture", authorEmail: "fixture@example.test", dateIso: "2026-10-22T00:00:00Z", subject: `State commit ${index}` })));
}

const state = { loadedCount: 240, hasMore: false, loading: false, reset: true, colorScope: "/fixture" };

/** 변경 없는 모델의 transport revision만 전진시키고 현재 준비 상태를 전달한다. */
function unchanged(data: GraphData, baseRevision = 1) {
  return { baseRevision, revision: baseRevision + 1, rowStart: data.rows.length, rows: [], rowUpdates: [],
    edgeStart: data.edges.length, edges: [], edgeUpdates: [], laneCount: data.laneCount };
}

/** 같은 표시 흐름의 마지막 상태가 두 frame ACK에 실제로 포함되는지 확인할 metadata다. */
function performanceFor(traceId: string) {
  return { traceId, cause: "graphAction", kind: "workingTree", extensionStartedAt: Date.now(), sentAt: Date.now() };
}

/** 초기 장식과 예약된 렌더가 끝난 뒤 새 상태의 효과만 관찰한다. */
async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on("pageerror", error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

for (const [width, height] of [[390,844],[768,1024],[1440,900]]) test(`state-only delta preserves the graph and finishes its visible status at ${width}px`, async ({page}) => {
  await page.setViewportSize({width,height}); await mountGraphRenderer(page);
  await page.addScriptTag({path:join(process.cwd(),"media/graph/graphViewport.js")});
  const data = history();
  await dispatchWebviewMessage(page,{type:"graph",revision:1,data,state:{...state,
    workingTree:{loading:true,message:"Reading working tree..."}}});
  await expect(page.locator("#load-status")).toContainText("Reading working tree...");
  await page.locator('.row[data-hash="state-80"]').click(); if(width<1100)await page.keyboard.press("Escape");
  await page.locator("#graph").focus(); await frames(page);
  await page.evaluate(()=>{
    const w:any=window;w.__stateRow=document.querySelector('.row[data-hash="state-80"]');
    w.__stateSvg=document.querySelector("#graph-content svg");w.__stateScroll=document.getElementById("graph")!.scrollTop;
    w.__stateGraphs=0;w.__stateUpdates=0;
    window.addEventListener("message",event=>{if(event.data?.type==="graph")w.__stateGraphs++;if(event.data?.type==="graphLoadState")w.__stateUpdates++;});
  });
  const performance=performanceFor(`state-done-${width}`);
  await dispatchWebviewMessage(page,{type:"graphDelta",delta:unchanged(data),performance,
    state:{...state,reset:false,loadDirection:"newer",workingTree:null}});
  await expect(page.locator("#load-status")).toHaveText("240 commits, complete");
  await expect(page.locator("#load-status")).not.toHaveClass(/loading/);
  await expect.poll(async()=>(await readPostedMessages(page)).filter((m:any)=>m.type==="graphRendered"&&m.performance?.traceId===performance.traceId).length).toBe(1);
  const ack=(await readPostedMessages(page)).find((m:any)=>m.type==="graphRendered"&&m.performance?.traceId===performance.traceId);
  expect(ack.performance).toEqual(performance);expect(ack.paintedAt).toBeGreaterThanOrEqual(ack.renderedAt);
  expect(await page.evaluate(()=>{const w:any=window;return{
    row:w.__stateRow===document.querySelector('.row[data-hash="state-80"]'),svg:w.__stateSvg===document.querySelector("#graph-content svg"),
    focus:document.activeElement===document.getElementById("graph"),scroll:document.getElementById("graph")!.scrollTop===w.__stateScroll,
    graphs:w.__stateGraphs,updates:w.__stateUpdates,revision:w.GscGraphDataUpdates.stats().revision};})).toEqual({row:true,svg:true,focus:true,scroll:true,graphs:0,updates:1,revision:2});
  // 다음 실제 metadata delta는 건너뛴 revision 없이 동일 모델에 적용돼야 한다.
  await dispatchWebviewMessage(page,{type:"graphDelta",delta:{...unchanged(data,2),rowUpdates:[{index:80,row:{...data.rows[80],subject:"Updated commit subject"}}]},
    state:{...state,reset:false,workingTree:null}});
  await expect(page.locator('.row[data-hash="state-80"] .subject')).toHaveText("Updated commit subject");
  await expect(page.locator("#graph")).toBeFocused();
  await page.screenshot({path:`/private/tmp/gsc-goal48-state-ready-${width}.png`});
  await dispatchWebviewMessage(page,{type:"graphDelta",delta:unchanged(data,3),performance:performanceFor(`state-error-${width}`),
    state:{...state,reset:false,workingTree:{loading:false,message:"Working tree status unavailable.",detail:"Fixture read failed; refresh to retry."}}});
  await expect(page.locator("#load-status")).toContainText("Working tree status unavailable.");
  await expect(page.locator("#load-status")).toHaveAttribute("title","Fixture read failed; refresh to retry.");
  await frames(page);await page.screenshot({path:`/private/tmp/gsc-goal48-state-error-${width}.png`});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test("state-only delta preserves a dense PR list without unrelated DOM mutations",async({page})=>{
  const session=await page.context().newCDPSession(page);await session.send("Emulation.setCPUThrottlingRate",{rate:6});
  await page.setViewportSize({width:1440,height:900});await mountList(page,false);const data=history();
  await dispatchWebviewMessage(page,{type:"graph",revision:1,data,state});
  const initial=overview(true);
  await dispatchWebviewMessage(page,{type:"pullRequestOverview",overview:{...initial,pullRequests:Array.from({length:80},(_,index)=>({
    ...initial.pullRequests[0],number:42+index,title:`Pull Request ${index} with a long title that keeps review context visible`}))}});
  await page.getByRole("button",{name:"Show pull requests",exact:true}).click();
  const search=page.locator("[data-pr-search-input]");await search.focus();await frames(page);
  await page.evaluate(()=>{const w:any=window;w.__prInput=document.querySelector("[data-pr-search-input]");w.__prMutations=0;
    w.__prObserver=new MutationObserver((mutations)=>{w.__prMutations+=mutations.length;});w.__prObserver.observe(document.getElementById("detail"),{subtree:true,childList:true,attributes:true,characterData:true});});
  await dispatchWebviewMessage(page,{type:"graphDelta",delta:unchanged(data),state:{...state,reset:false,workingTree:null},performance:performanceFor("pr-state-only")});
  await frames(page);
  expect(await page.evaluate(()=>{const w:any=window;w.__prObserver.disconnect();return{mutations:w.__prMutations,input:w.__prInput===document.querySelector("[data-pr-search-input]")};})).toEqual({mutations:0,input:true});
  await expect(search).toBeFocused();
  await search.pressSequentially("Pull");await expect(search).toHaveValue("Pull");await expect(search).toBeFocused();
  await session.detach();
});

for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) test(`state-only delta retains the measured canvas and horizontal position at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height }); await mountGraphRenderer(page);
  const data = history(); data.rows[0] = { ...data.rows[0], subject: "A long commit subject with useful context ".repeat(30) };
  await dispatchWebviewMessage(page, { type: "graph", revision: 1, data, state }); await frames(page);
  const before = await page.evaluate(() => {
    const w: any = window, graph = document.getElementById("graph")!, content = document.getElementById("graph-content")!;
    graph.scrollLeft = graph.scrollWidth; graph.scrollTop = 600; graph.focus();
    w.__widthRow = content.querySelector(".row"); w.__widthSvg = content.querySelector("svg");
    return { width: content.style.width, minWidth: content.style.minWidth, left: graph.scrollLeft, top: graph.scrollTop };
  });
  expect(before.left).toBeGreaterThan(0); expect(before.width).toMatch(/px$/);
  await dispatchWebviewMessage(page, { type: "graphDelta", delta: unchanged(data), state: { ...state, reset: false, workingTree: null },
    performance: performanceFor(`width-state-${width}`) }); await frames(page);
  expect(await page.evaluate(() => {
    const graph = document.getElementById("graph")!, content = document.getElementById("graph-content")!;
    return { width: content.style.width, minWidth: content.style.minWidth, left: graph.scrollLeft, top: graph.scrollTop };
  })).toEqual(before);
  expect(await page.evaluate(() => { const w: any = window; return {
    row: w.__widthRow === document.querySelector("#graph-content .row"), svg: w.__widthSvg === document.querySelector("#graph-content svg"),
    revision: w.GscGraphDataUpdates.stats().revision };
  })).toEqual({ row: true, svg: true, revision: 2 });
  await expect(page.locator("#graph")).toBeFocused();
  await page.screenshot({ path: `/private/tmp/gsc-state-canvas-${width}.png` });
});

for (const change of ["tail", "viewport"] as const) test(`state-only delta recomputes canvas geometry when ${change} changes`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await mountGraphRenderer(page);
  const data = history(); data.rows[0] = { ...data.rows[0], subject: "A wide commit subject ".repeat(60) };
  await dispatchWebviewMessage(page, { type: "graph", revision: 1, data, state }); await frames(page);
  const previousHeight = await page.locator("#graph-content").evaluate(el => el.style.height);
  if (change === "viewport") await page.locator("#graph").evaluate(el => { el.style.width = "500px"; });
  await dispatchWebviewMessage(page, { type: "graphDelta", delta: unchanged(data), state: { ...state, reset: false,
    ...(change === "tail" ? { loading: true, hasMore: true } : {}) } }); await frames(page);
  const measured = await page.evaluate(() => {
    const content = document.getElementById("graph-content")!, row = content.querySelector<HTMLElement>(".row")!;
    return { height: parseFloat(content.style.height), width: parseFloat(content.style.width), right: row.offsetLeft + row.scrollWidth };
  });
  expect(measured.height).toBe(parseFloat(previousHeight) + (change === "tail" ? 42 : 0));
  expect(measured.width).toBeGreaterThanOrEqual(measured.right + 24);
  if (change === "tail") await expect(page.locator("#graph-tail")).toBeAttached();
});

for(const changed of ["reset","scope","lanes","empty"] as const)test(`unchanged delta still renders when ${changed} changes graph meaning`,async({page})=>{
  await mountGraphRenderer(page);const data=history(changed==="empty"?0:4),initial={...state,loadedCount:data.rows.length,loading:changed==="empty"};
  await dispatchWebviewMessage(page,{type:"graph",revision:1,data,state:initial});await frames(page);
  await page.evaluate(()=>{(window as any).__semanticGraphs=0;window.addEventListener("message",e=>{if(e.data?.type==="graph")(window as any).__semanticGraphs++;});});
  await dispatchWebviewMessage(page,{type:"graphDelta",delta:{...unchanged(data),...(changed==="lanes"?{laneCount:3}:{})},state:{...initial,
    reset:changed==="reset",loading:false,...(changed==="scope"?{colorScope:"/other-repository"}:{})}});
  expect(await page.evaluate(()=>(window as any).__semanticGraphs)).toBe(1);
  if(changed==="empty")await expect(page.locator("#graph-content .empty")).toHaveText("No commits.");
});

test("state-only revision validation requests resync and a replacement snapshot restores the fast path",async({page})=>{
  await mountGraphRenderer(page);const data=history(4),initial={...state,loadedCount:4};
  await dispatchWebviewMessage(page,{type:"graph",revision:1,data,state:initial});
  for(let i=0;i<2;i++)await dispatchWebviewMessage(page,{type:"graphDelta",delta:unchanged(data,9),state:{...initial,reset:false,workingTree:{loading:true,message:"Invalid stale state"}}});
  expect((await readPostedMessages(page)).filter((m:any)=>m.type==="resyncGraph")).toHaveLength(1);
  await expect(page.locator("#load-status")).not.toContainText("Invalid stale state");
  await dispatchWebviewMessage(page,{type:"graph",revision:10,data,state:initial});
  await dispatchWebviewMessage(page,{type:"graphDelta",delta:unchanged(data,10),state:{...initial,reset:false,workingTree:{loading:true,message:"Current state"}}});
  await expect(page.locator("#load-status")).toContainText("Current state");
  expect(await page.evaluate(()=>(window as any).GscGraphDataUpdates.stats())).toEqual({revision:11,rows:4,edges:3,waiting:false});
});

test("a newer state-only frame supersedes the old graph paint without losing the last status ACK",async({page})=>{
  await mountGraphRenderer(page);const data=history(4),initial={...state,loadedCount:4};
  await page.evaluate(({data,initial,first,last})=>{
    window.dispatchEvent(new MessageEvent("message",{data:{type:"graph",revision:1,data,state:initial,performance:first}}));
    window.dispatchEvent(new MessageEvent("message",{data:{type:"graphDelta",delta:{baseRevision:1,revision:2,rowStart:4,rows:[],rowUpdates:[],edgeStart:3,edges:[],edgeUpdates:[],laneCount:1},
      state:{...initial,reset:false,workingTree:null},performance:last}}));
  },{data,initial,first:performanceFor("old-graph"),last:performanceFor("latest-state")});
  await expect.poll(async()=>(await readPostedMessages(page)).filter((m:any)=>m.type==="graphRendered").length).toBe(1);
  expect((await readPostedMessages(page)).find((m:any)=>m.type==="graphRendered").performance.traceId).toBe("latest-state");
});

test("a state-only completion retains automatic loading at the bottom of the graph",async({page})=>{
  await mountGraphRenderer(page);const data=history(4),initial={...state,loadedCount:4,hasMore:true,loading:true};
  await dispatchWebviewMessage(page,{type:"graph",revision:1,data,state:initial});await frames(page);
  expect((await readPostedMessages(page)).filter((m:any)=>m.type==="loadMore")).toHaveLength(0);
  await dispatchWebviewMessage(page,{type:"graphDelta",delta:unchanged(data),state:{...initial,reset:false,loading:false}});
  await expect.poll(async()=>(await readPostedMessages(page)).filter((m:any)=>m.type==="loadMore").length).toBe(1);
});
