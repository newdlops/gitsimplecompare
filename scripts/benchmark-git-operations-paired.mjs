// 실제 서비스/Graph 결과를 작업별로 교차 실행하고 별도 latency·CPU·RSS 구간의 원문을 남긴다.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const supportedOperations = ["initial", "push", "push-tracked", "pull", "pull-new-history", "pull-known-history", "fetch", "fetch-new-history",
  "fetch-known-history", "fetch-no-change", "rebase", "merge", "merge-no-ff", "pr-squash-cherry-pick", "pr-cherry-pick", "cherry-pick", "checkout", "checkout-unloaded"];
const operations = process.env.GSC_BENCH_PAIRED_OPERATIONS?.split(",") || supportedOperations;
assert.ok(operations.length && operations.every(operation => supportedOperations.includes(operation)));
const output = path.resolve(process.argv[2] || ""), baseline = process.env.GSC_BENCH_PAIRED_BASELINE || "d8c1351eaf7843a8e2deabb2a848a533ec7c5488";
const digest = value => createHash("sha256").update(value).digest("hex");
const git = args => execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", ...args]).toString();

/** 측정 중 제품 소스가 바뀌면 결과를 거부한다. fixture와 보고서는 fingerprint에 포함하지 않는다. */
async function runtimeFingerprint() {
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "src", "media", "package.json"]).split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(await readFile(file)).update("\0");
  return { files: files.length, sha256: hash.digest("hex") };
}

/** 원자적 권한 파일만 게시해 source가 부분 JSON으로 작업을 시작하지 않게 한다. */
async function publish(file, value) { await writeFile(file + ".tmp", JSON.stringify(value)); await rename(file + ".tmp", file); }

/** 소유 source Node의 실제 close를 기록한다. 관찰 시간 만료를 Native 종료로 취급하지 않는다. */
function launch(directory, identity, mode, reference) {
  const report = path.join(directory, identity + ".json"), log = [];
  const env = { ...process.env, GSC_BENCH_LIVE_RENDERER: "1", GSC_BENCH_FULL_FRAME: "1", GSC_BENCH_OPERATIONS: operations.join(","),
    GSC_BENCH_FILES: "1000", GSC_BENCH_COMMITS: "1800", GSC_BENCH_BRANCHES: "100", GSC_BENCH_SHARED_UPSTREAM_BRANCHES: "8",
    GSC_BENCH_CHECKOUT_LOADED_TARGET: "1", GSC_BENCH_CHECKOUT_FIXED_TARGET: "1", GSC_BENCH_VALIDATE_INPUT_STATUS: "1",
    GSC_BENCH_TURN_DIRECTORY: directory, GSC_BENCH_TURN_ID: identity, GSC_BENCH_TURN_TIMEOUT_MS: "900000",
    GIT_AUTHOR_DATE: "1700000010 +0000", GIT_COMMITTER_DATE: "1700000010 +0000", GSC_BENCH_CHECKPOINTS: "0" };
  delete env.GSC_BENCH_SOURCE_REF; delete env.GSC_BENCH_FIXTURE_MANIFEST; delete env.GSC_BENCH_BORROWED_FIXTURE;
  delete env.GSC_BENCH_CPU_PROFILE_DIR; delete env.GSC_BENCH_RENDERER_PROFILE_DIR;
  delete env.GSC_BENCH_PHASE_RESOURCES; delete env.GSC_BENCH_PHASE_MEMORY;
  if (reference) env.GSC_BENCH_SOURCE_REF = reference;
  if (mode !== "latency") env.GSC_BENCH_PHASE_RESOURCES = "1";
  if (mode === "memory") env.GSC_BENCH_PHASE_MEMORY = "1";
  const child = spawn(process.execPath, ["scripts/benchmark-git-operations.mjs", report], { env, stdio: ["ignore", "pipe", "pipe"] });
  const job = { identity, report, mode, reference: reference || "working-tree", child, log, closed: false, code: undefined };
  child.stdout.on("data", chunk => log.push(chunk.toString())); child.stderr.on("data", chunk => log.push(chunk.toString()));
  job.close = new Promise(resolve => {
    child.once("error", error => { job.error = String(error); });
    child.once("close", code => { job.closed = true; job.code = code; resolve(code); });
  });
  return job;
}

