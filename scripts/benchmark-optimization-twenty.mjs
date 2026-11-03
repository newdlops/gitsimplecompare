// HEAD와 현재 작업 트리를 임시 bundle로 비교한다. 사용자 Git 상태나 원본 코드는 변경하지 않는다.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir, cpus, totalmem, platform, release } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd(), base = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const temporary = await mkdtemp(path.join(tmpdir(), "gsc-optimization-paired-"));
const baselineOverride = process.env.GSC_OPT_BASELINE_DIR ? path.resolve(process.env.GSC_OPT_BASELINE_DIR) : undefined;
const baselineRoot = baselineOverride ?? path.join(temporary, "baseline"), fixtures = path.join(temporary, "fixtures");
const output = path.resolve(root, process.env.GSC_OPT_OUTPUT || "docs/benchmarks/optimization-twenty-paired.json");
const repetitions = Number(process.env.GSC_OPT_REPEATS || 3);
const cases = process.argv.slice(2).length ? process.argv.slice(2) : [
  "lcs-equal", "lcs-start", "lcs-middle", "lcs-end", "lcs-text-end", "synthetic-small", "synthetic-large", "synthetic-expanded", "tracked-diff",
  "binary-stage", "binary-discard", "binary-commit", "stash-files", "stats-shared", "stats-sequential", "stash-list", "stash-list-expanded", "stash-reorder", "working-content", "recovery", "recovery-panel",
  "remote-queue", "worktree-map", "selection-map",
];
assert.ok(Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 10);
const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_AUTHOR_NAME: "Benchmark", GIT_AUTHOR_EMAIL: "benchmark@example.test", GIT_COMMITTER_NAME: "Benchmark",
  GIT_COMMITTER_EMAIL: "benchmark@example.test", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" };

