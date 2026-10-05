// 실제 이전 commit의 layout과 현재 증분 layout을 같은 이력으로 비교한다. 사용자 저장소는 읽기만 한다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";

const root = process.cwd(), baseline = process.argv[2] || "b2019a9";
const temporary = await mkdtemp(path.join(tmpdir(), "gsc-layout-benchmark-"));
const require = createRequire(import.meta.url), count = 5000;

/** 5,000개 커밋의 선형/머지 이력으로 전체 표시 데이터와 페이지 밖의 부모를 함께 검사한다. */
function history(merges) {
  return Array.from({ length: count }, (_, i) => ({ hash: `c${i}`,
    parents: i === count - 1 ? [] : [`c${i + 1}`, ...(merges && i % 37 === 0 && i + 83 < count ? [`c${i + 83}`] : [])],
    refs: i === 0 ? ["HEAD", "main"] : [], authorName: "Author", authorEmail: "a@example.test",
    dateIso: "2026-01-01", subject: `Commit ${i}` }));
}

/** warmup을 제외한 반복 측정의 중앙값으로 타이머 노이즈를 줄인다. */
function median(values) { return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]; }

try {
  const original = execFileSync("git", ["show", `${baseline}:src/graph/graphLayout.ts`], { cwd: root, encoding: "utf8" });
  const common = { bundle: true, platform: "node", format: "cjs", logLevel: "silent" };
  await build({ ...common, stdin: { contents: original, loader: "ts", resolveDir: path.join(root, "src/graph") }, outfile: path.join(temporary, "baseline.cjs") });
  await build({ ...common, stdin: { contents:
    'export { IncrementalGraphLayout } from "./src/graph/graphIncrementalLayout"; export { GraphRenderCache } from "./src/webview/graphRenderCache";',
    loader: "ts", resolveDir: root }, alias: { vscode: path.join(root, "test/helpers/vscodeMock.ts") }, outfile: path.join(temporary, "current.cjs") });
  const { layoutGraph } = require(path.join(temporary, "baseline.cjs"));
  const { IncrementalGraphLayout, GraphRenderCache } = require(path.join(temporary, "current.cjs"));
  for (const kind of ["linear", "merges"]) {
    const input = history(kind === "merges"), pages = Array.from({ length: 20 }, (_, i) => input.slice(0, (i + 1) * 250));
    const oldTimes = [], newTimes = []; let calculatedRows = 0;
    for (let run = 0; run < 7; run++) {
      let start = performance.now(), originalData;
      for (const page of pages) originalData = layoutGraph(page);
      const oldMs = performance.now() - start, cache = new IncrementalGraphLayout();
      start = performance.now(); let current; calculatedRows = 0;
      for (const page of pages) { current = cache.update(page); calculatedRows += current.calculatedRows; }
      const newMs = performance.now() - start;
      assert.deepEqual(current.data, originalData);
      if (run > 0) { oldTimes.push(oldMs); newTimes.push(newMs); }
    }
    console.log(JSON.stringify({ kind, totalCommits: count, pages: pages.length,
      fullCalculatedRows: pages.reduce((sum, page) => sum + page.length, 0), incrementalCalculatedRows: calculatedRows,
      baselineLayoutMs: Number(median(oldTimes).toFixed(2)), incrementalLayoutMs: Number(median(newTimes).toFixed(2)) }));
  }
  const input = history(false), messages = [], render = new GraphRenderCache();
  for (const loadedCount of [4000, 4200]) render.publish({ commits: input.slice(0, loadedCount), virtualCommits: [], compact: false,
    kind: loadedCount === 4000 ? "initial" : "pagination", state: { loadedCount, loading: false, hasMore: true, reset: loadedCount === 4000 } },
    message => messages.push(message));
  const fullBytes = Buffer.byteLength(JSON.stringify({ type: "graph", data: layoutGraph(input.slice(0, 4200)), state: messages[1].state }));
  console.log(JSON.stringify({ transport: "4000 + 200", fullBytes, deltaBytes: Buffer.byteLength(JSON.stringify(messages[1])),
    newRows: messages[1].delta.rows.length, updatedRows: messages[1].delta.rowUpdates.length }));
} finally { await rm(temporary, { recursive: true, force: true }); }
