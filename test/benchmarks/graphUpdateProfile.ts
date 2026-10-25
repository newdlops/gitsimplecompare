import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { mountReferenceGraph } from "../webview/graphReferenceHarness";

const requireFixture = createRequire(path.join(process.env.GSC_BENCH_WORKSPACE_ROOT || process.cwd(), "package.json"));
const { chromium } = requireFixture("playwright") as typeof import("@playwright/test");

/** HEAD와 제목만 바꾸는 실제 메시지를 보낸 뒤 두 RAF까지 기다린다. */
async function updates(page: import("@playwright/test").Page, count: number) {
  return page.evaluate(async count => {
    const w = window as any, fixture = w.__referenceFixture, samples = [];
    for (let round = 0; round < count; round++) {
      const revision = w.GscGraphDataUpdates.stats().revision, active = revision % 2;
      const branches = structuredClone(fixture.branches); branches[0].current = active === 0; branches[1].current = active === 1;
      const start = performance.now();
      window.dispatchEvent(new MessageEvent("message", { data: { type: "branchStatus", branches, worktrees: [] } }));
      window.dispatchEvent(new MessageEvent("message", { data: { type: "graphDelta", delta: { baseRevision: revision, revision: revision + 1,
        rowStart: fixture.rows.length, rows: [], rowUpdates: [0, 1].map(index => ({ index, row: { ...fixture.rows[index],
          refs: [...(index === active ? ["HEAD"] : []), `bench-${index}`, `tag:release-${index}`], subject: `Updated ${revision}` } })),
        edgeStart: fixture.edges.length, edges: [], edgeUpdates: [], laneCount: 1 },
        state: { loadedCount: fixture.rows.length, reset: false, loading: false, hasMore: false, colorScope: "/fixture/references" } } }));
      const handlerMs = performance.now() - start;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      samples.push({ handlerMs, frameMs: performance.now() - start });
    }
    return samples;
  }, count);
}

/** 독립 프로파일 구간의 CPU sample과 timeline을 저장하고 모든 소유 자원을 닫는다. */
async function main() {
  assert.ok(process.argv[2], "Explicit report path required");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await mountReferenceGraph(page, true, 1);
    if (process.env.GSC_BENCH_ROW_CONTAINMENT === "1") await page.addStyleTag({ content: ".row { contain: layout style; }" });
    await updates(page, 4);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    await cdp.send("Profiler.enable"); await cdp.send("Profiler.start");
    await cdp.send("Tracing.start", { categories: "devtools.timeline,v8", transferMode: "ReturnAsStream" });
    const samples = await updates(page, 8);
    const complete = new Promise<string>(resolve => cdp.once("Tracing.tracingComplete", event => resolve(event.stream!)));
    await cdp.send("Tracing.end"); const stream = await complete;
    const chunks = []; let eof = false;
    while (!eof) { const chunk = await cdp.send("IO.read", { handle: stream }); chunks.push(chunk.data); eof = chunk.eof; }
    await cdp.send("IO.close", { handle: stream });
    const { profile } = await cdp.send("Profiler.stop"); await cdp.detach();
    assert.deepEqual(errors, []);
    await writeFile(process.argv[2] + ".cpuprofile", JSON.stringify(profile));
    await writeFile(process.argv[2] + ".trace.json", chunks.join(""));
    await writeFile(process.argv[2], JSON.stringify({ source: JSON.parse(process.env.GSC_BENCH_SOURCE!), samples,
      rowContainmentExperiment: process.env.GSC_BENCH_ROW_CONTAINMENT === "1",
      scope: "Owned raw Graph modules, 5000 rows, 4999 edges, CPU 6x; profiling overhead included. Not a comparative latency or CPU benchmark." }, null, 2) + "\n");
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
