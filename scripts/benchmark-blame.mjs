// blame 파싱·블록 집계 비용을 같은 입력/프로세스에서 측정하는 개발 전용 벤치마크.
// - 선택한 Git 기준 버전은 blob만 읽으며 체크아웃, 사용자 설정, 저장소 파일을 바꾸지 않는다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const lineCount = 50_000, blockCount = 400, samples = 11;

/**
 * 선택적 --baseline-ref를 고정 commit SHA로 확인해 Git 옵션/경로로 해석되는 입력을 막는다.
 * @returns 기준 버전이 없으면 undefined, 있으면 실제 commit SHA
 */
function baselineCommit() {
  const args = process.argv.slice(2);
  if (!args.length) return undefined;
  if (args.length !== 2 || args[0] !== "--baseline-ref") throw new Error("Usage: npm run benchmark:blame -- [--baseline-ref <commit>]");
  const sha = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${args[1]}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
  assert.match(sha, /^[0-9a-f]{40,64}$/);
  return sha;
}

/**
 * 현재 소스 또는 기준 commit의 src blob을 임시 CommonJS 번들로 만든다.
 * @param directory 이 실행만 소유한 임시 출력 경로
 * @param label 결과에 표시할 버전 이름 @param commit 읽을 고정 SHA, 없으면 현재 소스
 * @returns VS Code 프로세스를 실행하지 않는 실제 제품 함수 모음
 */
async function loadVersion(directory, label, commit) {
  const output = path.join(directory, `${label}.cjs`);
  await build({ stdin: { contents: 'export * from "./src/git/blameService"; export * from "./src/git/blockBlameBatch"; export * from "./src/ui/blockBlameGutter";', resolveDir: root },
    outfile: output, bundle: true, platform: "node", format: "cjs", target: "node18",
    alias: { vscode: path.join(root, "test/helpers/vscodeMock.ts") },
    plugins: commit ? [{ name: "baseline-source", setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, args => {
        if (!args.path.startsWith(path.join(root, "src") + path.sep)) return undefined;
        const relative = path.relative(root, args.path).split(path.sep).join("/");
        return { contents: execFileSync("git", ["show", `${commit}:${relative}`], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }), loader: "ts", resolveDir: path.dirname(args.path) };
      });
    } }] : [],
  });
  return require(output);
}

/** 100개 커밋, 공백 행과 겹치는 블록을 가진 고정 5만 줄 입력을 만들어 결과와 비용을 함께 비교한다. */
function inputFixture(api) {
  const chunks = [];
  for (let line = 1; line <= lineCount; line++) {
    const author = Math.floor((line - 1) / 500), hash = author.toString(16).padStart(40, "a");
    chunks.push(`${hash} ${line} ${line}${line % 500 === 1 ? " 500" : ""}\n`);
    if (line % 500 === 1) chunks.push(`author Author ${author}\nauthor-mail <author${author}@example.invalid>\nauthor-time 1791964800\nauthor-tz +0900\nsummary Preserve complete blame information\nfilename example.ts\n`);
    chunks.push("\t" + (line % 10 === 0 ? "" : `const value${line} = ${line};`) + "\n");
  }
  const porcelain = chunks.join(""), lines = api.parseBlamePorcelain(porcelain);
  const blocks = Array.from({ length: blockCount }, (_, index) => {
    const start = Math.floor(index * lineCount / blockCount) + 1;
    return { id: `block-${index}`, kind: "function", name: `block${index}`, startLine: start, endLine: Math.min(lineCount, start + 500), declarationLine: start };
  });
  const document = { uri: { toString: () => "file:///repo/example.ts" }, version: 1, lineCount };
  return { porcelain, lines, blocks, document };
}

/**
 * JIT 준비 후 버전 실행 순서를 번갈아 바꿔 중앙값을 구한다. 시간값을 성공/실패 기준으로 쓰지 않는다.
 * @param name 측정 단계 @param versions 비교할 실제 API @param action 한 번 실행할 동일 작업
 * @returns 버전별 중앙값(ms), 기준 버전이 있으면 감소율
 */
function measure(name, versions, action) {
  const keys = Object.keys(versions), times = Object.fromEntries(keys.map(key => [key, []]));
  for (let index = 0; index < 5; index++) for (const key of keys) action(versions[key]);
  for (let index = 0; index < samples; index++) {
    for (const key of index % 2 ? [...keys].reverse() : keys) {
      global.gc?.(); const startedAt = performance.now(); action(versions[key]); times[key].push(performance.now() - startedAt);
    }
  }
  const medians = Object.fromEntries(keys.map(key => [key, times[key].sort((a, b) => a - b)[Math.floor(samples / 2)]]));
  return { stage: name, medianMs: Object.fromEntries(keys.map(key => [key, +medians[key].toFixed(2)])),
    ...(versions.baseline ? { reductionPercent: +(100 * (1 - medians.current / medians.baseline)).toFixed(1) } : {}) };
}

/** 기준/현재 결과의 동등성을 먼저 검사하고 소유한 임시 번들을 성공·실패 때 모두 정리한다. */
async function main() {
  const baseline = baselineCommit(), directory = await mkdtemp(path.join(os.tmpdir(), "gsc-blame-benchmark-"));
  try {
    const versions = {};
    if (baseline) versions.baseline = await loadVersion(directory, "baseline", baseline);
    versions.current = await loadVersion(directory, "current");
    const input = inputFixture(versions.current);
    if (versions.baseline) {
      assert.deepEqual(versions.baseline.parseBlamePorcelain(input.porcelain), input.lines);
      assert.deepEqual(versions.baseline.summarizeFileBlame(input.blocks, input.lines), versions.current.summarizeFileBlame(input.blocks, input.lines));
    }
    const stages = [measure("parse-50000-lines", versions, api => api.parseBlamePorcelain(input.porcelain)),
      measure("summarize-400-overlapping-blocks", versions, api => api.summarizeFileBlame(input.blocks, input.lines)),
      measure("gutter-50000-lines-control", versions, api => { const gutter = new api.BlockBlameGutter(); gutter.apply(input.document, input.lines, "/repo"); gutter.dispose(); })];
    console.log(JSON.stringify({ node: process.version, baseline, lineCount, blockCount, pairedSamples: samples, identicalResults: true, stages }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
