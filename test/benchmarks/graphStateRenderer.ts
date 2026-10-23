// 상태만 바뀌는 Graph 알림의 renderer 비용을 실제 DOM/CSS 위에서 독립적으로 비교한다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Browser, Page } from "@playwright/test";
import { mountReferenceGraph } from "../webview/graphReferenceHarness";

const requireFixture = createRequire(path.join(process.env.GSC_BENCH_WORKSPACE_ROOT || process.cwd(), "package.json"));
const { chromium } = requireFixture("playwright") as typeof import("@playwright/test");
const file = "media/graph/graph.js", source = JSON.parse(process.env.GSC_BENCH_SOURCE!);
const reference = process.env.GSC_BENCH_STATE_BASELINE || source.commit;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** 실제 빈 delta를 순차 전송해 handler와 두 frame 시간을 구분하고 마지막 DOM 상태를 읽는다. */
async function exercise(page: Page, count: number) {
  return page.evaluate(async count => {
    const w = window as any, graph = document.getElementById("graph")!, root = document.getElementById("graph-content")!;
    const kept = root.querySelector(".row"), svg = root.querySelector("svg"), fixture = w.__referenceFixture;
    const samples: Array<{ handlerMs: number; frameMs: number }> = [];
    for (let index = 0; index < count; index++) {
      const revision = w.GscGraphDataUpdates.stats().revision, start = performance.now();
      window.dispatchEvent(new MessageEvent("message", { data: { type: "graphDelta", delta: {
        baseRevision: revision, revision: revision + 1, rowStart: fixture.rows.length, rows: [], rowUpdates: [],
        edgeStart: fixture.edges.length, edges: [], edgeUpdates: [], laneCount: 1 },
        state: { reset: false, loadedCount: fixture.rows.length, loading: false, hasMore: false, hasMoreBefore: false,
          colorScope: "/fixture/references", workingTree: index % 2 ? null : { loading: true, message: "Reading working tree..." } } } }));
      const handlerMs = performance.now() - start;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      samples.push({ handlerMs, frameMs: performance.now() - start });
    }
    return { samples, rows: root.querySelectorAll(":scope > .row").length, kept: kept === root.querySelector(".row"),
      svg: svg === root.querySelector("svg"), focus: document.activeElement === graph,
      revision: w.GscGraphDataUpdates.stats().revision, width: root.style.width };
  }, count);
}

/** Chromium 전체의 안정된 소유 PID와 OS 누적 CPU를 읽고 계측 세션을 즉시 닫는다. */
async function counters(browser: Browser) {
  const cdp = await browser.newBrowserCDPSession();
  try { return (await cdp.send("SystemInfo.getProcessInfo")).processInfo; } finally { await cdp.detach(); }
}

/** 소유 page에서 강제 GC 뒤 JS heap만 읽는다. RSS나 실제 최대 메모리의 대용으로 쓰지 않는다. */
async function heap(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("HeapProfiler.collectGarbage"); await cdp.send("Performance.enable");
    return (await cdp.send("Performance.getMetrics")).metrics.find(metric => metric.name === "JSHeapUsedSize")!.value;
  } finally { await cdp.detach(); }
}

/** 같은 renderer에서 graph.js만 교체하며 latency/CPU/GC 후 heap은 서로 다른 실행 구간으로 잰다. */
async function measure(browser: Browser, phase: string, code: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const load = page.addScriptTag.bind(page);
    page.addScriptTag = options => load(options.path?.endsWith(file) ? { content: code } : options);
    await mountReferenceGraph(page, true, 1); await page.locator("#graph").focus();
    await exercise(page, 8);
    const latency = await exercise(page, 32);
    const before = await counters(browser), nodeBefore = process.cpuUsage();
    const cpuContract = await exercise(page, 48);
    const node = process.cpuUsage(nodeBefore), after = await counters(browser);
    const previous = new Map(before.map(row => [row.id, row]));
    assert.ok(before.every(row => after.some(next => next.id === row.id && next.type === row.type)));
    assert.ok(after.every(row => row.cpuTime >= (previous.get(row.id)?.cpuTime || 0)));
    const browserCpuMs = after.reduce((sum, row) => sum + (row.cpuTime - (previous.get(row.id)?.cpuTime || 0)) * 1000, 0);
    const heapBefore = await heap(page); await exercise(page, 48); const heapAfter = await heap(page);
    for (const result of [latency, cpuContract]) {
      assert.equal(result.rows, 5000); assert.equal(result.kept, true); assert.equal(result.svg, true); assert.equal(result.focus, true);
    }
    assert.deepEqual(errors, []);
    return { phase, sourceSha256: digest(code), latency, cpuContract, browserCpuMs,
      nodeCpuMs: (node.user + node.system) / 1000, heapBefore, heapAfter, heapDelta: heapAfter - heapBefore, browserComplete: true };
  } finally { await page.close(); }
}

/** B/A/A/B와 반대 순서를 독립 browser 수명에서 실행하고 원시 표본을 파일로 남긴다. */
async function main() {
  assert.equal(source.kind, "working-tree"); assert.ok(process.argv[2], "An explicit report path is required");
  const before = execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "show", `${reference}:${file}`]).toString();
  const after = await readFile(file, "utf8"), sha = digest(after), results = [];
  for (const phase of ["before", "after", "after", "before", "after", "before", "before", "after"]) {
    const browser = await chromium.launch({ headless: true,
      ...(process.env.GSC_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.GSC_PLAYWRIGHT_EXECUTABLE } : {}) });
    try { results.push(await measure(browser, phase, phase === "before" ? before : after)); }
    finally { await browser.close(); }
    console.error(`Completed state renderer ${phase} (${results.length}/8)`);
  }
  assert.equal(digest(await readFile(file)), sha);
  await writeFile(process.argv[2], JSON.stringify({ source, baseline: reference, beforeSha256: digest(before), afterSha256: sha, results,
    scope: "5000 rows, 4999 edges, 1000 branches, 250 tags. Only graph.js differs. Four independent Chromium/page lifetimes per source in B/A/A/B+A/B/B/A order. 32 latency messages and separate 48-message CPU and post-GC JS heap windows per lifetime after 8 warmup messages. Within-page samples are correlated. Complete stable Chromium PID counters and separate Node/Playwright CPU; no Native Git, operation latency, total RSS or physical peak claim." }, null, 2) + "\n");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
