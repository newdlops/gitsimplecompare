// 공개 fixture만 사용하는 읽기 성능 비교. 토큰·헤더·본문은 메모리 밖으로 내보내지 않는다.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";

const require = createRequire(import.meta.url), root = process.cwd();
const base = "706d1c2a6c8b2d5c01e45e12735e5590572a43aa";
const pairs = Number(argument("pairs") ?? 7), scenario = argument("scenario") ?? "all";
const output = argument("output") ?? "/private/tmp/gsc-github-http-benchmark.json";
assert(Number.isInteger(pairs) && pairs > 0 && pairs <= 7);
assert(["all", "reads", "transport", "native"].includes(scenario));
const samples = [], comparisons = [], scratch = await mkdtemp("/private/tmp/gsc-http-benchmark-");
const protectedPaths = [".git/HEAD", ".git/index", ".git/config"].map(name => path.join(root, name));
const protectedBefore = await Promise.all(protectedPaths.map(fileHash));
let currentMeasurement, nativeDirectory, nativeChecks;
const originalSpawn = childProcess.spawn;

/** 분석할 raw argv·stdout·stderr는 저장하지 않고 실제 CLI 수/바이트/종료 시간만 집계한다. */
childProcess.spawn = function(command, args, options) {
  if (nativeDirectory && path.basename(String(command)) === "git" && options?.cwd === nativeDirectory && args?.[0] === "push") {
    assert(args.includes("--dry-run"), "Native benchmark must never perform a real push");
  }
  const owned = currentMeasurement, started = performance.now();
  const api = args?.[0] === "api", credential = args?.[0] === "auth" && args?.[1] === "token";
  const child = originalSpawn.apply(this, arguments);
  if (owned && api) {
    owned.cliApiProcesses++;
    child.stdout?.on("data", chunk => { owned.cliResponseBytes += Buffer.byteLength(chunk); });
  }
  if (owned && credential) {
    owned.credentialCliProcesses++;
    child.once("close", () => { owned.credentialCliMs += performance.now() - started; });
  }
  return child;
};

