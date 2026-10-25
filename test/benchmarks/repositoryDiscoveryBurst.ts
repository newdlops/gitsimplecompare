// 실제 폴더 탐색의 fan-out을 소유 Native 저장소에서 측정한다. 머신 전체에 부하를 생성하지 않는다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { GitServiceRegistry } from "../../src/git/serviceRegistry";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { loadChildResourceProbe } from "../helpers/childResourceProbe";
import { PhaseMemorySampler } from "../helpers/phaseMemorySampler";
import { summarizePhaseMemory } from "../helpers/phaseMemorySummary";
import { benchmarkOverrides as mock } from "../helpers/benchmarkOverrides";
import { setGitExecutableResolver } from "../../src/git/gitExec";

const source = JSON.parse(process.env.GSC_BENCH_SOURCE!), mode = process.env.GSC_BENCH_DISCOVERY_MODE || "latency";
delete process.env.GSC_BENCH_SOURCE; delete process.env.GSC_BENCH_SOURCE_REF;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** 독립 Native control은 fixture/oracle에서만 실행하고 측정 창에 넣지 않는다. */
function native(root: string, ...args: string[]): string {
  return execFileSync("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], { cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" }, timeout: 30000 }).toString().trim();
}

/** 읽기 전후 Native refs와 HEAD·index·config 바이트가 그대로인지 확인한다. */
async function protectedState(root: string) {
  const files = await Promise.all(["HEAD", "index", "config"].map(async file => [file, hash(await readFile(path.join(root, ".git", file)))]));
  return { files, refs: hash(native(root, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)")) };
}

/** 같은 시점의 34개 Explorer 폴더 요청을 실제 서비스에 전달하고 Native identity를 검증한다. */
async function burst(root: string, dirs: string[], mixed: boolean, label: string,
  probe?: Awaited<ReturnType<typeof loadChildResourceProbe>>) {
  const beforeState = await protectedState(root), load = os.loadavg(), events: unknown[] = [];
  const registry = new GitServiceRegistry(undefined, fields => events.push({ consumers: fields.consumers }));
  const calls: GitExecutionTiming[] = [], active = new Set<number>(); let peak = 0;
  const register = gitProcesses.register.bind(gitProcesses), closed = gitProcesses.closed.bind(gitProcesses);
  mock.method(gitProcesses, "register", (...args: Parameters<typeof register>) => {
    const id = register(...args); active.add(id); peak = Math.max(peak, active.size); return id;
  });
  mock.method(gitProcesses, "closed", async (id: number) => { try { await closed(id); } finally { active.delete(id); } });
  let sampler: PhaseMemorySampler | undefined;
  try {
    if (mode === "memory") sampler = await PhaseMemorySampler.start([]);
    const stop = setGitExecutionObserver(value => calls.push(value)), children = probe?.(), cpu = process.cpuUsage(), start = performance.now();
    let results: Awaited<ReturnType<GitServiceRegistry["resolve"]>>[];
    try {
      results = await Promise.all(dirs.map(async (directory, index) => {
        if (mixed && index % 3 === 0) {
          const result = await registry.resolveWithBranch(directory); assert.equal(result?.branch, "main"); return result?.service;
        }
        return registry.resolve(directory);
      }));
    } finally { stop(); }
    const elapsedMs = performance.now() - start, node = process.cpuUsage(cpu), childAfter = probe?.();
    const memory = await sampler?.stop(); sampler = undefined;
    const memoryReport = memory ? await summarizePhaseMemory(memory, label) : undefined;
    assert.ok(results.every(result => result?.repoRoot === root)); assert.equal(active.size, 0);
    assert.ok(calls.length && calls.every(call => call.command === "rev-parse" && call.outcome === "success"));
    assert.deepEqual(await protectedState(root), beforeState);
    const childCpuMs = children && childAfter ? childAfter.userCpuMs + childAfter.systemCpuMs - children.userCpuMs - children.systemCpuMs : undefined;
    const nodeCpuMs = (node.user + node.system) / 1000;
    return { label, mode, input: mixed ? "mixed-root-branch" : "root-only", directories: dirs.length, elapsedMs,
      calls: calls.length, peakGitProcesses: peak, nodeCpuMs, childCpuMs,
      ownedCpuMs: childCpuMs === undefined ? undefined : childCpuMs + nodeCpuMs,
      nativeIdentityExact: true, protectedStateUnchanged: true, loadBefore: load, loadAfter: os.loadavg(), events,
      ...(memoryReport ? { memory: memoryReport, memoryRunTimeAndCpuDiagnosticOnly: true } : {}) };
  } finally { await sampler?.stop(); await gitProcesses.dispose(); mock.restoreAll(); }
}

/** source마다 같은 파일/commit/폴더를 만들고 별도 모드의 원문을 기록한다. 실패 fixture는 보존한다. */
async function main() {
  assert.ok(process.argv[2]); assert.ok(["latency", "cpu", "memory"].includes(mode));
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-discovery-benchmark-")), root = path.join(directory, "repository");
  const executable = process.env.GSC_BENCH_DISCOVERY_EXECUTABLE;
  const restoreExecutable = executable ? setGitExecutableResolver(() => executable) : undefined;
  let complete = false;
  try {
    await mkdir(root); native(root, "-c", "init.templateDir=", "init", "-q", "--initial-branch=main");
    for (const [key, value] of Object.entries({ "user.name": "Discovery Fixture", "user.email": "discovery@example.invalid", "core.fsmonitor": "false",
      "core.hooksPath": path.join(directory, "empty-hooks"), "commit.gpgSign": "false" })) native(root, "config", key, value);
    await mkdir(path.join(directory, "empty-hooks")); await writeFile(path.join(root, "tracked.txt"), "fixture\n");
    native(root, "add", "tracked.txt"); native(root, "commit", "-qm", "base");
    const physicalRoot = await realpath(root), dirs = Array.from({ length: 34 }, (_, index) => path.join(physicalRoot, "packages", `module-${index}`, "src"));
    await Promise.all(dirs.map(dir => mkdir(dir, { recursive: true })));
    assert.equal(native(dirs[0], "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"), physicalRoot + "\nmain");
    const probe = mode === "cpu" ? await loadChildResourceProbe(directory) : undefined;
    const results = [];
    // 모든 source의 filesystem/JIT 준비를 같은 실제 조회로 수행한다. warmup은 표본에 포함하지 않는다.
    await burst(physicalRoot, dirs, false, "warmup");
    for (const [kind, mixed] of [["root", false], ["mixed", true]] as const) {
      for (let index = 0; index < 2; index++) results.push(await burst(physicalRoot, dirs, mixed, `${kind}-${index}`, probe));
    }
    await writeFile(process.argv[2], JSON.stringify({ source, mode, executable: executable || "git", results,
      scope: "34 distinct physical directories in one owned worktree. Fresh registry per burst, fixed Native root/branch oracle and HEAD/index/config/refs byte protection. Existing machine load observed; no machine-wide stress generated. Separate latency, Node+waited-Native CPU and sampled simultaneous RSS modes. CPU excludes fixture/probe/oracle; memory mode time/CPU diagnostic only. Two rounds per request kind within one Node are correlated; use independent source Node lifetimes for comparison. No GitHub, rendered Graph or active VS Code transport latency claim." }, null, 2) + "\n");
    complete = true;
  } finally { restoreExecutable?.(); await gitProcesses.dispose(); if (complete) await rm(directory, { recursive: true, force: true }); else console.error(`Preserved discovery fixture: ${directory}`); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