/** fixtureだけでGitを同期実行する。準備・復元は測定区間に入れない。 */
function git(repo, ...args) { return execFileSync("git", args, { cwd: repo, env: environment, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim(); }

/** 外部設定やhookを引き継がない、通常のSHA-1形式の一時保存先を用意する。 */
async function repository(name) {
  const repo = path.join(fixtures, name); await mkdir(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main", "--object-format=sha1");
  git(repo, "config", "core.fsmonitor", "false"); git(repo, "config", "core.logAllRefUpdates", "false");
  git(repo, "config", "commit.gpgsign", "false"); git(repo, "config", "core.autocrlf", "false");
  await writeFile(path.join(repo, "base.txt"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  return repo;
}

/** 실제 크기·개수를 고정하고 생성·Git 초기화 비용은 모두 측정 구간에서 제외한다. */
async function prepareFixtures() {
  await mkdir(fixtures, { recursive: true });
  const small = await repository("small");
  for (let i = 0; i < 400; i++) await writeFile(path.join(small, `file-${String(i).padStart(4, "0")}.txt`), "one\ntwo\n".repeat(10));
  // 동시 통계 사례가 읽는 동일 파일이다. 작은 파일 목록 사례에도 이 한 파일이 함께 포함된다.
  await writeFile(path.join(small, "large-stat.txt"), "line of text\n".repeat(80000));
  const large = await repository("large");
  const largeText = ("x".repeat(79) + "\n").repeat(Math.floor(4 * 1024 * 1024 / 80));
  for (let i = 0; i < 12; i++) await writeFile(path.join(large, `large-${String(i).padStart(2, "0")}.txt`), largeText);
  const tracked = await repository("tracked"), original = Array.from({ length: 50000 }, (_, i) => `original ${i} ${"x".repeat(32)}`).join("\n") + "\n";
  await writeFile(path.join(tracked, "tracked.txt"), original); git(tracked, "add", "."); git(tracked, "commit", "-qm", "tracked base");
  await writeFile(path.join(tracked, "tracked.txt"), original.replaceAll("original", "modified"));
  const binary = await repository("binary");
  for (let i = 0; i < 24; i++) await writeFile(path.join(binary, `file-${i}.dat`), Buffer.from([0, 1, 2]));
  git(binary, "add", "."); git(binary, "commit", "-qm", "binary base");
  const binaryHead = git(binary, "rev-parse", "HEAD");
  const stash = await repository("stash");
  for (let i = 0; i < 12; i++) await writeFile(path.join(stash, `new-${i}.txt`), `saved file ${i}\n`);
  git(stash, "stash", "push", "-qum", "inspect files");
  const stashHash = git(stash, "rev-parse", "refs/stash");
  const recovery = await repository("recovery"), stream = [];
  for (let i = 0; i < 2400; i++) {
    const message = `recovery ${String(i).padStart(5, "0")}`;
    stream.push(`commit refs/heads/temporary\ncommitter Benchmark <benchmark@example.test> ${1577836800 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n\n`);
  }
  execFileSync("git", ["fast-import", "--quiet"], { cwd: recovery, env: environment, input: stream.join(""), stdio: ["pipe", "pipe", "pipe"] });
  const objectHashes = git(recovery, "rev-list", "refs/heads/temporary").split("\n");
  git(recovery, "update-ref", "-d", "refs/heads/temporary");
  git(recovery, "config", "core.logAllRefUpdates", "true"); git(recovery, "commit", "--allow-empty", "-qm", "visible reflog");
  const stashList = await repository("stash-list"), logs = path.join(stashList, ".git/logs/refs"); await mkdir(logs, { recursive: true });
  // 목록 조회만 위한 유효 commit OID·reflog metadata다. 이 fixture로 stash apply/restore 성능을 주장하지 않는다.
  await rm(path.join(stashList, ".git/objects"), { recursive: true });
  // 로컬 공유 object database를 읽게 해 목록의 500개 OID가 모두 정상 객체로 검증되도록 한다.
  await mkdir(path.join(stashList, ".git/objects/info"), { recursive: true });
  await writeFile(path.join(stashList, ".git/objects/info/alternates"), path.join(recovery, ".git/objects") + "\n");
  git(stashList, "update-ref", "refs/stash", objectHashes[0]);
  const log = objectHashes.slice(0, 500).reverse().map((hash, i) => `${"0".repeat(40)} ${hash} Benchmark <benchmark@example.test> ${1577836800 + i} +0000\tOn main: saved work ${i}\n`).join("");
  await writeFile(path.join(logs, "stash"), log);
  const info = { binaryHead, stashHash, syntheticFiles: 12, syntheticSourceBytes: Buffer.byteLength(largeText) * 12,
    recoveryObjects: objectHashes.length, stashMetadataEntries: 500 };
  await writeFile(path.join(fixtures, "fixture.json"), JSON.stringify(info));
  return info;
}

/** baseline는 Git archive로 분리한다. 현재 source를 바꾸거나 stash/reset/checkout하지 않는다. */
async function compile() {
  if (!baselineOverride) {
    await mkdir(baselineRoot, { recursive: true });
    const archive = execFileSync("git", ["archive", "--format=tar", base, "src"], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    execFileSync("tar", ["-xf", "-", "-C", baselineRoot], { input: archive });
  }
  for (const [variant, source] of [["baseline", baselineRoot], ["current", root]]) {
    await build({ entryPoints: [path.join(root, "test/benchmarks/optimizationTwenty.ts")], bundle: true, platform: "node", format: "cjs",
      target: "node20", logLevel: "silent", nodePaths: [path.join(root, "node_modules")],
      alias: { "@source": path.join(source, "src"), vscode: path.join(root, "test/helpers/vscodeMock.ts") },
      outfile: path.join(temporary, `${variant}.cjs`) });
  }
}

/** 각 표본을 독립 Node 프로세스로 실행하고 오류·timeout·부분 출력을 성공 값으로 처리하지 않는다. */
function worker(variant, name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--expose-gc", path.join(temporary, `${variant}.cjs`), name, fixtures],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Benchmark timed out: ${variant}/${name}`)); }, 90000);
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", code => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(`${variant}/${name} failed (${code}): ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(new Error(`Invalid worker output: ${stdout}\n${stderr}`, { cause: error })); }
    });
  });
}

/** 바이너리 변경의 기준을 매번 복원하고 결과 bytes·index·commit을 측정 밖에서 검사한다. */
async function resetBinary(info) {
  const repo = path.join(fixtures, "binary"); git(repo, "reset", "--hard", info.binaryHead);
  for (let i = 0; i < 24; i++) await writeFile(path.join(repo, `file-${i}.dat`), Buffer.from([0, 3, 4]));
}

/** 캐시 번호 이동 사례도 매 worker의 시작 상태를 같은 한 개의 stash로 맞춘다. */
function resetStash() {
  const repo = path.join(fixtures, "stash");
  while (git(repo, "reflog", "show", "--format=%H", "refs/stash").split("\n").filter(Boolean).length > 1) git(repo, "stash", "drop", "-q", "stash@{0}");
  git(repo, "reset", "--hard", "HEAD");
}

/** 실행 후 실제 Git tree 상태가 의도한 작업과 일치하는지 확인한다. */
function verifyBinary(name) {
  const repo = path.join(fixtures, "binary");
  const args = name === "binary-stage" ? ["diff", "--cached", "--name-only"] : name === "binary-commit" ? ["show", "--format=", "--name-only", "HEAD"] : ["ls-files"];
  const paths = git(repo, ...args).split("\n").filter(file => file.endsWith(".dat"));
  assert.equal(paths.length, 24);
  if (name !== "binary-stage") assert.equal(git(repo, "status", "--porcelain"), "");
}

/** 분산된 원시 표본을 보존하고 중앙값만 요약한다. 서로 다른 종류의 사례를 총합 점수로 합치지 않는다. */
function summary(samples) {
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const result = Object.fromEntries(["elapsedMs", "cpuMs", "rssStartMiB", "sampledPeakRssMiB", "maxRssMiB"].map(key => [key, median(samples.map(sample => sample[key]))]));
  result.wallRangeMs = [Math.min(...samples.map(sample => sample.elapsedMs)), Math.max(...samples.map(sample => sample.elapsedMs))];
  if (samples[0].result.innerMedianMs !== undefined) result.innerMedianMs = median(samples.map(sample => sample.result.innerMedianMs));
  return result;
}

/** 비교가 끝난 모든 원시 측정과 baseline identity를 즉시 저장해 중간 종료에도 증거를 잃지 않는다. */
async function save(report) { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); }

/** 새 파일까지 포함한 source 내용으로 현재 비교 대상을 고정한다. 보고서 생성 자체는 이 값에 포함하지 않는다. */
async function sourceFingerprint(directory = path.join(root, "src"), sourceRoot = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFingerprint(file, sourceRoot));
    else if (entry.isFile()) files.push([path.relative(sourceRoot, file), createHash("sha256").update(await readFile(file)).digest("hex")]);
  }
  return files;
}

