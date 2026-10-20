// 실제 Git ref와 Undo JSON 기록까지 포함한 PR snapshot 비용을 격리해 측정한다.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runGit } from "../../src/git/gitExec";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { setOwnedFsmonitorPolicy } from "../../src/git/ownedFsmonitor";
import { PullRequestOperationSnapshot } from "../../src/git/pullRequestOperationSnapshot";
import { snapshotRefForBranch, snapshotRefForCommand } from "../../src/git/pullRequestOperationFormat";

/** 표본을 변경하지 않고 중앙값을 반환해 드문 프로세스 시작 지연의 영향을 구분한다. */
function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** fixture index가 없으면 undefined를 반환하되 권한·기타 I/O 실패를 보존 검사 성공으로 숨기지 않는다. */
async function readIndex(file: string): Promise<Buffer | undefined> {
  try { return await readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** 사용자 저장소·원격·인덱스를 수정하지 않고 실제 snapshot 기록과 포인터 보존을 반복 검증한다. */
async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-pr-snapshot-benchmark-"));
  let stopMonitor: (() => void) | undefined;
  const git = async (...args: string[]) => (await runGit(args, root)).trim();
  try {
    await mkdir(path.join(root, "hooks"));
    await git("-c", "init.templateDir=", "init", "-q", "--initial-branch=main");
    await git("config", "core.fsmonitor", "false");
    await git("config", "core.hooksPath", path.join(root, "hooks"));
    await git("-c", "user.name=Snapshot Fixture", "-c", "user.email=snapshot@example.invalid", "-c", "commit.gpgSign=false",
      "commit", "--allow-empty", "-qm", "base");
    assert.equal(await git("config", "--bool", "--get", "core.fsmonitor"), "false");
    const head = await git("rev-parse", "HEAD"), indexPath = path.join(root, ".git/index");
    const indexBefore = await readIndex(indexPath);
    const monitorEvents: { event: string; reason?: string }[] = [];
    stopMonitor = setOwnedFsmonitorPolicy((event, details) => monitorEvents.push({ event,
      ...(typeof details?.reason === "string" ? { reason: details.reason } : {}) }));
    const state = new PullRequestOperationSnapshot(root), count = Number(process.env.GSC_BENCH_SAMPLES || 5);
    assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 20);
    type Timing = Pick<GitExecutionTiming, "command" | "elapsedMs" | "outcome" | "code">;
    const snapshots: string[] = [], samples: { elapsedMs: number; nodeCpuMs: number; commands: string[]; timings: Timing[] }[] = [];
    for (let index = -1; index < count; index++) {
      const commands: string[] = [], timings: Timing[] = [];
      const unobserve = setGitExecutionObserver(({ command, elapsedMs, outcome, code }) => {
        commands.push(command); timings.push({ command, elapsedMs, outcome, ...(code === undefined ? {} : { code }) });
      });
      const started = performance.now(), cpu = process.cpuUsage();
      let snapshot: string;
      try { snapshot = await state.createSnapshot("main", head, "squash"); }
      finally { unobserve(); }
      const used = process.cpuUsage(cpu);
      if (index >= 0) samples.push({ elapsedMs: performance.now() - started, nodeCpuMs: (used.user + used.system) / 1000, commands, timings });
      snapshots.push(snapshot);
      // 검증용 조회는 계측 밖에서 실행한다. 모든 이전 immutable ref도 마지막에 다시 확인한다.
      assert.equal(await git("symbolic-ref", snapshotRefForBranch("main")), snapshot);
      assert.equal(await git("symbolic-ref", snapshotRefForCommand("main", "squash")), snapshot);
    }
    for (const snapshot of snapshots) assert.equal(await git("rev-parse", snapshot), head);
    assert.equal(new Set(snapshots).size, snapshots.length);
    assert.equal(await git("rev-parse", "HEAD"), head);
    assert.deepEqual(await readIndex(indexPath), indexBefore);
    const result = { version: JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")).version,
      source: process.env.GSC_BENCH_SOURCE ? JSON.parse(process.env.GSC_BENCH_SOURCE) : undefined,
      fixture: { monitorPolicy: true, fsmonitor: false, warmup: 1, samples: count, network: "none" }, samples, monitorEvents,
      median: { elapsedMs: median(samples.map(sample => sample.elapsedMs)), nodeCpuMs: median(samples.map(sample => sample.nodeCpuMs)),
        processes: median(samples.map(sample => sample.commands.length)) }, recoveryRefsPreserved: true, headAndIndexUnchanged: true };
    if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } finally { stopMonitor?.(); await gitProcesses.dispose(); await rm(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
