// HEAD/제목/참조 상태만 바뀌는 Graph의 응답 시간·CPU·보유 heap을 서로 다른 구간에서 비교한다.
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
const files = ["media/graph/graph.js", "media/graph/graphSvgRender.js", "media/graph/graphDataUpdates.js"];
const source = JSON.parse(process.env.GSC_BENCH_SOURCE!);
const reference = process.env.GSC_BENCH_METADATA_BASELINE || "8fd050da2fc5f8c76e95db00a201abbb64744779";
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** 실제 checkout과 같은 branchStatus/HEAD delta를 보내고 handler·두 frame·정확한 DOM을 구분해 읽는다. */
async function exercise(page: Page, count: number) {
  return page.evaluate(async count => {
    const w = window as any, root = document.getElementById("graph-content")!, graph = document.getElementById("graph")!;
    const fixture = w.__referenceFixture, keptRow = root.querySelector('.row[data-index="1500"]');
    const keptNode = root.querySelector('.node[data-row="1500"]'), svg = root.querySelector("svg") as any;
    const keptEdge = svg.__gscEdgeElements[1500][0], scroll = graph.scrollTop;
    const samples: Array<{ handlerMs: number; frameMs: number }> = [];
    for (let round = 0; round < count; round++) {
      const revision = w.GscGraphDataUpdates.stats().revision, active = revision % 2, branches = structuredClone(fixture.branches);
      branches[0].current = active === 0; branches[1].current = active === 1;
      const rows = w.__metadataRows || fixture.rows.slice();
      const rowUpdates = [0, 1].map(index => ({ index, row: { ...fixture.rows[index],
        subject: `Updated ${revision}: metadata`, authorName: `Author ${revision}`,
        refs: [...(index === active ? ["HEAD"] : []), `bench-${index}`, `tag:release-${index}`] } }));
      rowUpdates.forEach(({ index, row }) => { rows[index] = row; }); w.__metadataRows = rows;
      const start = performance.now();
      window.dispatchEvent(new MessageEvent("message", { data: { type: "branchStatus", branches, worktrees: [] } }));
      window.dispatchEvent(new MessageEvent("message", { data: { type: "graphDelta", delta: { baseRevision: revision, revision: revision + 1,
        rowStart: rows.length, rows: [], rowUpdates, edgeStart: fixture.edges.length, edges: [], edgeUpdates: [], laneCount: 1 },
        state: { loadedCount: rows.length, reset: false, loading: false, hasMore: false, hasMoreBefore: false,
          colorScope: "/fixture/references" } } }));
      const handlerMs = performance.now() - start;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      samples.push({ handlerMs, frameMs: performance.now() - start });
    }
    const head = root.querySelector('.row .head')?.closest<HTMLElement>(".row")?.dataset.index;
    return { samples, rows: root.querySelectorAll(":scope > .row").length, edges: fixture.edges.length,
      keptRow: keptRow === root.querySelector('.row[data-index="1500"]'), keptNode: keptNode === root.querySelector('.node[data-row="1500"]'),
      keptEdge: keptEdge === svg.__gscEdgeElements[1500][0], svg: svg === root.querySelector("svg"),
      scroll: graph.scrollTop === scroll, focus: document.activeElement === graph,
      headExact: head === String((w.GscGraphDataUpdates.stats().revision - 1) % 2) };
  }, count);
}

/** 안정된 소유 Chromium PID의 누적 CPU를 읽고 관측용 CDP 연결을 즉시 닫는다. */
async function counters(browser: Browser) {
  const cdp = await browser.newBrowserCDPSession();
  try { return (await cdp.send("SystemInfo.getProcessInfo")).processInfo; } finally { await cdp.detach(); }
}

/** 강제 GC 뒤 JS heap만 읽는다. RSS나 실제 최대 메모리로 해석하지 않는다. */
async function heap(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("HeapProfiler.collectGarbage"); await cdp.send("Performance.enable");
    return (await cdp.send("Performance.getMetrics")).metrics.find(metric => metric.name === "JSHeapUsedSize")!.value;
  } finally { await cdp.detach(); }
}

/** 최신 full snapshot과 SVG 속성·툴팁이 같은지 측정 구간 밖에서 검증한다. */
async function verifySnapshot(page: Page) {
  return page.evaluate(() => {
    const w = window as any, root = document.getElementById("graph-content")!, fixture = w.__referenceFixture;
    const shape = () => [...root.querySelectorAll("svg *")].map(node => [node.tagName,
      [...node.attributes].map(attr => `${attr.name}=${attr.value}`).sort().join("|"), node.children.length ? "" : node.textContent].join("\n")).sort();
    const incremental = shape();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "graph", revision: w.GscGraphDataUpdates.stats().revision + 1,
      data: { rows: w.__metadataRows, edges: fixture.edges, laneCount: 1 },
      state: { loadedCount: fixture.rows.length, reset: false, loading: false, hasMore: false, colorScope: "/fixture/references" } } }));
    return JSON.stringify(incremental) === JSON.stringify(shape());
  });
}

