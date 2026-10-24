// 현재 머신 부하를 그대로 둔 상태에서 baseline/current 탐색을 독립 Node 수명으로 교차 비교한다.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const baseline = process.env.GSC_BENCH_DISCOVERY_BASELINE || "b8b453b508d07cbe1fb20bf8dc340bc675d804f4";
const digest = value => createHash("sha256").update(value).digest("hex");

/** 미추적 새 모듈도 포함해 제품 소스가 비교 도중 바뀌지 않았음을 확인한다. */
async function fingerprint() {
  const files = execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "src", "media", "package.json"])
    .toString().split("\0").filter(Boolean).sort(), hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(await readFile(file)).update("\0");
  return { files: files.length, sha256: hash.digest("hex") };
}

/** source launcher의 실제 close를 기다린다. quiet나 관찰 제한 시간을 완료로 바꾸지 않는다. */
async function run(output, mode, phase) {
  const env = { ...process.env, GSC_BENCH_DISCOVERY_MODE: mode }; delete env.GSC_BENCH_SOURCE_REF;
  if (phase === "before") env.GSC_BENCH_SOURCE_REF = baseline;
  let log = "";
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/benchmark-discovery-burst.mjs", output], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", value => { log = (log + value).slice(-16000); }); child.stderr.on("data", value => { log = (log + value).slice(-16000); });
    child.once("error", reject); child.once("close", resolve);
  });
  assert.equal(code, 0, log);
  const raw = await readFile(output), report = JSON.parse(raw), memory = [];
  assert.equal(report.results.length, 4);
  for (const row of report.results) {
    assert.equal(row.nativeIdentityExact, true); assert.equal(row.protectedStateUnchanged, true);
    if (row.memory) {
      const bytes = await readFile(row.memory.rawSamplesFile); assert.equal(digest(bytes), row.memory.rawSamplesSha256);
      memory.push({ label: row.label, sha256: digest(bytes), samples: JSON.parse(bytes) });
    }
  }
  return { phase, mode, reportSha256: digest(raw), report, memory };
}

/** latency·CPU·RSS를 분리하고 B/A/A/B 순서의 원시 값과 입력 보호 증거를 영구 기록한다. */
async function main() {
  assert.ok(process.argv[2], "An explicit report path is required");
  const output = path.resolve(process.argv[2]), frozen = await fingerprint(), directory = await mkdtemp(path.join(os.tmpdir(), "gsc-discovery-paired-"));
  const record = { baseline, fingerprint: frozen, completed: false, runs: [],
    scope: "Existing machine load observed without machine-wide stress. Separate latency, waited-Native+Node CPU and sampled owned-process RSS modes, each B/A/A/B. Two independent Node lifetimes/source/mode; two correlated rounds/request kind/lifetime. Fixed 34-directory owned input, independent Native identity and protected HEAD/index/config/refs. Full resource scopes and limits are in each report." };
  await mkdir(path.dirname(output), { recursive: true });
  try {
    for (const mode of ["latency", "cpu", "memory"]) {
      for (const [index, phase] of ["before", "after", "after", "before"].entries()) {
        record.runs.push(await run(path.join(directory, `${mode}-${index}.json`), mode, phase));
        assert.deepEqual(await fingerprint(), frozen);
        await writeFile(output, JSON.stringify(record, null, 2) + "\n");
        console.error(`Completed discovery ${mode} ${phase} (${index + 1}/4)`);
      }
    }
    record.completed = true; await writeFile(output, JSON.stringify(record, null, 2) + "\n");
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    await writeFile(output + ".failure.json", JSON.stringify({ directory, error: String(error) }) + "\n"); throw error;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
