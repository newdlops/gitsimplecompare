// 닫힌 메뉴 갱신 비용, 보유 DOM/heap과 첫 열기 비용을 실제 renderer에서 각각 측정한다.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page, CDPSession } from "@playwright/test";
import { mountGraphRenderer } from "../webview/webviewHarness";

/** @param session 현재 renderer의 CDP @returns CPU task/script 시간과 heap 크기의 원본 계측값 */
async function metrics(session: CDPSession): Promise<Record<string, number>> {
  const result = await session.send("Performance.getMetrics");
  return Object.fromEntries(result.metrics.map((item: { name: string; value: number }) => [item.name, item.value]));
}

/**
 * 한 번의 닫힌 목록 갱신과 첫 열기를 측정한다. 검증은 측정 이후 실제 checkbox 상태를 확인한다.
 * @param page 새 renderer page @param count 브랜치 수 @param updates 현재 브랜치가 실제로 바뀌는 갱신 수
 * @returns 구간별 비용, DOM 생성 수와 실제 최신 목록 검증 결과
 */
async function measure(page: Page, count: number, updates: number) {
  await mountGraphRenderer(page, false, { branchFilter: true });
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  await session.send("Performance.enable"); await session.send("HeapProfiler.collectGarbage");
  const before = await metrics(session);
  const closed = await page.evaluate(({ count, updates }) => {
    const menu = document.getElementById("graph-branch-filter-menu")!;
    const observer = new MutationObserver(() => {}); observer.observe(menu, { childList: true, subtree: true });
    const branches = Array.from({ length: count }, (_, index) => ({ name: `feature/${String(index).padStart(4, "0")}-한글-long-branch`,
      kind: index % 2 ? "remote" : "local", current: false, checked: true }));
    const started = performance.now();
    for (let update = 0; update < updates; update++) window.dispatchEvent(new MessageEvent("message", { data: {
      type: "branchFilterOptions", filter: { mode: "all", selected: [], compact: true, remoteStatus: "ready",
        branches: branches.map((branch, index) => ({ ...branch, current: index === update % count })) },
    } }));
    const elapsedMs = performance.now() - started;
    const addedElements = observer.takeRecords().reduce((sum, record) => sum + [...record.addedNodes].reduce((total, node) =>
      total + (node.nodeType === Node.ELEMENT_NODE ? 1 + (node as Element).querySelectorAll("*").length : 0), 0), 0);
    observer.disconnect();
    return { elapsedMs, addedElements, retainedElements: menu.querySelectorAll("*").length, hidden: menu.hidden };
  }, { count, updates });
  const after = await metrics(session);
  await session.send("HeapProfiler.collectGarbage"); const retained = await metrics(session);
  const opened = await page.evaluate(async () => {
    const started = performance.now(); document.getElementById("graph-branch-filter-button")!.click();
    const handlerMs = performance.now() - started;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return { handlerMs, twoFramesMs: performance.now() - started };
  });
  const menu = page.locator("#graph-branch-filter-menu");
  assert.equal(await menu.isVisible(), true); assert.equal(await menu.locator("[data-branch-filter-checkbox]").count(), count);
  assert.ok((await menu.locator(".current").textContent())?.includes(String((updates - 1) % count).padStart(4, "0")));
  const rowLayout = await menu.locator(".branch-filter-row").first().evaluate(element => ({
    height: element.getBoundingClientRect().height, contentVisibility: getComputedStyle(element).contentVisibility,
    intrinsic: getComputedStyle(element).containIntrinsicBlockSize,
  }));
  await session.detach();
  return { closed, browserTaskMs: (after.TaskDuration - before.TaskDuration) * 1000,
    browserScriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
    retainedHeapDeltaMiB: (retained.JSHeapUsedSize - before.JSHeapUsedSize) / 1048576, opened, rowLayout, exactLatestCatalog: true };
}

/** 매 표본의 page를 닫아 이전 renderer의 listener/DOM이 다음 표본에 남지 않게 한다. */
async function main(): Promise<void> {
  const requireFixture = createRequire(path.join(process.env.GSC_BENCH_WORKSPACE_ROOT || process.cwd(), "package.json"));
  const { chromium } = requireFixture("playwright") as typeof import("@playwright/test");
  const browser = await chromium.launch({ headless: true,
    ...(process.env.GSC_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.GSC_PLAYWRIGHT_EXECUTABLE } : {}) });
  const sizes = (process.env.GSC_BENCH_BRANCH_COUNTS || "300,1000").split(",").map(Number);
  const samples = Number(process.env.GSC_BENCH_SAMPLES || 5), updates = 10, results = [];
  assert.ok(samples > 0 && samples <= 11 && sizes.every(count => count > 0 && count <= 10000));
  try {
    for (const count of sizes) {
      const values = [];
      for (let index = -1; index < samples; index++) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        try { const value = await measure(page, count, updates); if (index >= 0) values.push(value); }
        finally { await page.close(); }
      }
      results.push({ branches: count, samples: values });
    }
    const result = { source: JSON.parse(process.env.GSC_BENCH_SOURCE || "null"), mode: "headless-existing-renderer",
      cpuThrottle: 6, updates, warmup: 1, sampleCount: samples, results };
    if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