/** 한 source를 독립 page에서 준비하고 지연·CPU·heap 창을 순서대로 분리해 기록한다. */
async function measure(browser: Browser, phase: string, code: string[]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const load = page.addScriptTag.bind(page);
    page.addScriptTag = options => {
      const index = files.findIndex(file => options.path?.endsWith(file));
      return load(index < 0 ? options : { content: code[index] });
    };
    await mountReferenceGraph(page, true, 1); await page.locator("#graph").focus(); await exercise(page, 8);
    await page.evaluate(() => {
      const w = window as any; w.__metadataLongTasks = [];
      w.__metadataObserver = new PerformanceObserver(list => w.__metadataLongTasks.push(...list.getEntries().map(entry => entry.duration)));
      w.__metadataObserver.observe({ type: "longtask" });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    const latency = await exercise(page, 16);
    const latencyLongTasks = await page.evaluate(() => {
      const w = window as any; w.__metadataLongTasks.push(...w.__metadataObserver.takeRecords().map((entry: PerformanceEntry) => entry.duration));
      w.__metadataObserver.disconnect(); return w.__metadataLongTasks as number[];
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }); await cdp.detach(); await exercise(page, 2);
    const before = await counters(browser), nodeBefore = process.cpuUsage(), cpuContract = await exercise(page, 32);
    const node = process.cpuUsage(nodeBefore), after = await counters(browser), previous = new Map(before.map(row => [row.id, row]));
    assert.ok(before.every(row => after.some(next => next.id === row.id && next.type === row.type)));
    assert.ok(after.every(row => row.cpuTime >= (previous.get(row.id)?.cpuTime || 0)));
    const browserCpuMs = after.reduce((sum, row) => sum + (row.cpuTime - (previous.get(row.id)?.cpuTime || 0)) * 1000, 0);
    const heapBefore = await heap(page); await exercise(page, 32); const heapAfter = await heap(page);
    for (const result of [latency, cpuContract]) {
      assert.equal(result.rows, 5000); assert.equal(result.edges, 4999);
      for (const key of ["keptRow", "keptNode", "keptEdge", "svg", "scroll", "focus", "headExact"] as const) assert.equal(result[key], true, key);
    }
    assert.equal(await verifySnapshot(page), true); assert.deepEqual(errors, []);
    return { phase, sourceSha256: code.map(digest), latency, latencyLongTasks, cpuContract, browserCpuMs,
      nodeCpuMs: (node.user + node.system) / 1000, heapBefore, heapAfter, heapDelta: heapAfter - heapBefore,
      browserComplete: true, fullSnapshotExact: true };
  } finally { await page.close(); }
}

/** B/A/A/B와 반대 순서를 독립 browser에서 실행하고 source 불변성과 원시 표본을 저장한다. */
async function main() {
  assert.equal(source.kind, "working-tree"); assert.ok(process.argv[2], "An explicit report path is required");
  const before = files.map(file => execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "show", `${reference}:${file}`]).toString());
  const after = await Promise.all(files.map(file => readFile(file, "utf8"))), results = [];
  const preparedBrowserBundleSha256 = digest(await readFile("media/bundled/graph.js"));
  for (const phase of ["before", "after", "after", "before", "after", "before", "before", "after"]) {
    const browser = await chromium.launch({ headless: true,
      ...(process.env.GSC_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.GSC_PLAYWRIGHT_EXECUTABLE } : {}) });
    try { results.push(await measure(browser, phase, phase === "before" ? before : after)); } finally { await browser.close(); }
    console.error(`Completed metadata renderer ${phase} (${results.length}/8)`);
  }
  assert.deepEqual((await Promise.all(files.map(file => readFile(file)))).map(digest), after.map(digest));
  assert.equal(digest(await readFile("media/bundled/graph.js")), preparedBrowserBundleSha256);
  await writeFile(process.argv[2], JSON.stringify({ source, baseline: reference, files, beforeSha256: before.map(digest), afterSha256: after.map(digest),
    harness: "Raw source modules; the production bundle is prepared and fingerprinted separately, and is exercised by the Native controls QA.", preparedBrowserBundleSha256, results,
    scope: "5000 rows, 4999 edges, 1000 branches, 250 tags; only graph.js, graphSvgRender.js and graphDataUpdates.js differ. Four independent Chromium lifetimes per source in B/A/A/B+A/B/B/A order. 16 latency messages at CPU 6x and separate 32-message unthrottled CPU and post-GC JS heap windows after 8 warmups. Within-page samples are correlated. Complete stable Chromium PID counters and separate Node/Playwright CPU; no Native Git, active VS Code timing, total RSS or physical peak claim. Full snapshot equality verified outside measured windows." }, null, 2) + "\n");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
