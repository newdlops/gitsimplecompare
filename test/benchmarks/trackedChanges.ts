// 변경 유무 조회의 실제 Native 비용을 같은 fixture·index로 반복 측정한다.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { PullRequestOperationSnapshot } from "../../src/git/pullRequestOperationSnapshot";
import { runGit, runGitWithInput } from "../../src/git/gitExec";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { setOwnedFsmonitorPolicy } from "../../src/git/ownedFsmonitor";

/** 새 임시 저장소만 생성하고 동일 blob의 tracked 파일 1,000개를 Git으로 checkout한다. */
async function fixture(directory: string): Promise<string> {
  const root = path.join(directory, "repository"); await mkdir(root);
  await runGit(["-c", "init.templateDir=", "init", "-q", "--initial-branch=main"], root);
  await runGit(["config", "core.fsmonitor", "false"], root);
  const rows = ["blob", "mark :1", "data 5", "base\n", "commit refs/heads/main", "mark :2",
    "committer Tracked Fixture <fixture@example.invalid> 1700000000 +0000", "data 4", "base",
    ...Array.from({ length: 1000 }, (_, index) => `M 100644 :1 tracked-${index}.txt`), ""];
  await runGitWithInput(["fast-import", "--quiet"], root, rows.join("\n") + "\n");
  await runGit(["reset", "--hard", "main"], root); return root;
}

/** 표본을 그대로 보존하면서 홀수 개 값의 중앙값을 계산한다. */
function median(values: number[]): number { return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]; }

/** 한 index snapshot의 워밍업 1회·측정 5회를 서로 겹치지 않고 실행한다. */
async function measure(root: string, mode: string) {
  await runGit(["reset", "--hard", "HEAD"], root);
  if (mode !== "clean") await writeFile(path.join(root, "tracked-0.txt"), "changed\n");
  if (mode === "staged" || mode === "cancelling") await runGit(["add", "tracked-0.txt"], root);
  if (mode === "cancelling") await writeFile(path.join(root, "tracked-0.txt"), "base\n");
  const expected = Boolean(await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=no"], root));
  const index = await readFile(path.join(root, ".git/index")), state = new PullRequestOperationSnapshot(root), samples = [];
  for (let round = -1; round < 5; round++) {
    const timings: GitExecutionTiming[] = [], stop = setGitExecutionObserver(value => timings.push(value));
    const cpu = process.cpuUsage(), started = performance.now(); let actual: boolean;
    try { actual = await state.hasPendingChanges(); } finally { stop(); }
    const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu);
    assert.equal(actual, expected); assert.deepEqual(await readFile(path.join(root, ".git/index")), index);
    if (round >= 0) samples.push({ elapsedMs, nodeCpuMs: (used.user + used.system) / 1000, processes: timings.length,
      diffProcesses: timings.filter(value => value.command === "diff").length,
      monitorPreparationProcesses: timings.filter(value => value.command !== "diff").length });
  }
  return { mode, exact: true, indexPreserved: true, samples, median: Object.fromEntries(
    ["elapsedMs", "nodeCpuMs", "processes", "diffProcesses", "monitorPreparationProcesses"].map(key =>
      [key, median(samples.map(sample => sample[key as keyof typeof sample]))])) };
}

/** 사용자 저장소·네트워크를 받지 않고 public PR API의 반복 결과만 기록한다. */
async function main(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-tracked-changes-benchmark-"));
  let stopPolicy: (() => void) | undefined;
  try {
    const root = await fixture(directory);
    if (process.env.GSC_BENCH_MONITOR_POLICY === "1") stopPolicy = setOwnedFsmonitorPolicy(() => undefined);
    const results = [];
    for (const mode of ["staged", "unstaged", "clean", "cancelling"]) results.push(await measure(root, mode));
    const result = { source: process.env.GSC_BENCH_SOURCE ? JSON.parse(process.env.GSC_BENCH_SOURCE) : undefined,
      fixture: { files: 1000, monitorPolicy: !!stopPolicy }, warmup: 1, samples: 5, results };
    if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } finally { stopPolicy?.(); await gitProcesses.dispose(); await rm(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
