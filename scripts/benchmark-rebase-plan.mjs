// 같은 fixture의 실제 rebase 계획 생성을 전후 소스 순서만 교차해 비교한다.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url), workspace = process.cwd();
const files = ["src/git/rebaseService.ts", "src/git/rebaseCommitReader.ts", "src/git/rebaseOntoTarget.ts"];
const digest = value => createHash("sha256").update(value).digest("hex");

/** 두 번들의 공통 제품 소스를 측정 전후에 비교한다. fixture 준비나 보고서는 지문에서 제외한다. */
async function fingerprint() {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "src", "package.json"])
    .toString().split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const file of paths) hash.update(file).update("\0").update(await readFile(file)).update("\0");
  return { files: paths.length, sha256: hash.digest("hex") };
}

/** 이전 파일 사본 또는 보고서에 저장한 원문을 받아 Git ref 변경 없이 이전 구현을 재현한다. */
async function loadBaseline() {
  const source = process.env.GSC_BENCH_PLAN_BASELINE;
  assert.ok(source, "GSC_BENCH_PLAN_BASELINE must be a source directory or this benchmark's report");
  const overlays = source.endsWith(".json") ? JSON.parse(await readFile(source, "utf8")).sourceOverlays
    : await Promise.all(files.map(async file => ({ file, before: await readFile(path.join(source, path.basename(file)), "utf8") })));
  assert.deepEqual(overlays.map(row => row.file), files);
  return overlays;
}

/** 기존 import 기준 경로를 보존하고 세 모듈의 내용만 source별로 고정해 번들한다. */
async function bundle(directory, label, overlays) {
  const outfile = path.join(directory, `${label}.cjs`);
  await build({ entryPoints: ["test/benchmarks/rebasePlan.ts"], outfile, bundle: true, platform: "node", format: "cjs",
    target: "node18", logLevel: "silent", alias: { vscode: path.join(workspace, "test/helpers/vscodeMock.ts") },
    plugins: [{ name: "frozen-rebase-plan", setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, args => {
        const saved = overlays.find(row => path.join(workspace, row.file) === args.path);
        return saved ? { contents: saved.before, loader: "ts", resolveDir: path.dirname(args.path) } : undefined;
      });
    } }] });
  return { runtime: require(outfile), bundleSha256: digest(await readFile(outfile)) };
}

/** 짝수 표본은 가운데 두 값의 평균으로 보고한다. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 준비·결과 검증을 시간에서 제외하고 모든 원시 표본과 실제 rebase 결과를 같은 보고서에 보존한다. */
async function main() {
  assert.ok(process.argv[2], "An explicit report path is required");
  const output = path.resolve(process.argv[2]), sourceOverlays = await loadBaseline(), beforeFingerprint = await fingerprint();
  for (const row of sourceOverlays) { row.beforeSha256 = digest(row.before); row.afterSha256 = digest(await readFile(row.file)); }
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-rebase-plan-bench-")), runtimes = {};
  try {
    for (const label of ["before", "after"]) runtimes[label] = await bundle(directory, label, label === "before" ? sourceOverlays : []);
    const report = { sourceOverlays, fingerprint: beforeFingerprint, bundleSha256: Object.fromEntries(Object.entries(runtimes).map(([k, v]) => [k, v.bundleSha256])),
      scope: "Only rebaseService, rebaseCommitReader and rebaseOntoTarget differ. Real service preparation; one filesystem-warm fixture per scenario; ABBA repeated three times after one warmup per source. Actual Native Start is verified separately. No browser, network, Git CPU or RSS timing claim.", results: [] };
    const scenarios = [
      { name: "selected-reorder", commits: 6, upstream: false, outside: false },
      { name: "upstream-reorder", commits: 6, upstream: true, outside: false },
      { name: "selected-outside", commits: 6, upstream: false, outside: true },
      { name: "selected-long-reorder", commits: 60, upstream: false, outside: false },
    ];
    for (const scenario of scenarios) {
      const fixture = await runtimes.before.runtime.fixture(directory, scenario), samples = [], plans = {};
      for (const label of ["before", "after"]) plans[label] = (await runtimes[label].runtime.measure(fixture)).plan;
      assert.deepEqual(plans.after, plans.before);
      for (const label of Array.from({ length: 3 }, () => ["before", "after", "after", "before"]).flat()) {
        const result = await runtimes[label].runtime.measure(fixture);
        assert.deepEqual(result.plan, plans.before); samples.push({ source: label, ...result.metrics });
      }
      const medians = Object.fromEntries(["before", "after"].map(label => [label,
        Object.fromEntries(["elapsedMs", "gitCalls", "nodeCpuMs"].map(metric => [metric,
          median(samples.filter(row => row.source === label).map(row => row[metric]))]))]));
      const execution = {};
      for (const label of ["before", "after"]) execution[label] = await runtimes[label].runtime.verifyExecution(fixture, plans[label], path.join(workspace, "media/rebase/rebaseEditor.js"));
      report.results.push({ scenario, medians, samples, identicalPlans: true, execution }); console.log(JSON.stringify({ scenario: scenario.name, medians }));
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
