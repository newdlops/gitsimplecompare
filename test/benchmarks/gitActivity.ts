import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { GitProcessRegistry } from "../../src/git/gitProcessRegistry";

/** PID·타이머·신호 없이 등록/close 및 활동 경로 보관만 실제 구현에 전달한다. */
function child(): ChildProcess {
  return Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null, kill: () => false }) as unknown as ChildProcess;
}

/** 다섯 홀수 표본의 중앙값으로 드문 GC·스케줄링 지연을 원본 표본과 함께 기록한다. */
function median(values: number[]): number { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]; }

/** 완료된 임시 worktree 1만 개와 아직 close되지 않은 감시자 네 개를 같은 방법으로 재현한다. */
async function main(): Promise<void> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "gsc-activity-benchmark-")), registry = new GitProcessRegistry();
  const monitors: number[] = [], roots: string[] = [];
  try {
    for (let index = 0; index < 4; index++) {
      const root = path.join(parent, `monitor-${index}`); await mkdir(root); roots.push(root);
      monitors.push(registry.register(child(), root, "fsmonitor--daemon", false, false, true));
    }
    global.gc?.(); const heapBefore = process.memoryUsage().heapUsed;
    for (let index = 0; index < 10000; index++) {
      const id = registry.register(child(), path.join(parent, `completed-${index}`), "status", true, false);
      await registry.closed(id);
    }
    global.gc?.(); const retainedHeapDelta = process.memoryUsage().heapUsed - heapBefore;
    assert.ok(roots.every(root => registry.roots().includes(root) && typeof registry.lastUsed(root) === "number"));
    const samples: { elapsedMs: number; cpuMs: number }[] = [];
    for (let round = -1; round < 5; round++) {
      global.gc?.(); const start = performance.now(), cpu = process.cpuUsage();
      for (let probe = 0; probe < 20; probe++) for (const root of roots) assert.equal(typeof registry.lastUsed(root), "number");
      const used = process.cpuUsage(cpu);
      if (round >= 0) samples.push({ elapsedMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000 });
    }
    const result = { version: JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")).version,
      source: process.env.GSC_BENCH_SOURCE ? JSON.parse(process.env.GSC_BENCH_SOURCE) : undefined,
      fixture: { completedRoots: 10000, openMonitors: 4, probesPerSample: 80, warmup: 1, samples: 5, realChildProcesses: 0 },
      retainedActivityRoots: registry.roots().length, retainedHeapDeltaBytes: retainedHeapDelta, samples,
      median: { elapsedMs: median(samples.map(sample => sample.elapsedMs)), cpuMs: median(samples.map(sample => sample.cpuMs)) }, activeRootsPreserved: true };
    if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } finally { for (const id of monitors) await registry.closed(id); await rm(parent, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
