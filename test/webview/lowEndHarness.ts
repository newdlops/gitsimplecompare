import type { Page, TestInfo } from "@playwright/test";
import { join } from "node:path";
import { mountGraphRenderer } from "./webviewHarness";

export const CPU_RATE = 6;

/** 실제 제품 스크립트를 올린 Chromium의 CPU 실행만 느리게 해 저사양 입력 지연을 재현한다. */
export async function mountSlowRebase(page: Page, count: number, fileCount = 0, withPlan = true) {
  await mountGraphRenderer(page);
  for (const name of ["graphRebase.css", "graphRebaseProgress.css"]) {
    await page.addStyleTag({ path: join(process.cwd(), "media/graph", name) });
  }
  await page.addScriptTag({ path: join(process.cwd(), "media/shared/virtualList.js") });
  await page.addStyleTag({ path: join(process.cwd(), "media/shared/instantTooltip.css") });
  await page.addScriptTag({ path: join(process.cwd(), "media/shared/instantTooltip.js") });
  for (const name of ["graphRebaseMessages.js", "graphRebaseMoves.js", "graphRebaseFiles.js", "graphRebaseRows.js", "graphRebaseDetail.js", "graphRebasePreview.js", "graphRebase.js", "graphDetail.js", "graphRebaseProgress.js"]) {
    await page.addScriptTag({ path: join(process.cwd(), "media/graph", name) });
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_RATE });
  return page.evaluate(({ count, fileCount, withPlan }) => {
    const w = window as any;
    const rows = Array.from({ length: count }, (_, index) => ({
      hash: (count - index).toString(16).padStart(40, "0"),
      parents: index + 1 < count ? [(count - index - 1).toString(16).padStart(40, "0")] : [],
      refs: index === 0 ? ["HEAD", "feature/low-end-rebase"] : [],
      subject: `Commit ${count - index}: preserve responsive editing on slower computers`,
      authorName: "Fixture", authorEmail: "fixture@example.test", dateIso: "2026-10-16T00:00:00.000Z",
      color: 0, column: 0,
    }));
    const edges = rows.slice(0, -1).map((_, index) => ({ fromRow: index, toRow: index + 1, column: 0, fromColumn: 0, toColumn: 0, color: 0 }));
    const files = Array.from({ length: fileCount }, (_, index) => ({ status: "M", path: `src/components/file-${String(index).padStart(5, "0")}.ts`, additions: 3, deletions: 1 }));
    const commits = [...rows].reverse().map(row => ({ hash: row.hash, subject: row.subject, body: "", files: row.hash === rows[0].hash ? files : [] }));
    w.__lowEnd = { hash: rows[0].hash, files, inputs: [] };
    const started = performance.now();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "graph", data: { rows, edges, laneCount: 1 },
      state: { loadedCount: count, hasMore: false, hasMoreBefore: false, loading: false, reset: true, colorScope: "/fixture/low-end" } } }));
    const graphMs = performance.now() - started;
    if (!withPlan) return { graphMs, planMs: 0, hash: rows[0].hash };
    const planStarted = performance.now();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "graphRebasePlan", plan: {
      branch: "feature/low-end-rebase", base: "f".repeat(40), baseReason: "selected", commits,
    } } }));
    return { graphMs, planMs: performance.now() - planStarted, hash: rows[0].hash };
  }, { count, fileCount, withPlan });
}

/** 문자 입력이나 파일 클릭 전후와 같은 안정된 상태에서 측정값과 화면을 재현 자료로 남긴다. */
export async function report(page: Page, info: TestInfo, name: string, values: Record<string, unknown>) {
  const metrics = { cpuRate: CPU_RATE, ...values };
  console.log(`[low-end:${name}] ${JSON.stringify(metrics)}`);
  await info.attach(`${name}-metrics.json`, { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}
