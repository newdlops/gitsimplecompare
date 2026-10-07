// 같은 파일/블록의 결과 일치를 확인하고 전체 스캔과 라인 인덱스 집계 시간을 비교한다.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";

const temporary = await mkdtemp(path.join(tmpdir(), "gsc-blame-benchmark-"));
const require = createRequire(import.meta.url);

/** 작성자·커밋이 섞인 큰 파일과 400개 함수 범위를 만든다. 사용자 Git 저장소는 읽지 않는다. */
function fixture(lineCount) {
  const lines = Array.from({ length: lineCount }, (_, index) => ({ line: index + 1,
    commit: String(index % 3).repeat(40), authorName: `Author ${index % 3}`, authorMail: `author${index % 3}@example.invalid`,
    authorTime: 1700000000 + index, summary: "Change source", filename: "example.ts", content: index % 5 ? `line ${index}` : " " }));
  const stride = Math.floor(lineCount / 400);
  const blocks = Array.from({ length: 400 }, (_, index) => ({ id: String(index), name: `function${index}`, kind: "function",
    declarationLine: index * stride + 1, startLine: index * stride + 1, endLine: index * stride + 20 }));
  return { lines, blocks };
}

/** warmup을 제외한 일곱 번의 중앙값으로 개별 GC/타이머 노이즈를 줄인다. */
function median(times) { return times.sort((left, right) => left - right)[Math.floor(times.length / 2)]; }

try {
  await build({ stdin: { contents: 'export { summarizeBlockBlame } from "./src/git/blockBlameModel"; export { summarizeFileBlame } from "./src/git/blockBlameBatch";',
    resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    outfile: path.join(temporary, "blame.cjs") });
  const { summarizeBlockBlame, summarizeFileBlame } = require(path.join(temporary, "blame.cjs"));
  for (const lineCount of [10_000, 50_000]) {
    const { lines, blocks } = fixture(lineCount), before = [], after = [];
    for (let run = 0; run < 8; run++) {
      let start = performance.now();
      const baseline = blocks.map(block => summarizeBlockBlame(block, lines));
      const baselineMs = performance.now() - start;
      start = performance.now();
      const indexed = summarizeFileBlame(blocks, lines);
      const indexedMs = performance.now() - start;
      assert.deepEqual(indexed, baseline);
      if (run > 0) { before.push(baselineMs); after.push(indexedMs); }
    }
    const baselineMs = median(before), indexedMs = median(after);
    console.log(JSON.stringify({ fileLines: lineCount, blocks: blocks.length,
      baselineMs: Number(baselineMs.toFixed(2)), indexedMs: Number(indexedMs.toFixed(2)),
      speedup: Number((baselineMs / indexedMs).toFixed(1)), identicalSummaries: true }));
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
