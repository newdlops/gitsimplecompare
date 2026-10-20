// 대형 ref catalog의 watcher burst에 필요한 복사/조회/Node 자원만 독립적으로 계측한다.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { GraphRefreshLifecycleCoordinator, type GraphRefreshContext } from "../../src/webview/graphRefreshCoordinator";

/** pending publication까지 처리해 마지막 요청의 실제 reload 수를 검사한다. */
async function settle(): Promise<void> { for (let index = 0; index < 8; index++) await new Promise<void>(resolve => setImmediate(resolve)); }

/** 같은 raw catalog와 20개 동시 알림을 사용하고 Git 실행 대신 순수 coordinator 비용만 기록한다. */
async function sample(catalogRows: number, notifications: number) {
  let copiedRefObjects = 0, fingerprintReads = 0, publishedReloads = 0, measuring = false;
  let baselineHeap = 0, peakHeap = 0, baselineRss = 0, peakRss = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const remoteTips = Array.from({ length: catalogRows }, (_, index) => {
    const name = `origin/benchmark-branch-${index}`;
    return {
    get name() {
      copiedRefObjects++;
      if (index === catalogRows - 1 && measuring) {
        const usage = process.memoryUsage(); peakHeap = Math.max(peakHeap, usage.heapUsed); peakRss = Math.max(peakRss, usage.rss);
      }
      return name;
    }, kind: "remote" as const, fullRef: `refs/remotes/origin/benchmark-branch-${index}`, hash: "a".repeat(40),
    };
  });
  let selected: GraphRefreshContext | undefined;
  const coordinator = new GraphRefreshLifecycleCoordinator({
    readFingerprint: async () => {
      if (!measuring) return { fingerprint: "before" };
      fingerprintReads++; await gate;
      return { fingerprint: "after", historyIdentity: "verified", remoteTips };
    },
    reloadGraph: async context => { if (measuring) selected = context; },
    publishAfterReload: async () => { if (measuring) publishedReloads++; },
    invalidateReload: () => {}, info: () => {}, error: (_event, error) => { throw error; },
  });
  try {
    await coordinator.runDirect({ repoRoot: "/fixture", cause: "ready" });
    (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
    const before = process.memoryUsage(); baselineHeap = peakHeap = before.heapUsed; baselineRss = peakRss = before.rss;
    const cpu = process.cpuUsage(), started = performance.now(); measuring = true;
    const requests = Array.from({ length: notifications }, () => coordinator.request({ repoRoot: "/fixture", cause: "gitWatcher", mode: "none" }));
    release(); await Promise.all(requests); await settle();
    const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu), after = process.memoryUsage();
    peakHeap = Math.max(peakHeap, after.heapUsed); peakRss = Math.max(peakRss, after.rss);
    measuring = false;
    assert.ok(fingerprintReads <= 2); assert.equal(publishedReloads, 1); assert.equal(selected?.remoteTips?.length, catalogRows);
    (selected!.remoteTips![0] as { name: string }).name = "consumer-owned";
    assert.equal(remoteTips[0].name, "origin/benchmark-branch-0"); copiedRefObjects--;
    return { catalogRows, notifications, copiedRefObjects, fingerprintReads, publishedReloads,
      elapsedMs: +elapsedMs.toFixed(2), nodeCpuMs: +((used.user + used.system) / 1000).toFixed(2),
      sampledPeakHeapDeltaMiB: +((peakHeap - baselineHeap) / 1048576).toFixed(2),
      sampledPeakRssDeltaMiB: +((peakRss - baselineRss) / 1048576).toFixed(2), consumerIsolated: true };
  } finally { release(); coordinator.dispose(); }
}

/** warmup을 제외하고 두 catalog 크기를 다섯 번 측정하며 source/bundle 식별자와 범위를 명시한다. */
async function main(): Promise<void> {
  await sample(1000, 20);
  const results = [];
  for (const catalogRows of [2000, 10000]) for (let run = 0; run < 5; run++) results.push({ run, ...await sample(catalogRows, 20) });
  const result = { version: JSON.parse(await readFile("package.json", "utf8")).version,
    source: JSON.parse(process.env.GSC_BENCH_SOURCE || "{}"),
    scope: "Node coordinator only; raw catalog allocated before measurement; explicit GC before each sample; heap/RSS sampled per completed catalog copy and at completion; no Git/network/browser CPU or whole-system memory claim", results };
  const json = JSON.stringify(result, null, 2) + "\n";
  if (process.argv[2]) await writeFile(process.argv[2], json);
  console.log(json);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