try {
  await compile(); const fixtureInfo = await prepareFixtures();
  const sourceHashes = await sourceFingerprint(); sourceHashes.sort(([a], [b]) => a.localeCompare(b));
  const baselineHashes = await sourceFingerprint(path.join(baselineRoot, "src"), baselineRoot); baselineHashes.sort(([a], [b]) => a.localeCompare(b));
  const baselineIdentity = createHash("sha256").update(JSON.stringify(baselineHashes)).digest("hex");
  const identity = createHash("sha256").update(JSON.stringify(sourceHashes)).digest("hex");
  const previous = process.env.GSC_OPT_APPEND === "1" ? JSON.parse(await readFile(output, "utf8")) : undefined;
  if (previous) {
    assert.equal(previous.baselineCommit, baselineOverride ? undefined : base);
    assert.equal(previous.baselineSourceSha256, baselineIdentity); assert.equal(previous.currentSourceSha256, identity);
    assert.equal(previous.repetitions, repetitions);
  }
  const report = previous ?? { baselineCommit: baselineOverride ? undefined : base, repositoryHead: base,
    baselineKind: baselineOverride ? "pre-fix worktree snapshot" : "HEAD", baselineSourceSha256: baselineIdentity, currentSourceSha256: identity,
    generatedAt: new Date().toISOString(), repetitions,
    environment: { node: process.version, git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(), platform: platform(),
      release: release(), cpu: cpus()[0]?.model, cpuCount: cpus().length, memoryGiB: totalmem() / 2 ** 30 },
    fixture: fixtureInfo, method: "serial isolated workers; alternating AB/BA; OS cache not flushed; power/background load uncontrolled; setup excluded; RSS is Node only; synthetic fixtures; fs observer enabled equally",
    cases: {} };
  report.runs ??= [];
  const covered = new Set(report.runs.flatMap(run => run.cases));
  const initialCases = Object.keys(report.cases).filter(name => !covered.has(name));
  if (initialCases.length) report.runs.unshift({ generatedAt: report.generatedAt, cases: initialCases, fixture: report.fixture });
  report.runs.push({ generatedAt: new Date().toISOString(), cases, fixture: fixtureInfo });
  report.method = "serial isolated workers; alternating AB/BA; OS cache not flushed; power/background load uncontrolled; setup excluded; RSS is Node only; synthetic fixtures; fs observer enabled equally";
  report.limitations = [
    `${repetitions} worker pairs per case: descriptive medians, not statistical significance or production latency guarantees.`,
    "CPU cases use two warmups and fifteen timed operations per worker; innerMedianMs is the median of three worker medians.",
    "Peak RSS is the isolated Node worker, includes bundle and inputs, and excludes VS Code, webview and child Git memory.",
    "Initial synthetic loading and stash pagination return less detail; expanded cases complete the same requested work.",
    "remote-queue, worktree-map and selection-map inject external boundaries and do not measure real network or branch deletion.",
    "Digests compare serialized values (object keys canonicalized in later runs); filesystem observers may affect microbenchmarks.",
  ];
  for (const entry of Object.values(report.cases)) {
    entry.baseline = summary(entry.samples.baseline); entry.current = summary(entry.samples.current);
  }
  for (const name of cases) {
    const samples = { baseline: [], current: [] };
    for (let round = 0; round < repetitions; round++) {
      for (const variant of round % 2 ? ["current", "baseline"] : ["baseline", "current"]) {
        if (name.startsWith("binary-")) await resetBinary(fixtureInfo);
        if (name === "stash-reorder") resetStash();
        samples[variant].push(await worker(variant, name));
        if (name.startsWith("binary-")) verifyBinary(name);
      }
    }
    const before = samples.baseline[0].result, after = samples.current[0].result;
    if (before.digest && after.digest && !["synthetic-large"].includes(name)) assert.equal(after.digest, before.digest, `${name} changed results`);
    if (name === "synthetic-large") assert.equal(after.pathsDigest, before.pathsDigest);
    if (name === "stash-list") assert.equal(after.first50Digest, before.first50Digest);
    if (name === "stash-list-expanded") assert.equal(after.allDigest, before.allDigest);
    const baseline = summary(samples.baseline), current = summary(samples.current);
    report.cases[name] = { baseline, current, wallReductionPercent: (baseline.elapsedMs - current.elapsedMs) / baseline.elapsedMs * 100, samples };
    await save(report);
    console.log(JSON.stringify({ name, baselineMs: baseline.elapsedMs, currentMs: current.elapsedMs,
      changePercent: report.cases[name].wallReductionPercent, before: before.files ?? before.shown, after: after.files ?? after.shown }));
  }
  console.log(`Saved paired evidence: ${output}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
