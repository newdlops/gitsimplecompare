// 같은 실제 DOM/CSS 위에서 첫 페이지와 누적 이력의 전체 갱신을 별도 latency/CPU/heap 구간으로 비교한다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { loadavg } from "node:os";
import type { Browser, Page } from "@playwright/test";
import { mountGraphRenderer } from "../webview/webviewHarness";

const requireFixture = createRequire(path.join(process.env.GSC_BENCH_WORKSPACE_ROOT || process.cwd(), "package.json"));
const { chromium } = requireFixture("playwright") as typeof import("@playwright/test");
const source = JSON.parse(process.env.GSC_BENCH_SOURCE!);
const reference = process.env.GSC_BENCH_RENDERER_BASELINE || source.commit;
const files = ["media/graph/graphFeatures.js"];
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** 모델과 실제 배지 상태를 준비한다. 이 준비는 전체 갱신 측정 구간 밖에서 수행한다. */
async function prepare(page: Page, count: number, code: string[]) {
  const script = page.addScriptTag.bind(page);
  page.addScriptTag = options => {
    const index = files.findIndex(file => options.path?.endsWith(file));
    return script(index < 0 ? options : { content: code[index] });
  };
  await mountGraphRenderer(page);
  for (const name of ["graphReferenceState.js", "graphFeatures.js", "graphLocalColors.js", "graphHeadJump.js", "graphViewport.js"]) {
    await page.addScriptTag({ path: path.join(process.cwd(), "media/graph", name) });
  }
  await page.keyboard.press("Escape");
  await page.evaluate(count => {
    const w: any = window, hash = (index: number) => index.toString(16).padStart(40, "0");
    const rows = Array.from({ length: count }, (_, index) => ({ hash: hash(index),
      parents: index + 1 < count ? [hash(index + 1)] : [],
      refs: [...(index === 100 ? ["HEAD", "main"] : []), ...(index < 100 ? [`bench-${index}`] : [])],
      subject: index === count - 100 ? "Long commit subject ".repeat(70) : `Commit ${index}: retain branch badges, selection, scrolling and exact history`,
      authorName: "Graph fixture", authorEmail: "fixture@example.invalid", dateIso: "2026-10-25T00:00:00Z", color: 0, column: 0 }));
    const edges = rows.slice(1).map((_, index) => ({ fromRow: index, toRow: index + 1, column: 0, fromColumn: 0, toColumn: 0, color: 0 }));
    w.__initialGraphFixture = { rows, edges, laneCount: 1 };
    window.dispatchEvent(new MessageEvent("message", { data: { type: "branchStatus", worktrees: [],
      branches: rows.slice(0, 100).map((row, index) => ({ name: `bench-${index}`, hash: row.hash, current: false,
        upstream: "origin/main", ahead: 0, behind: 0, subject: row.subject, dateIso: row.dateIso })) } }));
  }, count);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** 실제 전체 갱신의 동기 handler와 두 frame 완료를 구분한다. 마지막 상태 검사는 frame 측정 뒤 수행한다. */
async function render(page: Page, count: number) {
  return page.evaluate(async count => {
    const w: any = window, start = performance.now();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "graph", data: w.__initialGraphFixture,
      state: { reset: true, loadedCount: count, hasMore: false, hasMoreBefore: false, loading: false, colorScope: "/fixture/initial-cost" } } }));
    const handlerMs = performance.now() - start;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { handlerMs, frameMs: performance.now() - start };
  }, count);
}

/** 소유 Chromium의 같은 PID별 누적 CPU를 읽고 연결을 즉시 닫는다. */
async function counters(browser: Browser) {
  const session = await browser.newBrowserCDPSession();
  try { return (await session.send("SystemInfo.getProcessInfo")).processInfo; } finally { await session.detach(); }
}

/** GC 후 JS heap만 읽는다. 물리 RSS나 실제 최대 사용량으로 해석하지 않는다. */
async function heap(page: Page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("HeapProfiler.collectGarbage"); await session.send("Performance.enable");
    return (await session.send("Performance.getMetrics")).metrics.find(row => row.name === "JSHeapUsedSize")!.value;
  } finally { await session.detach(); }
}

/** 실제 마우스 pointerdown부터 drag-start까지 잰다. frame/CPU/heap 구간이 끝난 뒤에만 별도로 수행한다. */
async function inputLatency(page: Page, count: number) {
  const handle = page.locator(`.row[data-index="${count - 10}"] .commit-hash`);
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    const w: any = window; let start = 0;
    w.__dragStartMs = undefined;
    document.getElementById("graph-content")!.addEventListener("pointerdown", () => { start = performance.now(); }, { capture: true, once: true });
    window.addEventListener("gsc-node-drag-start", () => { w.__dragStartMs = performance.now() - start; }, { once: true });
  });
  await page.mouse.down(); await page.mouse.up();
  const elapsed = await page.evaluate(() => (window as any).__dragStartMs);
  assert.ok(Number.isFinite(elapsed) && elapsed >= 0, "Real pointerdown did not start Graph drag");
  return elapsed as number;
}

