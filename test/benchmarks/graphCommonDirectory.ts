// 같은 root의 cold 카탈로그 동시 요청을 Native Git으로 비교한다. 저장소 파일은 읽기만 한다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GraphBranchCatalog } from "../../src/git/graphBranchCatalog";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { runGit } from "../../src/git/gitExec";
import { loadChildResourceProbe } from "../helpers/childResourceProbe";
import { PhaseMemorySampler } from "../helpers/phaseMemorySampler";

const FS = "\x1f";
/** 원본을 기록하지 않고 metadata·Native ref 전체의 바이트 일치만 검사한다. */
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** 부재와 파일 교체도 구분하되 읽기에 따라 바뀌는 atime은 비교하지 않는다. */
async function marker(file: string) {
  try {
    const info = await stat(file);
    return { hash: digest(await readFile(file)), dev: info.dev, ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** 실제 저장소의 index·HEAD·설정·packed refs와 전체 Native ref 목록을 측정 구간 밖에서 검증한다. */
async function footprint(root: string, gitDir: string, commonDir: string) {
  return { files: await Promise.all([path.join(gitDir, "index"), path.join(gitDir, "HEAD"), path.join(commonDir, "config"),
    path.join(gitDir, "config.worktree"), path.join(commonDir, "packed-refs")].map(marker)),
    refs: digest(await runGit(["for-each-ref", "--format=%(refname) %(objectname)"], root)) };
}

/** 저장소를 바꾸지 않고 같은 입력의 시간·CPU·메모리를 별도 실행에서 비교한다. */
async function main() {
  const root = process.env.GSC_BENCH_CATALOG_ROOT;
  assert.ok(root && path.isAbsolute(root), "An explicit read-only repository is required");
  const count = Number(process.env.GSC_BENCH_CATALOG_CONSUMERS || 4), rounds = 3;
  assert.ok([1, 4, 32].includes(count));
  const kind = process.env.GSC_BENCH_CATALOG_KIND || "latency";
  assert.ok(["latency", "cpu", "memory"].includes(kind));
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-catalog-probe-"));
  try {
  const gitDir = (await runGit(["rev-parse", "--absolute-git-dir"], root)).trim();
  const commonDir = (await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], root)).trim();
  const original = await footprint(root, gitDir, commonDir);
  const raw = await runGit(["for-each-ref", `--format=%(objectname)${FS}%(refname:short)${FS}%(refname)`, "refs/remotes"], root);
  const expected = raw.split("\n").filter(Boolean).map(line => line.split(FS)).filter(fields =>
    fields[0] && fields[1] && fields[2]?.startsWith("refs/remotes/") && !fields[1].endsWith("/HEAD"))
    .map(([hash, name, fullRef]) => ({ hash, name, fullRef, kind: "remote" }));
  const counters = kind === "cpu" ? await loadChildResourceProbe(directory) : undefined;
  let measuring = false, calls: string[] = [], active = 0, maxAwaiting = 0;
  const runner = async (args: string[], repoRoot: string, options?: { signal?: AbortSignal }) => {
    if (measuring) { calls.push(args[0]); active++; maxAwaiting = Math.max(maxAwaiting, active); }
    try { return await runGit(args, repoRoot, options); }
    finally { if (measuring) active--; }
  };
  const samples = [];
    for (let round = 0; round < rounds; round++) {
      assert.deepEqual(await footprint(root, gitDir, commonDir), original);
      const catalog = new GraphBranchCatalog(runner);
      const memory = kind === "memory" ? await PhaseMemorySampler.start([]) : undefined;
      const childBefore = counters?.(), nodeBefore = process.cpuUsage(), started = performance.now();
      calls = []; active = 0; maxAwaiting = 0; measuring = true;
      let memoryResult: Awaited<ReturnType<PhaseMemorySampler["stop"]>> | undefined;
      let settled;
      let elapsedMs: number, nodeUsed: NodeJS.CpuUsage, childAfter: ReturnType<NonNullable<typeof counters>> | undefined;
      try {
        settled = await Promise.allSettled(Array.from({ length: count }, () => catalog.getRemoteTips(root, undefined, `round-${round}`)));
        elapsedMs = performance.now() - started; nodeUsed = process.cpuUsage(nodeBefore); childAfter = counters?.();
      } finally { measuring = false; memoryResult = await memory?.stop(); }
      const values = settled.map(value => { if (value.status === "rejected") throw value.reason; return value.value; });
      const nodeCpuMs = (nodeUsed.user + nodeUsed.system) / 1000;
      const childCpuMs = childBefore && childAfter ? childAfter.userCpuMs + childAfter.systemCpuMs - childBefore.userCpuMs - childBefore.systemCpuMs : undefined;
      for (const value of values) assert.deepEqual(value, expected);
      if (count > 1 && expected.length) { values[0][0].name = "consumer-only"; assert.deepEqual(values[1], expected); }
      assert.equal(active, 0); assert.equal(gitProcesses.isBusy(root), false);
      assert.deepEqual(await footprint(root, gitDir, commonDir), original);
      if (memoryResult) assert.equal(memoryResult.complete, true);
      samples.push({ elapsedMs, ...(kind === "cpu" ? { nodeCpuMs, childCpuMs, ownedCpuMs: nodeCpuMs + childCpuMs! } : {}),
        commonDirectoryCalls: calls.filter(value => value === "rev-parse").length,
        remoteSnapshotCalls: calls.filter(value => value === "for-each-ref").length,
        maxAwaitingGitCalls: maxAwaiting,
        ...(memoryResult ? { memory: memoryResult, observedRssPeakMiB: Math.max(...memoryResult.samples.map(value => value.sumRssBytes)) / 1048576 } : {}),
        nativeExact: true, sourceUnchanged: true });
    }
    const result = { source: JSON.parse(process.env.GSC_BENCH_SOURCE!), kind, consumers: count, rounds,
      remoteRefs: expected.length, protectedFootprint: digest(JSON.stringify(original)), samples,
      scope: "Cold catalog consumers for the same root, warm filesystem. Fresh Native remote refs every round; exact independent results and protected metadata/refs unchanged. Service only, no UI/operation/GitHub latency claim. Latency, CPU and sampled aggregate Node+owned-child RSS use separate processes. maxAwaitingGitCalls counts promises, not observed OS processes. RSS is an observed maximum, not a true peak." };
    await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ kind, consumers: count, samples: samples.map(({ memory, ...value }) => value), source: result.source }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