/** 고정된 옵션 이름만 받아 benchmark 대상/출력 위치를 명시한다. */
function argument(name) { return process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3); }
/** 전체 DTO의 배열 순서를 보존하고 객체 key 순서만 정규화한다. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
/** 공개 DTO도 파일에는 원문 대신 SHA만 기록해 실제 동등성 근거를 남긴다. */
function digest(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
/** HEAD/index/config의 원문 없이 변경 여부를 검증한다. */
async function fileHash(file) { try { return createHash("sha256").update(await readFile(file)).digest("hex"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
/** 표본은 반올림해 저장하되 실제 비교는 canonical DTO 전체에 수행한다. */
function rounded(value) { return Math.round(value * 10) / 10; }

/** 커밋 전 소스를 임시 디렉터리에만 풀어 현재 checkout을 이동하지 않고 동일 Node에서 번들한다. */
async function bundle(source, name, current) {
  const exports = ["export {fetchPullRequestListPage} from './src/git/pullRequestListService';",
    "export {searchPullRequests} from './src/git/pullRequestSearchService';",
    "export {PullRequestService} from './src/git/pullRequestService';",
    "export {beginGitHubReadLifetime} from './src/git/githubReadCache';",
    "export {clearGitHubRepositoryNameCache} from './src/git/githubRepositoryName';",
    "export {runGit,runGitDetailed,withGitConfigOverrides} from './src/git/gitExec';",
    "export {__outputLines} from 'vscode';",
    ...(current ? ["export {setGitHubReadPolicyResolver} from './src/git/githubReadRuntime';",
      "export {detectGitHubSystemProxy} from './src/git/githubSystemProxy';"] : [])];
  const outfile = path.join(scratch, `${name}.cjs`);
  await build({ stdin: { contents: exports.join("\n"), resolveDir: source, loader: "ts" }, outfile,
    bundle: true, platform: "node", format: "cjs", target: "node18", logLevel: "silent",
    nodePaths: [path.join(root, "node_modules")], alias: { vscode: path.join(root, "test/helpers/vscodeMock.ts") } });
  return require(outfile);
}

/** 실제 read lifetime을 새로 열며 지원되지 않는 네트워크 정책은 측정 전에 직접 HTTP 비교에서 제외한다. */
async function lifetime(api, mode) {
  const reset = api.setGitHubReadPolicyResolver?.(async () => ({ transport: typeof mode === "function" ? mode() : mode,
    systemProxy: await api.detectGitHubSystemProxy() }));
  api.clearGitHubRepositoryNameCache();
  const stop = api.beginGitHubReadLifetime();
  return async () => { await stop(); reset?.(); };
}

/** 인증 준비를 포함한 실제 첫 progress/완료 시간을 측정하고 transport 수명 로그만 수치로 변환한다. */
async function measure(api, label, pair, mode, task) {
  const started = performance.now(), logStart = api.__outputLines.length;
  let first;
  const metric = currentMeasurement = { scenario: label, pair, mode, cliApiProcesses: 0, credentialCliProcesses: 0,
    credentialCliMs: 0, cliResponseBytes: 0 };
  try {
    const value = await task(() => { first ??= performance.now() - started; });
    const wallMs = performance.now() - started;
    const requests = api.__outputLines.slice(logStart).filter(line => line.includes("GitHub HTTP request closed "))
      .map(line => JSON.parse(line.slice(line.indexOf("{"))));
    Object.assign(metric, { wallMs: rounded(wallMs), firstMs: rounded(first ?? wallMs), credentialCliMs: rounded(metric.credentialCliMs),
      directHttpRequests: requests.length, reusedConnections: requests.filter(request => request.reused).length,
      wireBytes: requests.reduce((sum, request) => sum + request.wireBytes, 0),
      decodedBytes: requests.reduce((sum, request) => sum + request.bytes, 0),
      queueMs: rounded(requests.reduce((sum, request) => sum + (request.queueMs ?? 0), 0)),
      payloadSha256: digest(value) });
    samples.push(metric);
    console.log(JSON.stringify({ sample: label, pair, mode, wallMs: metric.wallMs, firstMs: metric.firstMs,
      apiReads: metric.cliApiProcesses + metric.directHttpRequests, credentialCliProcesses: metric.credentialCliProcesses }));
    return value;
  } finally { currentMeasurement = undefined; }
}

/** 반환 DTO가 달라지면 속도 표본을 성공으로 기록하지 않는다. 실시간 원격 변경도 숨기지 않는다. */
function compare(scenario, pair, before, after) {
  const equal = digest(before) === digest(after);
  comparisons.push({ scenario, pair, equal, beforeSha256: digest(before), afterSha256: digest(after) });
  assert(equal, `Public ${scenario} DTO changed between paired reads; rerun with a stable fixture`);
}

/** 실제 drawer getDetail의 placeholder까지 포함해 cold/warm 목록·검색·738파일 재열기를 비교한다. */
async function readPairs(before, after) {
  for (let pair = 1; pair <= pairs; pair++) {
    const values = {};
    for (const mode of pair % 2 ? ["before-cli", "after-cli"] : ["after-cli", "before-cli"]) {
      const api = mode === "before-cli" ? before : after;
      const finish = await lifetime(api, mode === "after-cli" ? "cli" : "auto");
      try {
        const cold = await measure(api, "list-cold", pair, mode, progress =>
          api.fetchPullRequestListPage(root, undefined, undefined, undefined, { onProgress: progress }));
        // 첫 CLI bootstrap 뒤 실제 인증 key의 완전한 snapshot도 채워 반복 표시 상태를 양쪽에 동일하게 준비한다.
        const primed = mode === "before-cli" ? cold : await api.fetchPullRequestListPage(root, undefined, undefined, undefined, { previous: cold });
        const warm = await measure(api, "list-warm", pair, mode, progress =>
          api.fetchPullRequestListPage(root, undefined, undefined, undefined, { previous: primed, onProgress: progress }));
        const service = new api.PullRequestService(root);
        const initial = await service.getDetail(14848, undefined, () => {});
        assert.equal(initial.files.length, 738, "The public detail fixture must retain its 738-file snapshot");
        const detail = await measure(api, "detail-reopen", pair, mode, progress => service.getDetail(14848, undefined, progress));
        const search = await measure(api, "search", pair, mode, () => api.searchPullRequests(root, "#14848"));
        values[mode] = { cold, warm, detail, search };
      } finally { await finish(); }
    }
    for (const [label, key] of [["list-cold", "cold"], ["list-warm", "warm"], ["detail-reopen", "detail"], ["search", "search"]]) {
      compare(label, pair, values["before-cli"][key], values["after-cli"][key]);
    }
  }
}

/** 같은 product 쿼리/캐시/credential 정책에서 transport 비용만 교대로 비교한다. UI 설정 변경 지연을 뜻하지 않는다. */
async function transportPairs(api) {
  let mode = "cli";
  const stop = await lifetime(api, () => mode);
  try {
    let previous = await api.fetchPullRequestListPage(root);
    previous = await api.fetchPullRequestListPage(root, undefined, undefined, undefined, { previous });
    const service = new api.PullRequestService(root);
    await service.getDetail(14848, undefined, () => {}); await api.searchPullRequests(root, "#14848");
    for (let pair = 1; pair <= pairs; pair++) {
      const values = {};
      for (const selected of pair % 2 ? ["cli", "auto"] : ["auto", "cli"]) {
        mode = selected;
        const list = await measure(api, "same-code-transport", pair, selected, progress =>
          api.fetchPullRequestListPage(root, undefined, undefined, undefined, { previous, onProgress: progress }));
        const detail = await measure(api, "same-code-detail", pair, selected, progress => service.getDetail(14848, undefined, progress));
        const search = await measure(api, "same-code-search", pair, selected, () => api.searchPullRequests(root, "#14848"));
        values[selected] = { list, detail, search };
      }
      for (const [label, key] of [["same-code-transport", "list"], ["same-code-detail", "detail"], ["same-code-search", "search"]]) {
        compare(label, pair, values.cli[key], values.auto[key]);
      }
      previous = values.auto.list;
    }
  } finally { await stop(); }
}

/** native Git만 객체/인증 helper를 소유한다. 원격 push는 항상 dry-run이고 사용자 저장소는 변경하지 않는다. */
async function nativePairs(api) {
  nativeDirectory = await mkdtemp("/private/tmp/gsc-http-native-");
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_TRACE_CURL: "1", GIT_TRACE_CURL_NO_DATA: "1", GIT_TRACE_REDACT: "1" };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_(?:KEY|VALUE)_\d+)$/.test(key)) delete env[key];
  const run = (args, enabled = false) => api.runGitDetailed(args, nativeDirectory,
    { env, inheritEnv: false, githubProactiveAuth: enabled, retryOnLock: false });
  try {
    await run(["init", "-q", "-b", "main"]);
    assert.equal((await run(["rev-parse", "--show-toplevel"])).stdout.trim(), nativeDirectory);
    await mkdir(path.join(nativeDirectory, "hooks"));
    await run(["config", "core.hooksPath", path.join(nativeDirectory, "hooks")]);
    await run(["remote", "add", "origin", "https://github.com/newdlops/gitsimplecompare.git"]);
    await run(["fetch", "--depth=1", "--filter=blob:none", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    const head = (await run(["rev-parse", "refs/remotes/origin/main"])).stdout.trim();
    await run(["update-ref", "refs/heads/main", head]);
    await run(["config", "branch.main.remote", "origin"]); await run(["config", "branch.main.merge", "refs/heads/main"]);
    const config = await fileHash(path.join(nativeDirectory, ".git/config"));
    for (let pair = 1; pair <= pairs; pair++) for (const enabled of pair % 2 ? [false, true] : [true, false]) {
      for (const [label, args] of [["git-fetch", ["fetch", "--all", "--prune"]], ["git-pull", ["pull", "--no-rebase", "--no-edit"]],
        ["git-push-dry-run", ["push", "--dry-run", "--porcelain", "origin", "HEAD:refs/heads/main"]]]) {
        const logStart = api.__outputLines.length, started = performance.now(), result = await run(args, enabled);
        const policy = api.__outputLines.slice(logStart).filter(line => line.includes("GitHub native proactive authentication checked "))
          .map(line => JSON.parse(line.slice(line.indexOf("{"))));
        samples.push({ scenario: label, pair, mode: enabled ? "proactive" : "legacy", wallMs: rounded(performance.now() - started),
          requestedProactiveAuth: enabled, appliedProactiveAuth: policy.some(item => item.enabled), policyReasons: [...new Set(policy.map(item => item.reason))],
          httpMethods: [...result.stderr.matchAll(/=> Send header: (GET|POST) /g)].map(match => match[1]),
          responseStatuses: [...result.stderr.matchAll(/<= Recv header: HTTP\/(?:1\.1|2|3) (\d+)/g)].map(match => Number(match[1])) });
      }
    }
    assert.equal((await run(["rev-parse", "HEAD"])).stdout.trim(), head);
    assert.equal(await fileHash(path.join(nativeDirectory, ".git/config")), config);
    const helper = path.join(nativeDirectory, "invalid-credential-helper");
    await writeFile(helper, '#!/bin/sh\nif [ "$1" = get ]; then printf "username=gsc-invalid-fixture\\npassword=gsc-invalid-fixture-token\\n"; fi\n', { mode: 0o755 });
    const cleared = api.withGitConfigOverrides(env, { "credential.helper": "", "http.extraHeader": "" });
    const invalid = api.withGitConfigOverrides(cleared, { "credential.helper": `!${helper}` });
    let failure;
    try { await api.runGitDetailed(["push", "--dry-run", "--porcelain", "origin", "HEAD:refs/heads/main"], nativeDirectory,
      { env: invalid, inheritEnv: false, githubProactiveAuth: false, retryOnLock: false }); }
    catch (error) { failure = error; }
    assert(failure, "Invalid fixture credentials must never authenticate a dry-run push");
    nativeChecks = { invalidCredentialsFail: true, noRealPush: true, temporaryConfigUnchanged: config === await fileHash(path.join(nativeDirectory, ".git/config")),
      responseStatuses: [...(failure.stderr ?? "").matchAll(/<= Recv header: HTTP\/(?:1\.1|2|3) (\d+)/g)].map(match => Number(match[1])) };
  } finally { await rm(nativeDirectory, { recursive: true, force: true }); nativeDirectory = undefined; }
}

/** 각 구간의 중앙값과 7개 원자료를 함께 보존해 단일 좋은 표본만 선택하지 않는다. */
function summaries() {
  const median = values => { const sorted = [...values].sort((a, b) => a - b); return rounded(sorted[Math.floor(sorted.length / 2)]); };
  const groups = new Map();
  for (const sample of samples) { const key = `${sample.scenario}:${sample.mode}`; const items = groups.get(key) ?? []; items.push(sample); groups.set(key, items); }
  return [...groups].map(([key, items]) => ({ key, count: items.length, medianMs: median(items.map(item => item.wallMs)),
    ...(items[0].firstMs === undefined ? {} : { medianFirstMs: median(items.map(item => item.firstMs)),
      apiReads: [...new Set(items.map(item => item.cliApiProcesses + item.directHttpRequests))] }) }));
}

/** 재현 가능한 공개 요청만 수행한 뒤 원문 없는 성능/동등성 artifact를 쓴다. */
async function main() {
  process.env.GH_REPO = "cli/cli"; process.env.GH_HOST = "github.com"; delete process.env.GH_DEBUG;
  const beforeRoot = path.join(scratch, "before"); await mkdir(beforeRoot);
  childProcess.execFileSync("tar", ["-x", "-C", beforeRoot], { input: childProcess.execFileSync("git", ["archive", base, "src"], { cwd: root, maxBuffer: 128 * 1024 * 1024 }) });
  const before = await bundle(beforeRoot, "before", false), after = await bundle(root, "after", true);
  assert.equal(await after.detectGitHubSystemProxy(), "none", "Direct benchmark requires a proven proxy-free system policy");
  if (scenario === "all" || scenario === "reads") await readPairs(before, after);
  if (scenario === "all" || scenario === "transport") await transportPairs(after);
  if (scenario === "all" || scenario === "native") await nativePairs(after);
  assert.deepEqual(await Promise.all(protectedPaths.map(fileHash)), protectedBefore);
  const record = { observedAtUtc: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    baselineCommit: base, implementationCommit: childProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    publicRepository: "cli/cli", detail: { number: 14848, files: 738, productionCaller: "PullRequestService.getDetail" },
    pairs, alternatingOrder: true, includesCredentialAcquisition: true, credentialSource: process.env.GH_TOKEN || process.env.GITHUB_TOKEN ? "environment" : "gh-stored",
    sourceProtectedFilesUnchanged: true, allPairedDTOsEqual: comparisons.every(item => item.equal),
    limitations: ["One public repository; live mutable remote data must remain equal between each pair.",
      "Direct figures require an Agent-preserving network policy. VS Code default proxySupport=override selects CLI; after-cli represents that supported fallback.",
      "CLI API process counts are structural read counts, not packet captures. Direct HTTP counts are actual request-close events.",
      "CLI API timing has GH_DEBUG disabled. Native Git HTTP tracing is enabled equally in both modes and never persisted.",
      "Transport-only comparison retains immutable snapshots across policy-resolver modes; it does not measure UI setting changes.",
      "Native fixture is shallow, blobless and up to date. Push is always dry-run; no object upload throughput is claimed."],
    nativeChecks, summary: summaries(), comparisons, samples };
  await writeFile(output, JSON.stringify(record, null, 2) + "\n"); console.log(JSON.stringify({ output, summary: record.summary, allPairedDTOsEqual: record.allPairedDTOsEqual }));
}

try { await main(); }
catch (error) { console.error(JSON.stringify({ failure: error.name, message: error instanceof assert.AssertionError ? error.message : "Public benchmark failed", kind: error.kind, status: error.status })); process.exitCode = 1; }
finally { childProcess.spawn = originalSpawn; await rm(scratch, { recursive: true, force: true }); }