/** 각 source/행 수/측정 종류마다 독립 Chromium을 사용해 이전 renderer의 캐시와 DOM을 공유하지 않는다. */
async function measure(phase: string, mode: string, count: number, code: string[]) {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.GSC_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.GSC_PLAYWRIGHT_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await prepare(page, count, code);
    const ambientLoadBefore = loadavg();
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: mode === "latency" ? 6 : 1 });
    let before: Awaited<ReturnType<typeof counters>> | undefined, heapBefore: number | undefined;
    if (mode === "cpu") before = await counters(browser);
    if (mode === "heap") heapBefore = await heap(page);
    const startCpu = process.cpuUsage(), times = await render(page, count), nodeCpu = process.cpuUsage(startCpu);
    const after = before ? await counters(browser) : undefined, heapAfter = heapBefore === undefined ? undefined : await heap(page);
    let browserCpuMs: number | undefined;
    if (before && after) {
      const previous = new Map(before.map(row => [row.id, row]));
      assert.ok(before.every(row => after.some(next => next.id === row.id && next.type === row.type)));
      assert.ok(after.every(row => row.cpuTime >= (previous.get(row.id)?.cpuTime || 0)));
      browserCpuMs = after.reduce((sum, row) => sum + (row.cpuTime - (previous.get(row.id)?.cpuTime || 0)) * 1000, 0);
    }
    const contract = await page.evaluate(() => {
      const root = document.getElementById("graph-content")!, graph = document.getElementById("graph")!;
      const expected = (window as any).__initialGraphFixture;
      const rows = [...root.querySelectorAll<HTMLElement>(":scope > .row")];
      const long = rows[rows.length - 100], head = rows[100];
      return { rows: rows.length, exactHashes: rows.every((row, index) => row.dataset.hash === expected.rows[index].hash),
        headVisible: head.offsetTop >= graph.scrollTop && head.offsetTop < graph.scrollTop + graph.clientHeight,
        widthCoversLongest: parseFloat(root.style.width) >= long.offsetLeft + long.scrollWidth };
    });
    assert.deepEqual(contract, { rows: count, exactHashes: true, headVisible: true, widthCoversLongest: true });
    const dragStartMs = mode === "latency" ? await inputLatency(page, count) : undefined;
    assert.deepEqual(errors, []);
    return { phase, mode, count, ...times, dragStartMs, browserCpuMs, ambientLoadBefore, ambientLoadAfter: loadavg(), nodeCpuMs: (nodeCpu.user + nodeCpu.system) / 1000,
      heapBefore, heapAfter, heapDelta: heapBefore === undefined ? undefined : heapAfter! - heapBefore, contract, browserComplete: true };
  } finally { await browser.close(); }
}

/** B/A/A/B와 반대 순서로 source를 교차하고 원시 표본·해시·계측 범위를 보존한다. */
async function main() {
  assert.ok(process.argv[2], "An explicit report path is required");
  const before = files.map(file => execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "show", `${reference}:${file}`]).toString());
  const after = await Promise.all(files.map(file => readFile(file, "utf8")));
  const counts = (process.env.GSC_BENCH_RENDERER_COUNTS || "300,1200,5000").split(",").map(Number);
  assert.ok(counts.length && counts.every(count => [300, 1200, 5000].includes(count)));
  const report = { source, reference, files, counts, beforeSha256: before.map(digest), afterSha256: after.map(digest), results: [] as unknown[], completed: false,
    scope: "Real Graph DOM/JS/CSS, synthetic linear rows and 100 branch badges; row counts are explicit. Full reset with HEAD at row 100 and a long offscreen title. Only graphFeatures.js differs. Fresh Chromium per source/count/phase. B/A/A/B+A/B/B/A: four independent lifetimes per source. 6x CDP throttle for latency; independent unthrottled CPU and post-GC JS heap runs. No Native Git/network, physical RSS, active VS Code or machine-wide contention claim." };
  for (const mode of (process.env.GSC_BENCH_RENDERER_MODES || "latency,cpu,heap").split(",")) {
    assert.ok(["latency", "cpu", "heap"].includes(mode));
    for (const count of counts) {
      for (const phase of ["before", "after", "after", "before", "after", "before", "before", "after"]) {
        report.results.push(await measure(phase, mode, count, phase === "before" ? before : after));
        await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
        console.error(`${mode} ${count} ${phase} completed (${report.results.length})`);
      }
    }
  }
  assert.deepEqual(await Promise.all(files.map(async file => digest(await readFile(file)))), after.map(digest));
  report.completed = true; await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
