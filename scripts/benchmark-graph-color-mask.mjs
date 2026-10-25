// 16색 집합 변경 전후의 정확성과 전체 Node layout 비용을 같은 합성 이력으로 비교한다.
// 사용법: node scripts/benchmark-graph-color-mask.mjs <baseline commit> <report.json>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";

const root = process.cwd(), require = createRequire(import.meta.url);
const cases = ["linear", "merges", "wide"].flatMap(kind => [300, 5000].map(count => ({ kind, count })));

/**
 * 선형·일반 merge·32개 병렬 lane·결정적인 임의 DAG를 child-before-parent 순서로 만든다.
 * @param count 합성 커밋 수 @param kind 이력 형태 @param seed 임의 DAG 재현 seed
 * @returns 사용자 저장소나 개인 정보를 포함하지 않는 동일 입력
 */
function history(count, kind, seed = 1) {
  let random = seed;
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
  const width = kind === "wide" ? 32 : 1;
  return Array.from({ length: count }, (_, i) => {
    const parents = i + width < count ? [`c${i + width}`] : [];
    if (kind === "merges" && i % 37 === 0 && i + 83 < count) parents.push(`c${i + 83}`);
    if (kind === "wide" && i === 0) {
      parents.splice(0, parents.length, ...Array.from({ length: Math.min(width, count - 1) }, (_, k) => `c${k + 1}`));
    } else if (kind === "wide" && i % 23 === 0 && i + width + 9 < count) {
      parents.push(`c${i + width + 9}`);
    }
    if (kind === "random" && i + 1 < count) {
      for (let k = 0, n = next() % 4; k < n; k++) {
        const parent = `c${i + 1 + next() % (count - i - 1)}`;
        if (!parents.includes(parent)) parents.push(parent);
      }
    }
    return { hash: `c${i}`, parents, refs: i === 0 ? ["HEAD", "main"] : [],
      authorName: "Fixture", authorEmail: "fixture@example.test", dateIso: "2026-01-01T00:00:00Z", subject: `Commit ${i}` };
  });
}

/** 원본 표본을 변경하지 않고 짝수 표본의 두 중앙값까지 반영한 중앙값을 반환한다. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * 같은 수의 전체 layout 결과를 소비하며 CPU와 경과 시간을 측정한다.
 * @param layoutGraph 이번 버전의 함수 @param input 공통 합성 이력 @param runs 두 버전에 동일한 호출 수
 * @returns 호출당 ms. Git·브라우저·실제 VS Code의 전체 작업 시간은 포함하지 않는다.
 */
function exercise(layoutGraph, input, runs) {
  const cpu = process.cpuUsage(), start = performance.now();
  let checksum = 0;
  for (let i = 0; i < runs; i++) {
    const data = layoutGraph(input);
    checksum += data.rows.length + data.edges.length + data.laneCount + data.rows.at(-1).color;
  }
  const elapsed = performance.now() - start, used = process.cpuUsage(cpu);
  return { runs, wallMsPerRun: elapsed / runs, cpuMsPerRun: (used.user + used.system) / 1000 / runs, checksum };
}

/** 시간 제한 예열도 결과를 소비하되 측정 표본에는 넣지 않는다. */
function warm(layoutGraph, input) {
  const end = performance.now() + 50;
  do { exercise(layoutGraph, input, 1); } while (performance.now() < end);
}

/**
 * 한 독립 Node 수명 안에서 짧은 구간마다 순서를 바꿔 두 버전을 비교한다.
 * @param directory 부모가 만든 두 번들의 전용 임시 디렉터리 @param life 순서 균형용 수명 번호
 * @returns 모든 원본 block. 16개 block을 독립 수명 16개로 해석하지 않는다.
 */
function measureLife(directory, life) {
  const modules = { baseline: require(path.join(directory, "baseline.cjs")), mask: require(path.join(directory, "mask.cjs")) };
  const results = [];
  for (const entry of life % 2 ? [...cases].reverse() : cases) {
    const input = history(entry.count, entry.kind), blocks = [];
    global.gc?.();
    for (let round = 0; round < 4; round++) {
      for (const variant of round % 2 ? ["mask", "baseline"] : ["baseline", "mask"]) warm(modules[variant].layoutGraph, input);
    }
    for (let block = 0; block < 16; block++) {
      const order = (block + life) % 2 ? ["mask", "baseline"] : ["baseline", "mask"], values = {};
      for (const variant of order) values[variant] = exercise(modules[variant].layoutGraph, input, entry.count === 300 ? 150 : 4);
      assert.equal(values.baseline.checksum, values.mask.checksum);
      blocks.push({ order, ...values });
    }
    results.push({ ...entry, blocks });
  }
  return { life, results };
}

if (process.argv[2] === "--worker") {
  assert.ok(process.env.GSC_COLOR_MASK_PROBE_DIRECTORY, "Missing parent-owned bundle directory");
  console.log(JSON.stringify(measureLife(process.env.GSC_COLOR_MASK_PROBE_DIRECTORY, Number(process.argv[3]))));
  process.exit(0);
}

/**
 * 전체 행·간선·색상·checkpoint와 페이지/가상 행/축소 뒤 증분 결과를 기존 소스와 대조한다.
 * @param before 고정한 baseline 번들 @param after 현재 소스 번들
 * @returns timing 밖에서 수행한 비교 횟수. 비교는 deep equality이며 checksum만 사용하지 않는다.
 */
