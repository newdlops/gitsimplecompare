// PR 매칭 모듈의 JS/DOM 비용만 측정한다. Native 작업이나 전체 Graph 지연의 증거로 사용하지 않는다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.cwd(), require = createRequire(path.join(root,"package.json"));
const {chromium} = require("playwright");
const sourceFile = "media/graph/graphPrMatching.js", reference = process.env.GSC_BENCH_SOURCE_REF || "HEAD";
const digest = value => createHash("sha256").update(value).digest("hex");

/** 한 page 수명에서 같은 입력의 반복 장식 시간과 별도의 DOM 변경 수를 구한다. */
async function measure(browser, source, code) {
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  try {
    await page.setContent('<div id="graph-content"></div><div id="detail"></div>');
    await page.evaluate(() => {
      const fixtureWindow = window;
      const hash = index => (index+1).toString(16).padStart(40,"0");
      const root = document.querySelector("#graph-content");
      const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
      root.append(svg);
      for(let index=0;index<300;index++) {
        const row=document.createElement("div");row.className="row";row.dataset.hash=hash(index);root.append(row);
        const node=document.createElementNS("http://www.w3.org/2000/svg","circle");node.classList.add("node");node.dataset.hash=hash(index);svg.append(node);
      }
      fixtureWindow.__prFixture=Array.from({length:80},(_,index)=>({number:42+index,title:`Pull request ${index}`,headHash:hash(index*3),commentCount:12,
        commitHashes:[hash(index*3),...Array.from({length:99},(_,at)=>hash(1000+index*100+at))]}));
    });
    await page.addScriptTag({content:code});
    return await page.evaluate(source => {
      const apply=()=>window.GscGraphPrMatching.applyDecorations(window.__prFixture,pr=>pr.commentCount);
      apply();
      const batches=[];
      for(let batch=0;batch<6;batch++) {
        const start=performance.now();for(let call=0;call<20;call++)apply();
        batches.push({calls:20,ms:performance.now()-start});
      }
      // DOM 관찰은 기본 시간 측정과 분리한다. MutationRecord 보관 비용을 시간 결과에 섞지 않는다.
      const observer=new MutationObserver(()=>{});observer.observe(document.querySelector("#graph-content"),{childList:true,subtree:true});
      for(let call=0;call<10;call++)apply();
      const records=observer.takeRecords();observer.disconnect();
      const removedBadges=records.reduce((total,record)=>total+Array.from(record.removedNodes).filter(node=>node.nodeType===1&&node.classList.contains("pr-badges")).length,0);
      const buttons=document.querySelectorAll(".pr-row-button");
      if(buttons.length!==80)throw new Error("The final synthetic PR decorations are incomplete");
      return {source,batches,diagnosticCalls:10,removedBadges,renderedBadges:buttons.length};
    },source);
  } finally {await page.close();}
}

/** 동일 입력을 baseline/candidate의 B/A/A/B 독립 page에서 측정하고 느린 관측치도 그대로 남긴다. */
async function main() {
  const before=execFileSync("git",["show",`${reference}:${sourceFile}`],{cwd:root}).toString();
  const after=await readFile(path.join(root,sourceFile),"utf8"),beforeSha=digest(before),afterSha=digest(after);
  const browser=await chromium.launch({headless:true,...(process.env.GSC_PLAYWRIGHT_EXECUTABLE?{executablePath:process.env.GSC_PLAYWRIGHT_EXECUTABLE}:{})});
  try {
    const results=[];
    for(const source of ["before","after","after","before"])results.push(await measure(browser,source,source==="before"?before:after));
    assert.equal(digest(await readFile(path.join(root,sourceFile))),afterSha,"Candidate changed during the comparison");
    const report={scope:"Synthetic isolated matching module; 300 rows, 80 PRs, 100 commits/PR; two independent pages per source. Repeated calls within a page are correlated. JS/DOM only; no Native Git, full Graph, frame, CPU or memory claim.",
      baseline:reference,beforeSha256:beforeSha,afterSha256:afterSha,results};
    await writeFile(process.argv[2] || "/private/tmp/gsc-pr-decoration-benchmark.json",JSON.stringify(report,null,2)+"\n");
    console.log(JSON.stringify(report,null,2));
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
