// 실제 Graph의 message/resize 경로와 너비 모듈의 효과를 Native 대기 시간과 분리한다.
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
const file = "media/graph/graphRowSync.js", source = JSON.parse(process.env.GSC_BENCH_SOURCE!);
const reference = process.env.GSC_BENCH_WIDTH_BASELINE || source.commit;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** @param page 실제 Graph가 mount된 page @param measure 시간 표본을 수집할지 여부 @returns 같은 resize/delta 흐름의 원시 시간과 보존 결과다. */
async function exercise(page: Page, measure: boolean) {
  return page.evaluate(async measure => {
    const w = window as any, root = document.getElementById("graph-content")!, graph = document.getElementById("graph")!;
    const fixture = w.__referenceFixture, kept = root.querySelector('.row[data-index="1000"]');
    const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    let revision = w.__widthRevision || 0;
    const samples: { kind: string; handlerMs: number; frameMs: number }[] = [];
    for (const kind of ["unchanged-resize", "short-row-delta", "candidate-growth-delta"]) {
      for (let call = 0; call < 6; call++) {
        const start = performance.now();
        if (kind === "unchanged-resize") window.dispatchEvent(new Event("resize"));
        else {
          const index = kind === "short-row-delta" ? 4000 : 200;
          const subject = kind === "short-row-delta" ? `Short ${revision}` : `Long ${revision} `.repeat(call % 2 ? 160 : 80);
          window.dispatchEvent(new MessageEvent("message", { data: { type: "graphDelta", delta: {
            baseRevision: revision, revision: ++revision, rowStart: fixture.rows.length, rows: [],
            rowUpdates: [{ index, row: { ...fixture.rows[index], subject } }], edgeStart: 0, edges: [], edgeUpdates: [], laneCount: 1 },
            state: { loadedCount: fixture.rows.length, reset: false, loading: false, hasMore: false,
              hasMoreBefore: false, colorScope: "/fixture/references" } } }));
        }
        const handlerMs = performance.now() - start; await frames();
        if (measure) samples.push({ kind, handlerMs, frameMs: performance.now() - start });
      }
    }
    w.__widthRevision = revision;
    const longRow = root.querySelector<HTMLElement>('.row[data-index="200"]')!;
    return { samples, rows: root.querySelectorAll(":scope .row").length, kept: kept === root.querySelector('.row[data-index="1000"]'),
      width: parseFloat(root.style.width), right: longRow.offsetLeft + longRow.scrollWidth,
      focus: document.activeElement === graph, selected: root.querySelector('.row[data-index="1"]')?.classList.contains("selected") };
  }, measure);
}

/** @param browser 같은 headless browser @returns CPU 비교 대상의 안정된 PID와 누적 초다. */
async function counters(browser: Browser) {
  const session = await browser.newBrowserCDPSession();
  try { return (await session.send("SystemInfo.getProcessInfo")).processInfo; }
  finally { await session.detach(); }
}

/** @param browser headless Chromium @param phase before/after @param code 바꿀 폭 모듈 @returns 독립 page의 시간·별도 CPU 구간과 기능 증거다. */
async function measure(browser: Browser, phase: string, code: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    const load = page.addScriptTag.bind(page);
    page.addScriptTag = options => load(options.path?.endsWith(file) ? { content: code } : options);
    await mountReferenceGraph(page, false, 1, false);
    await page.keyboard.press("Escape"); await page.locator('.row[data-index="1"] .commit-hash').click(); await page.keyboard.press("Escape");
    await page.locator("#graph").focus();
    await exercise(page, false);
    const latency = await exercise(page, true);
    const before = await counters(browser), node = process.cpuUsage();
    const cpuContract = await exercise(page, false);
    const nodeAfter = process.cpuUsage(node), after = await counters(browser);
    const previous = new Map(before.map(row => [row.id, row]));
    assert.ok(before.every(row => after.some(next => next.id === row.id && next.type === row.type)));
    assert.ok(after.every(row => row.cpuTime >= (previous.get(row.id)?.cpuTime || 0)));
    const browserCpuMs = after.reduce((sum, row) => sum + (row.cpuTime - (previous.get(row.id)?.cpuTime || 0)) * 1000, 0);
    assert.ok(browserCpuMs >= 0);
    for (const result of [latency, cpuContract]) {
      assert.equal(result.rows, 5000); assert.equal(result.kept, true); assert.equal(result.focus, true);
      assert.equal(result.selected, true); assert.ok(result.width >= result.right);
    }
    assert.deepEqual(errors, []);
    return { phase, latency, cpuContract, browserCpuMs, nodeCpuMs: (nodeAfter.user + nodeAfter.system) / 1000,
      browserComplete: true, sourceSha256: digest(code) };
  } finally { await page.close(); }
}

/** 같은 나머지 renderer 위에서 폭 모듈만 바꾸고 독립 브라우저·양쪽 순서의 모든 결과를 보존한다. */
async function main() {
  assert.equal(source.kind, "working-tree", "Use GSC_BENCH_WIDTH_BASELINE rather than SOURCE_REF for this module comparison");
  const before = execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "show", `${reference}:${file}`]).toString();
  const after = await readFile(file, "utf8"), sha = digest(after);
  const results = [];
  for (const phase of ["before", "after", "after", "before", "after", "before", "before", "after"]) {
    const browser = await chromium.launch({ headless: true,
      ...(process.env.GSC_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.GSC_PLAYWRIGHT_EXECUTABLE } : {}) });
    try { results.push(await measure(browser, phase, phase === "before" ? before : after)); }
    finally { await browser.close(); }
  }
  assert.equal(digest(await readFile(file)), sha);
  const report = { source, baseline: reference, beforeSha256: digest(before), afterSha256: sha, results,
    scope: "Actual Graph renderer/CSS and graphDelta/resize at 5000 rows, 1000 branches, 250 tags. Only the width module differs; common current fixture/other modules. Four independent browser/page lifetimes per source, B/A/A/B+A/B/B/A; within-page samples are correlated. CPU has its own 18-message/resize window after warmup, with stable complete Chromium PIDs and separate Node/Playwright usage. The original throttle session explicitly uses rate 1 throughout measured windows. No Native Git, actual button, VS Code host transport, aggregate memory or whole-operation latency claim." };
  await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