function verify(before, after) {
  let full = 0, checkpoints = 0, incremental = 0;
  for (const kind of ["linear", "merges", "wide", "random"]) {
    for (const count of [0, 1, 2, 15, 16, 17, 31, 127, 128, 129, 300, 1200, 5000]) {
      const input = history(count, kind, count + 1), oldPoints = [], newPoints = [];
      assert.deepEqual(after.layoutGraph(input, { checkpoint: point => newPoints.push(point) }),
        before.layoutGraph(input, { checkpoint: point => oldPoints.push(point) }), `${kind}/${count}`);
      assert.deepEqual(newPoints, oldPoints, `${kind}/${count} checkpoints`);
      full++; checkpoints++;
    }
  }
  for (let seed = 1; seed <= 32; seed++) {
    const input = history(256, "random", seed);
    const staged = { ...input[0], hash: "staged", parents: [input[0].hash], refs: [], kind: "staged" };
    const working = { ...staged, hash: "working", parents: ["staged"], kind: "ongoing" };
    const oldCache = new before.IncrementalGraphLayout(), newCache = new after.IncrementalGraphLayout();
    for (const page of [input.slice(0, 127), input.slice(0, 128), input.slice(0, 129), input,
      [staged, ...input], [working, staged, ...input], input.slice(17), input]) {
      assert.deepEqual(newCache.update(page), oldCache.update(page), `incremental seed ${seed}`);
      incremental++;
    }
  }
  return { full, checkpoints, incremental };
}

/** 각 수명의 block 중앙값을 먼저 계산해 반복 표본을 독립 수명으로 부풀리지 않는다. */
function summarize(lives) {
  return cases.map(entry => ({ ...entry, perLife: lives.map(life => {
    const { blocks } = life.results.find(result => result.kind === entry.kind && result.count === entry.count);
    const value = (variant, key) => median(blocks.map(block => block[variant][key]));
    const baselineWallMs = value("baseline", "wallMsPerRun"), maskWallMs = value("mask", "wallMsPerRun");
    const baselineCpuMs = value("baseline", "cpuMsPerRun"), maskCpuMs = value("mask", "cpuMsPerRun");
    return { life: life.life, baselineWallMs, maskWallMs, wallChangePercent: (maskWallMs / baselineWallMs - 1) * 100,
      baselineCpuMs, maskCpuMs, cpuChangePercent: (maskCpuMs / baselineCpuMs - 1) * 100,
      fasterWallBlocks: blocks.filter(block => block.mask.wallMsPerRun < block.baseline.wallMsPerRun).length,
      lowerCpuBlocks: blocks.filter(block => block.mask.cpuMsPerRun < block.baseline.cpuMsPerRun).length };
  }) }));
}

const baselineRef = process.argv[2] || "afd6b2eddc8ea01ee0a6306339253b935d4b6c5c";
const reportPath = path.resolve(process.argv[3] || path.join(tmpdir(), `gsc-color-mask-${process.pid}.json`));
const temporary = await mkdtemp(path.join(tmpdir(), "gsc-color-mask-benchmark-"));
try {
  const original = execFileSync("git", ["-c", "core.fsmonitor=false", "show", `${baselineRef}:src/graph/graphLayout.ts`],
    { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 });
  const candidate = await readFile(path.join(root, "src/graph/graphLayout.ts"), "utf8");
  for (const [variant, contents] of [["baseline", original], ["mask", candidate]]) {
    await build({ stdin: { contents: 'export {layoutGraph} from "./src/graph/graphLayout"; export {IncrementalGraphLayout} from "./src/graph/graphIncrementalLayout";',
      loader: "ts", resolveDir: root }, outfile: path.join(temporary, `${variant}.cjs`), bundle: true, platform: "node", format: "cjs", target: "node18",
      logLevel: "silent", plugins: [{ name: "layout-source", setup(builder) {
        builder.onLoad({ filter: /\/graphLayout\.ts$/ }, () => ({ contents, loader: "ts", resolveDir: path.join(root, "src/graph") }));
      } }] });
  }
  const correctness = verify(require(path.join(temporary, "baseline.cjs")), require(path.join(temporary, "mask.cjs")));
  console.log(JSON.stringify({ correctness }));
  const lives = [];
  for (let life = 0; life < 4; life++) {
    const worker = spawnSync(process.execPath, ["--expose-gc", path.join(root, "scripts/benchmark-graph-color-mask.mjs"), "--worker", String(life)],
      { encoding: "utf8", timeout: 90000, env: { ...process.env, DYLD_INSERT_LIBRARIES: "", GSC_COLOR_MASK_PROBE_DIRECTORY: temporary } });
    assert.equal(worker.status, 0, worker.stderr || worker.error?.message);
    lives.push(JSON.parse(worker.stdout));
    console.log(JSON.stringify({ completedLife: life + 1 }));
  }
  const summary = summarize(lives);
  const report = { measuredAt: new Date().toISOString(), node: process.version, baselineRef,
    baselineSourceSha256: createHash("sha256").update(original).digest("hex"),
    candidateSourceSha256: createHash("sha256").update(candidate).digest("hex"),
    scope: "synthetic Node layout only; no Git, renderer, or actual Code timing", correctness, lives, summary };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ reportPath, summary }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
