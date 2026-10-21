// 대형 index의 실제 Undo 기록 비용을 비교한다. Node 관측치와 외부 process-tree 표본을 구분한다.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OperationUndoStore } from "../../src/git/operationUndoStore";
import { runGit } from "../../src/git/gitExec";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { createLargeIndexFixture, fileDigest } from "../helpers/largeIndexFixture";

/** 같은 1ms 간격의 Node 표본은 부분적인 peak이며 Git 자식의 메모리/CPU를 포함하지 않는다. */
async function measure(f: Awaited<ReturnType<typeof createLargeIndexFixture>>, store: OperationUndoStore, ref: string) {
  assert.ok(global.gc, "The benchmark must use --expose-gc"); global.gc();
  const initial = process.memoryUsage(), peak = { ...initial }, cpu = process.cpuUsage(), started = performance.now(), startedAt = Date.now();
  /** 가능한 순간을 같은 간격으로 읽으며 fixture 준비 메모리와 capture 중 증가분을 따로 보존한다. */
  const sample = () => { const now = process.memoryUsage(); for (const key of ["rss", "heapUsed", "external", "arrayBuffers"] as const) peak[key] = Math.max(peak[key], now[key]); };
  const timer = setInterval(sample, 1);
  try { await store.capture("main", ref, "squash"); sample(); } finally { clearInterval(timer); }
  const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu), endedAt = Date.now();
  const record = JSON.parse(await readFile(path.join(f.root, ".git/gitsimplecompare/pull-request-operation-undo/6d61696e.json"), "utf8"));
  assert.equal(record.state.index, f.expectedFingerprint); assert.equal(record.state.unmerged, false);
  assert.equal(await fileDigest(f.index), f.sha256); assert.equal((await runGit(["write-tree"], f.root)).trim(), f.tree);
  await store.prepare("main");
  assert.equal(gitProcesses.isBusy(f.root), false);
  return { startedAt, endedAt, elapsedMs, nodeCpuMs: (used.user + used.system) / 1000,
    sampledNodeRssGrowthBytes: peak.rss - initial.rss, sampledNodeHeapGrowthBytes: peak.heapUsed - initial.heapUsed,
    sampledExternalGrowthBytes: peak.external - initial.external, sampledArrayBufferGrowthBytes: peak.arrayBuffers - initial.arrayBuffers,
    nodeRssBeforeBytes: initial.rss, sampledNodeRssPeakBytes: peak.rss, legacyDigestExact: true, nativeTreeAndIndexBytesExact: true, undoPlanAccepted: true };
}

/** 직접 만든 임시 저장소만 측정하고 자식 Git이 끝난 뒤 소유 디렉터리를 회수한다. */
async function main() {
  const entries = Number(process.env.GSC_BENCH_INDEX_ENTRIES || 100000), repeats = Number(process.env.GSC_BENCH_REPEATS || 3);
  assert.ok(Number.isSafeInteger(entries) && entries >= 1000 && entries <= 300000);
  assert.ok(Number.isSafeInteger(repeats) && repeats >= 1 && repeats <= 10);
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-undo-index-benchmark-"));
  try {
    const f = await createLargeIndexFixture(directory, entries), ref = "refs/gitsimplecompare/undo-index-benchmark";
    await runGit(["update-ref", ref, f.head], f.root);
    const store = new OperationUndoStore(f.root, "pull-request"); await store.start("main", f.head, ref);
    const samples = []; for (let repeat = 0; repeat < repeats; repeat++) samples.push(await measure(f, store, ref));
    const report = { source: JSON.parse(process.env.GSC_BENCH_SOURCE || "null"),
      scope: "Native-valid100000-entry index capture and fresh Undo-plan acceptance; no100000-file checkout or whole-app resource claim",
      fixture: { entries, indexBytes: f.indexBytes, stageOutputBytes: f.outputBytes, indexSha256: f.sha256, expectedFingerprint: f.expectedFingerprint },
      nodeSampleIntervalMs: 1, samples };
    await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2));
  } finally { await gitProcesses.dispose(); await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