/** fs.watch와 실제 child close만 관찰한다. standby는 새 브라우저나 주기적 polling을 만들지 않는다. */
async function waitJSON(file, job) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(value); };
    const check = async () => {
      if (finished) return;
      try { finish(undefined, JSON.parse(await readFile(file, "utf8"))); }
      catch (error) {
        if (error.code !== "ENOENT") finish(error);
        else if (job.closed) finish(new Error(`${job.identity} closed (${job.code}) before ${path.basename(file)}: ${job.log.join("").slice(-4000)}`));
      }
    };
    const watcher = watch(path.dirname(file), () => void check()); watcher.once("error", finish);
    const timer = setTimeout(() => finish(new Error(`Observation deadline; source terminal state must be checked: ${file}`)), 900000);
    void job.close.then(check); void check();
  });
}

/** 성공한 두 source의 Native/DOM 증거와 별도 memory 원문을 하나의 영구 보고서에 묶는다. */
async function collect(job) {
  assert.equal(await job.close, 0, job.log.join("").slice(-6000));
  const raw = await readFile(job.report), report = JSON.parse(raw); assert.equal(report.results.length, operations.length);
  const memory = [];
  for (const result of report.results) {
    assert.equal(result.nativeOperationVerified, true); assert.equal(result.nativeBranchVerified, true); assert.equal(result.historyExact, true);
    assert.ok(result.liveRenderer); assert.equal(result.nativeOracleAfterMeasuredFrame, true);
    if (result.phaseResources) assert.equal(result.phaseResources.browserComplete, true);
    const sample = result.phaseResources?.phaseMemory;
    if (sample) { const bytes = await readFile(sample.rawSamplesFile); assert.equal(digest(bytes), sample.rawSamplesSha256);
      memory.push({ operation: result.operation, sha256: digest(bytes), samples: JSON.parse(bytes) }); }
  }
  return { identity: job.identity, mode: job.mode, reference: job.reference, closeCode: job.code, reportSha256: digest(raw), report, memory };
}

/** 두 순서·세 mode를 분리한다. 마지막 작업도 launcher 정리를 기다린 뒤 반대 source를 허용한다. */
async function main() {
  assert.ok(process.argv[2], "An explicit report path is required");
  const baselineCommit = git(["rev-parse", "--verify", `${baseline}^{commit}`]).trim(), fingerprint = await runtimeFingerprint();
  const report = { baselineCommit, fingerprint, operations, runs: [], completed: false,
    scope: "Small owned synthetic repositories only: 1000 files, 1800 commits, 100 side branches, 8 shared upstreams. Per-operation interleaving B/A then A/B; separate latency, CPU and sampled simultaneous RSS modes. Native operation and final first-page oracle plus production HTML/CSP/JS. merge-no-ff invokes Native CLI directly; other matrix rows invoke actual services, not user controls. Independent fresh source Nodes and equal deterministic fixture content; no Captain access. Filesystem-warm functional oracle, no GitHub network or active VS Code timing claim." };
  await mkdir(path.dirname(output), { recursive: true });
  for (const mode of (process.env.GSC_BENCH_PAIRED_MODES || "latency,cpu,memory").split(",")) {
    assert.ok(["latency", "cpu", "memory"].includes(mode));
    for (let pair = 0; pair < 2; pair++) {
      const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-operation-pair-"));
      const jobs = [launch(directory, "before", mode, baselineCommit), launch(directory, "after", mode)];
      try {
        for (const job of jobs) assert.deepEqual((await waitJSON(path.join(directory, `${job.identity}-ready.json`), job)).operations, operations);
        for (const [index, operation] of operations.entries()) {
          for (const job of pair ? [...jobs].reverse() : jobs) {
            await publish(path.join(directory, `${job.identity}-${index}.go.json`), { index, operation });
            await waitJSON(path.join(directory, `${job.identity}-${index}.done.json`), job);
            if (index === operations.length - 1) assert.equal(await job.close, 0);
            console.error(`${mode} pair ${pair + 1}: ${job.identity} ${operation} completed`);
          }
        }
        for (const job of jobs) report.runs.push({ pair, ...await collect(job) });
        assert.deepEqual(await runtimeFingerprint(), fingerprint);
        await writeFile(output, JSON.stringify(report, null, 2) + "\n");
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        await publish(path.join(directory, "abort.json"), { error: String(error) });
        await writeFile(output + ".failure.json", JSON.stringify({ directory, error: String(error),
          jobs: jobs.map(job => ({ identity: job.identity, pid: job.child.pid, closed: job.closed, code: job.code, log: job.log.join("") })) }, null, 2));
        throw error;
      }
    }
  }
  report.completed = true; await writeFile(output, JSON.stringify(report, null, 2) + "\n");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
