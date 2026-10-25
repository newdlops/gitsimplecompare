// 두 source를 독립 Node/Chromium으로 교차 실행하며 자산 로드 이전의 전체 시작 비용을 비교한다.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const output = path.resolve(process.argv[2] || "");
const baseline = process.env.GSC_BENCH_COLD_BASELINE || "2f6331eaaeee5b96b95944d31795aba12895dc2f";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

/** source와 실제 생성된 browser bundle을 모두 고정한다. build 옵션만 바뀐 비교도 섞이지 않게 한다. */
async function fingerprint() {
  const paths = execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z",
    "src", "media", "package.json", "esbuild.js", "scripts/browser-bundle.mjs"]).toString().split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const file of paths) hash.update(file).update("\0").update(await readFile(file)).update("\0");
  return { files: paths.length, sha256: hash.digest("hex"), browserBundleSha256: sha(await readFile("media/bundled/graph.js")) };
}

/** 한 source의 실제 종료를 기다린다. 관찰 timeout으로 재시작하거나 실패 fixture를 지우지 않는다. */
async function run(mode, phase, index, directory) {
  const file = path.join(directory, `${mode}-${index}-${phase}.json`), log = [];
  const env = { ...process.env, GSC_BENCH_THROTTLE_BEFORE_LOAD: "1", GSC_BENCH_FULL_FRAME: "1",
    GSC_BENCH_FILES: "1000", GSC_BENCH_COMMITS: "1800", GSC_BENCH_BRANCHES: "100", GSC_BENCH_SHARED_UPSTREAM_BRANCHES: "8",
    GSC_BENCH_RENDERER_CPU_THROTTLE: mode === "latency" ? "6" : "1", GIT_AUTHOR_DATE: "1700000010 +0000", GIT_COMMITTER_DATE: "1700000010 +0000" };
  delete env.GSC_BENCH_SOURCE_REF; delete env.GSC_BENCH_PHASE_RESOURCES; delete env.GSC_BENCH_PHASE_MEMORY;
  delete env.GSC_BENCH_FIXTURE_MANIFEST; delete env.GSC_BENCH_BORROWED_FIXTURE;
  if (phase === "before") env.GSC_BENCH_SOURCE_REF = baseline;
  if (mode !== "latency") env.GSC_BENCH_PHASE_RESOURCES = "1";
  if (mode === "memory") env.GSC_BENCH_PHASE_MEMORY = "1";
  const child = spawn(process.execPath, ["scripts/benchmark-graph-cold-startup.mjs", file], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", bytes => log.push(bytes.toString())); child.stderr.on("data", bytes => log.push(bytes.toString()));
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  await writeFile(file + ".log", log.join(""));
  assert.equal(code, 0, log.join("").slice(-5000));
  const raw = await readFile(file), report = JSON.parse(raw);
  assert.equal(report.completed, true); assert.equal(report.nativeAndDomExact, true);
  if (report.phaseResources) assert.equal(report.phaseResources.browserComplete, true);
  const sample = report.phaseResources?.phaseMemory;
  const memory = sample ? await readFile(sample.rawSamplesFile) : undefined;
  if (memory) assert.equal(sha(memory), sample.rawSamplesSha256);
  return { mode, phase, index, closeCode: code, reportSha256: sha(raw), report,
    ...(memory ? { memorySamples: JSON.parse(memory), memorySamplesSha256: sha(memory) } : {}) };
}

/** B/A/A/B와 반대 순서, 별도 latency/CPU/memory 구간을 영구 보고서로 저장한다. */
async function main() {
  assert.ok(process.argv[2], "An explicit report path is required");
  const fixed = await fingerprint(), directory = output + ".runs";
  await mkdir(directory, { recursive: true });
  const report = { baseline, fingerprint: fixed, runs: [], completed: false,
    scope: "24 independent Node/browser lifetimes, B/A/A/B+A/B/B/A per separate latency/CPU/sampled-RSS mode. Browser-cold assets on an empty same-origin shell; source/fixture filesystem warm. Real registered ready callback and Native Git/DOM verification. Latency renderer throttled before HTML navigation; resource runs unthrottled. No active VS Code, GitHub network or machine-wide artificial stress." };
  for (const mode of (process.env.GSC_BENCH_COLD_MODES || "latency,cpu,memory").split(",")) {
    assert.ok(["latency", "cpu", "memory"].includes(mode));
    for (const [index, phase] of ["before", "after", "after", "before", "after", "before", "before", "after"].entries()) {
      report.runs.push(await run(mode, phase, index, directory));
      assert.deepEqual(await fingerprint(), fixed);
      await writeFile(output, JSON.stringify(report, null, 2) + "\n");
      console.error(`cold startup ${mode} ${phase} (${report.runs.length}) completed`);
    }
  }
  report.completed = true; await writeFile(output, JSON.stringify(report, null, 2) + "\n");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
