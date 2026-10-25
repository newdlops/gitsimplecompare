// 실제 branch/ref 규모에서 Native 추적 조회만 검증한다. 이름·제목·OID 원문은 보고서에 남기지 않는다.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { GraphLocalBranchTrackingReader } from "../../src/git/graphLocalBranchTracking";
import { readGraphLocalBranchSnapshot, type GraphLocalBranchRunner } from "../../src/git/graphLocalBranches";
import { runGit } from "../../src/git/gitExec";
import { gitCommandIndex } from "../../src/git/gitCommandPolicy";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { readRepositoryMetadata } from "../../src/git/repositoryMetadata";
import { snapshotDigest } from "../helpers/snapshotDigest";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const source = JSON.parse(process.env.GSC_BENCH_SOURCE!);
delete process.env.GSC_BENCH_SOURCE_REF; delete process.env.GSC_BENCH_SOURCE;

/** @param root 읽기 전용 대상 @returns index/config/checkout과 전체 ref의 비교용 해시다. 부재도 별도 값으로 보존한다. */
async function markers(root: string) {
  const metadata = await readRepositoryMetadata(root); assert.ok(metadata, "The readonly target must have verified metadata paths");
  const files = [path.join(metadata.gitDir, "HEAD"), path.join(metadata.gitDir, "index"), path.join(metadata.commonDir, "config"), path.join(metadata.gitDir, "config.worktree")];
  const hashes = await Promise.all(files.map(async file => {
    try { return digest(await readFile(file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw error; }
  }));
  return { metadata: digest(metadata.identity), hashes };
}

/** 명시한 실제 저장소의 Native 조회를 반복하되 결과 확인과 filesystem hash는 시간 구간 밖에서 수행한다. */
async function main() {
  assert.ok(process.env.GSC_BENCH_READONLY_ROOT && process.argv[2]);
  const root = await realpath(process.env.GSC_BENCH_READONLY_ROOT), output = path.resolve(process.argv[2]);
  const outputParent = await realpath(path.dirname(output));
  assert.ok(outputParent !== root && !outputParent.startsWith(root + path.sep), "The report must remain outside the readonly target");
  // fallback의 stdin cat-file도 같은 Node 환경을 상속하므로 lazy-fetch/optional index 쓰기를 막는다.
  process.env.GIT_NO_LAZY_FETCH = "1"; process.env.GIT_OPTIONAL_LOCKS = "0";
  const calls: string[] = [];
  const runner: GraphLocalBranchRunner = async (args, cwd, options) => {
    assert.equal(cwd, root); const command = args[gitCommandIndex(args)];
    assert.ok(["for-each-ref", "show-ref", "show", "rev-parse", "symbolic-ref"].includes(command), "Readonly Native command only");
    calls.push(command);
    return runGit(["-c", "core.fsmonitor=false", ...args], cwd,
      { ...options, env: { ...options?.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" } });
  };
  const protectedBefore = await markers(root), refs = () => runner(["for-each-ref", "--format=%(refname) %(objectname)"], root);
  const refsBefore = digest(await refs()), reader = new GraphLocalBranchTrackingReader(root, runner);
  const initial = await reader.read(), results = [];
  for (let round = 0; round < 4; round++) {
    const before = digest(await refs()), stateBefore = await markers(root); calls.length = 0;
    const cpu = process.cpuUsage(), start = performance.now(), actual = await reader.read();
    const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu), commands = [...calls];
    const native = await readGraphLocalBranchSnapshot(root, runner), after = digest(await refs()), stateAfter = await markers(root);
    const stable = before === after && JSON.stringify(stateBefore) === JSON.stringify(stateAfter);
    const actualHash = snapshotDigest(actual), expectedHash = snapshotDigest(native), nativeExact = isDeepStrictEqual(actual, native);
    if (stable) assert.ok(nativeExact, "Stable readonly branch state differs from independent Native Git");
    results.push({ round, elapsedMs, nodeCpuMs: (used.user + used.system) / 1000, commands, stable,
      nativeExact, actualHash, expectedHash, branches: actual.branches.length });
  }
  const protectedAfter = await markers(root), refsAfter = digest(await refs());
  const report = { source, environmentKeys: Object.keys(process.env).length, initialBranches: initial.branches.length,
    initialTracked: initial.branches.filter(branch => branch.upstream && !branch.gone).length,
    initialDivergent: initial.branches.filter(branch => branch.ahead || branch.behind).length,
    initialUniqueUpstreams: new Set(initial.branches.map(branch => branch.upstream).filter(Boolean)).size,
    results, protectedBefore, protectedAfter, refsBefore, refsAfter,
    protectedStateStable: JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter) && refsBefore === refsAfter,
    scope: "Actual target read only: Native ref/metadata/tracking queries, no checkout/config/index/ref writes or network hydration. Reports/builds outside target. Four correlated warm reads in one process/source; Node CPU excludes Native children and OS. Private branch names, subjects and OIDs are represented only by whole-result hashes. Concurrent target changes mark results unstable; unstable timings are not comparative evidence." };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ source: report.source, branches: initial.branches.length, protectedStateStable: report.protectedStateStable, results }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => gitProcesses.dispose());
