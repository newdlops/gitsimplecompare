// 지정 모듈만 이전 내용으로 덮어쓴 번들과 현재 번들을 같은 fixture에서 ABBA 순서로 비교한다.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url), workspace = process.cwd();
const files = process.env.GSC_BENCH_RECOVERY_FILES?.split(",") || ["src/git/repositoryIdentity.ts", "src/git/operationUndoStore.ts"];
const repeats = Number(process.env.GSC_BENCH_RECOVERY_REPEATS || 3);
const counts = process.env.GSC_BENCH_RECOVERY_COUNTS?.split(",").map(Number);
const digest = value => createHash("sha256").update(value).digest("hex");

/** 현재 전체 제품 소스의 지문을 남겨 두 번들의 공통 코드가 측정 도중 바뀌지 않았는지 확인한다. */
async function fingerprint() {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "src", "package.json"])
    .toString().split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const file of paths) hash.update(file).update("\0").update(await readFile(file)).update("\0");
  return { files: paths.length, sha256: hash.digest("hex") };
}

/** 이전 파일 사본 또는 이전 실행 보고서의 원문을 사용한다. Git ref/사용자 작업트리는 변경하지 않는다. */
async function loadBaseline() {
  const source = process.env.GSC_BENCH_RECOVERY_BASELINE;
  assert.ok(source, "GSC_BENCH_RECOVERY_BASELINE must be a saved source directory or this benchmark's JSON report");
  if (source.endsWith(".json")) return JSON.parse(await readFile(source, "utf8")).sourceOverlays;
  return Promise.all(files.map(async file => ({ file, before: await readFile(path.join(source, path.basename(file)), "utf8") })));
}

/** 상대 import의 기준은 실제 소스 경로로 유지하고 지정한 파일 내용만 교체한다. */
async function bundle(directory, label, overlays) {
  const outfile = path.join(directory, `${label}.cjs`);
  await build({ entryPoints: ["test/benchmarks/branchRecovery.ts"], outfile, bundle: true, platform: "node", format: "cjs",
    target: "node18", logLevel: "silent", alias: { vscode: path.join(workspace, "test/helpers/vscodeMock.ts") },
    plugins: [{ name: "frozen-source", setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, async args => {
        const saved = overlays.find(row => path.join(workspace, row.file) === args.path);
        return saved ? { contents: saved.before, loader: "ts", resolveDir: path.dirname(args.path) } : undefined;
      });
    } }] });
  return { runtime: require(outfile), bundleSha256: digest(await readFile(outfile)) };
}

/** 짝수 표본에서는 두 중앙값의 산술평균을 쓴다. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 외부 서비스 없이 순차 측정하고 원문·번들·제품 지문과 Native 검증 증거를 함께 저장한다. */
async function main() {
  assert.ok(process.argv[2], "An explicit report path is required");
  assert.ok(files.length && files.every(file => /^src\/git\/[a-zA-Z0-9]+\.ts$/.test(file)) && new Set(files).size === files.length);
  assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
  if (counts) assert.ok(counts.length && counts.every(count => Number.isInteger(count) && count >= 10 && count <= 50000));
  const scenarios = counts
    ? counts.map(count => ({ name: `dirty-squash-${count}`, operation: "squash", dirty: true, files: count }))
    : ["squash", "rebase"].flatMap(operation => [false, true].map(dirty => ({
      name: `${dirty ? "dirty" : "clean"}-${operation}`, operation, dirty, files: 1000,
    })));
  const output = path.resolve(process.argv[2]), sourceOverlays = await loadBaseline(), beforeFingerprint = await fingerprint();
  assert.deepEqual(sourceOverlays.map(row => row.file), files);
  for (const row of sourceOverlays) {
    row.beforeSha256 = digest(row.before); row.afterSha256 = digest(await readFile(row.file));
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-branch-recovery-bench-"));
  const runtimes = {};
  try {
    for (const label of ["before", "after"]) runtimes[label] = await bundle(directory, label, label === "before" ? sourceOverlays : []);
    const report = { sourceOverlays, fingerprint: beforeFingerprint, bundleSha256: Object.fromEntries(Object.entries(runtimes).map(([k, v]) => [k, v.bundleSha256])),
      parameters: { files, counts, repeats, warmupPerSource: 1 },
      scope: `Only ${files.join(", ")} differ. Real branch services and Undo; same filesystem-warm fixture; ABBA repeated ${repeats} times after one warmup per source. No network, VS Code UI, Git CPU or RSS claim.`, results: [] };
    for (const scenario of scenarios) {
      const fixture = await runtimes.before.runtime.fixture(directory, scenario), samples = [];
      for (const label of ["before", "after"]) await runtimes[label].runtime.measure(fixture);
      for (const label of Array.from({ length: repeats }, () => ["before", "after", "after", "before"]).flat()) {
        samples.push({ source: label, ...await runtimes[label].runtime.measure(fixture) });
      }
      const medians = Object.fromEntries(["before", "after"].map(label => [label,
        Object.fromEntries(["operation", "prepareUndo", "undo"].map(phase => [phase,
          Object.fromEntries(["elapsedMs", "gitCalls", "nodeCpuMs"].map(metric => [metric,
            median(samples.filter(row => row.source === label).map(row => row[phase][metric]))]))]))]));
      report.results.push({ scenario, medians, samples }); console.log(JSON.stringify({ scenario: scenario.name, medians }));
      await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    }
    assert.deepEqual(await fingerprint(), beforeFingerprint);
    report.completed = true; await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  } finally {
    for (const value of Object.values(runtimes)) await value.runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

process.env.GIT_CONFIG_NOSYSTEM = "1"; process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_AUTHOR_DATE = "1700000010 +0000"; process.env.GIT_COMMITTER_DATE = "1700000010 +0000";
main().catch(error => { console.error(error); process.exitCode = 1; });
