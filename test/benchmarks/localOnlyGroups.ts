import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadLocalOnlyBranchMap } from "../../src/git/gitLocalOnlyBranches";
import { runGitWithInput } from "../../src/git/gitExec";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { localOnlyFixture, nativeLocalOnlyOracle } from "../helpers/localOnlyFixture";

/** 원본 표본을 바꾸지 않고 개별 측정도 보존하는 홀수 표본의 중앙값이다. */
function median(values: number[]): number { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]; }

/** 한 fixture에서 동일한 immutable OID·Native oracle로 워밍업 1회와 순차 5회를 측정한다. */
async function measure(count: number, groups: number) {
  const directory = await mkdtemp(path.join(tmpdir(), "gsc-local-only-benchmark-"));
  try {
    const f = await localOnlyFixture(directory, count, groups), expected = await nativeLocalOnlyOracle(f), samples = [];
    for (let round = -1; round < 5; round++) {
      let processes = 0, active = 0, peak = 0, rows = 0;
      const cpu = process.cpuUsage(), start = performance.now();
      const actual = await loadLocalOnlyBranchMap(f.root, f.branches, f.remoteTips, undefined, async (args, root, options) => {
        processes++; active++; peak = Math.max(peak, active);
        try {
          const output = await runGitWithInput(args, root, options?.input ?? "", { signal: options?.signal });
          rows += output.split("\n").filter(Boolean).length; return output;
        } finally { active--; }
      });
      const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
      assert.deepEqual(actual, expected); assert.equal(active, 0);
      if (round >= 0) samples.push({ elapsedMs, nodeCpuMs: (used.user + used.system) / 1000, processes, peakProcesses: peak, nativeOutputRows: rows });
    }
    const summary = Object.fromEntries(["elapsedMs", "nodeCpuMs", "processes", "peakProcesses", "nativeOutputRows"].map(key => [key,
      median(samples.map(sample => sample[key as keyof typeof sample]))]));
    return { branches: count, groups, oldDepth: f.oldDepth, localDepth: f.localDepth, exact: true, samples, median: summary };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** 실제 사용자 저장소와 네트워크를 사용하지 않는 component 비교 결과를 JSON으로 보존한다. */
async function main() {
  try {
    const results = [];
    for (const [count, groups] of [[16, 1], [16, 2], [160, 1], [160, 2]]) results.push(await measure(count, groups));
    const result = { version: JSON.parse(await readFile("package.json", "utf8")).version,
      source: process.env.GSC_BENCH_SOURCE ? JSON.parse(process.env.GSC_BENCH_SOURCE) : undefined, warmup: 1, samples: 5, results };
    if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } finally { await gitProcesses.dispose(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
