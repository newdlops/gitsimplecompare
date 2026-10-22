// 원시 RSS 표본을 측정 뒤 디스크로 옮겨 관찰 결과 자체가 다음 작업의 heap에 누적되지 않게 한다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { PhaseMemoryResult } from "./phaseMemorySampler";

/**
 * 불완전한 관측도 실패 전에 원문을 보존한다. 이를 정상 요약이나 성공 peak로 반환하지 않는다.
 * @param result observer가 종료하며 반환한 표본·누락 원인 @param label 작업 이름
 * @param output 벤치마크 결과 경로. 단위 검사에서는 소유 임시 경로를 명시한다.
 * @returns 실패 진단 원문의 파일 경로. 기존 파일은 덮어쓰지 않는다.
 */
export async function preserveIncompletePhaseMemory(result: PhaseMemoryResult, label: string, output = process.argv[2]): Promise<string> {
  assert.equal(result.complete, false); assert.match(label, /^[a-z0-9-]+$/); assert.ok(output);
  const file = path.resolve(output + `.memory-${label}.incomplete.json`);
  await writeFile(file, JSON.stringify(result) + "\n", { flag: "wx" });
  return file;
}

/**
 * Native 검증 밖의 원시 표본을 보존하고 benchmark 결과에는 작은 요약만 반환한다.
 * @param result 실제 observer가 close 뒤 반환한 표본 @param label 같은 실행 안의 유일한 작업 이름
 * @returns 같은 시점 합산 RSS 최대 표본과 개별 구성요소 최대값. 이 두 종류의 최대값을 합산하지 않는다.
 */
export async function summarizePhaseMemory(result: PhaseMemoryResult, label: string) {
  assert.ok(result.complete && result.samples.length >= 2);
  assert.match(label, /^[a-z0-9-]+$/); assert.ok(process.argv[2], "Memory observation requires an output file");
  const samples = result.samples;
  for (const row of samples) {
    assert.ok(row.pids.includes(result.rootPid) && !row.pids.includes(result.observerPid));
    assert.equal(row.sumRssBytes, row.nodeRssBytes + row.chromiumRssBytes + row.otherOwnedRssBytes);
  }
  const rawSamplesFile = path.resolve(process.argv[2] + `.memory-${label}.json`), raw = JSON.stringify(result) + "\n";
  await writeFile(rawSamplesFile, raw, { flag: "wx" });
  const peak = samples.reduce((left, right) => right.sumRssBytes > left.sumRssBytes ? right : left);
  return { complete: true, sampleCount: samples.length, intervalMs: result.intervalMs,
    first: samples[0], last: samples.at(-1), sampledPeak: peak,
    maxObservedGapMs: Math.max(...samples.slice(1).map((sample, index) => sample.afterStartMs - samples[index].afterStartMs)),
    componentMaxBytes: { node: Math.max(...samples.map(row => row.nodeRssBytes)), chromium: Math.max(...samples.map(row => row.chromiumRssBytes)),
      otherOwned: Math.max(...samples.map(row => row.otherOwnedRssBytes)) },
    rawSamplesFile, rawSamplesSha256: createHash("sha256").update(raw).digest("hex"), scope: result.scope };
}
