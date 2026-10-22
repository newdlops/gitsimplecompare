// 너비 후보 선택의 JS/layout 비용만 비교한다. Native Git·전체 Graph 응답 시간으로 해석하지 않는다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const file = "media/graph/graphRowSync.js", reference = process.env.GSC_BENCH_SOURCE_REF || "HEAD";
const digest = value => createHash("sha256").update(value).digest("hex");

/** @param browser headless Chromium @param source 비교 대상 이름 @param code 실제 모듈 source @returns 독립 page의 원시 표본과 폭 정확성이다. */
async function measure(browser, source, code) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.setContent('<div id="graph"><div id="graph-content"></div></div>');
    await page.addStyleTag({ path: "media/graph/graph.css" });
    await page.addStyleTag({ content: "body{margin:0;font:13px sans-serif;--row-height:30px}#graph{width:1000px;height:700px;overflow:auto}#graph-content{position:relative;height:150000px}.row{left:52px}" });
    await page.evaluate(() => {
      const root = document.getElementById("graph-content"), fragment = document.createDocumentFragment();
      for (let index = 0; index < 5000; index++) {
        const row = document.createElement("div"); row.className = "row"; row.dataset.index = String(index);
        row.style.top = `${index * 30}px`;
        const subject = index < 1000 ? `feature/branch-${index} ` : "";
        row.textContent = `${subject}${index.toString(16).padStart(10, "0")} Commit ${index}: responsive reference updates · Fixture`;
        fragment.append(row);
      }
      root.append(fragment);
    });
    await page.addScriptTag({ content: code });
    const result = await page.evaluate(async source => {
      const root = document.getElementById("graph-content"), graphEl = document.getElementById("graph");
      const sync = window.GscGraphRowSync({ graphEl, graphContentEl: root, layout: () => ({ graphWidth: 52 }) });
      const nativeFrame = requestAnimationFrame.bind(window), samples = [];
      window.requestAnimationFrame = callback => nativeFrame(at => {
        const start = performance.now(); callback(at); samples.push(performance.now() - start);
      });
      /** frame 완료만 기다리는 함수는 시간 표본에 포함되지 않도록 원래 API를 쓴다. */
      const settle = () => new Promise(resolve => nativeFrame(() => nativeFrame(resolve)));
      /** @param kind 같은 후보/짧은 비후보 행 교체 @returns 독립 page 안에서 상관된 각 callback의 시간이다. */
      const scenario = async kind => {
        const timings = [];
        for (let call = 0; call < 15; call++) {
          if (kind === "short-replacement") {
            const row = root.querySelector('[data-index="4000"]'), replacement = row.cloneNode(true);
            replacement.textContent = `short ${call}`; row.replaceWith(replacement);
          }
          sync.scheduleScrollableWidth(); await settle(); timings.push(samples.at(-1));
        }
        return { kind, callbackMs: timings };
      };
      sync.scheduleScrollableWidth(); await settle();
      const scenarios = [await scenario("unchanged"), await scenario("short-replacement")];
      const row = root.querySelector('[data-index="4000"]');
      row.textContent = "A long edited subject ".repeat(150);
      sync.scheduleScrollableWidth(); await settle();
      const grownWidth = parseFloat(root.style.width), grownRight = row.offsetLeft + row.scrollWidth;
      row.remove(); sync.scheduleScrollableWidth(); await settle();
      return { source, scenarios, grownWidth, grownRight, removedWidth: parseFloat(root.style.width) };
    }, source);
    assert.deepEqual(errors, []); assert.ok(result.grownWidth >= result.grownRight);
    assert.ok(result.removedWidth < result.grownWidth); return result;
  } finally { await page.close(); }
}

/** baseline/candidate를 B/A/A/B의 독립 page로 비교하고 변경 전후 source 해시와 모든 표본을 남긴다. */
async function main() {
  const before = execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "show", `${reference}:${file}`]).toString();
  const after = await readFile(file, "utf8"), afterSha256 = digest(after);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.GSC_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.GSC_PLAYWRIGHT_EXECUTABLE } : {}) });
  try {
    const results = [];
    for (const source of ["before", "after", "after", "before"]) results.push(await measure(browser, source, source === "before" ? before : after));
    assert.equal(digest(await readFile(file)), afterSha256);
    const report = { baseline: reference, beforeSha256: digest(before), afterSha256, results,
      scope: "Isolated production row-sync module and row CSS; 5000 synthetic rows, 1000 branch-like prefixes. Two independent pages/source. Within-page callback samples are correlated. Callback JS/layout only, no Native Git, whole Graph latency, CPU or retained-memory claim." };
    await writeFile(process.argv[2] || "/private/tmp/gsc-graph-width-benchmark.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
