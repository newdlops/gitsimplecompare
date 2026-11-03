// optional warmup이 지연된 동안 반복 foreground 상태 읽기를 동일 Native fixture에서 비교한다.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrivateStatusIndex } from "../../src/git/privateStatusIndex";
import { StatusIndexWarmup } from "../../src/git/statusIndexWarmup";
import { runGit, runGitWithInput } from "../../src/git/gitExec";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { parseWorkingTreeV2, workingTreeSnapshot, type WorkingTreeSnapshot } from "../../src/git/workingTreeStatusFormat";

/** 경로 순서만 정규화하고 Git이 판단한 stage·상태·rename 의미를 보존한다. */
function normalized(value: WorkingTreeSnapshot) {
  const sort = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  return { head: value.head, staged: [...value.groups.staged].sort(sort), unstaged: [...value.groups.unstaged].sort(sort) };
}

/** 읽기 전후 byte·inode·시각을 대조해 사용자 index에 쓰기가 없었는지 증명한다. */
async function identity(file: string) {
  const info = await stat(file);
  return { bytes: await readFile(file), ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs };
}

/** fixture 준비와 독립 Native oracle은 시간·Git 실행 수 측정 밖에서 수행한다. */
async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-repeat-cold-benchmark-")), root = path.join(directory, "repo");
  await mkdir(root);
  const events: string[] = [], index = new PrivateStatusIndex(root, event => events.push(event));
  const schedule = StatusIndexWarmup.prototype.schedule;
  // 선택적인 준비가 계속 지연되는 조건만 고정한다. foreground Git 명령·결과·timeout은 변경하지 않는다.
  StatusIndexWarmup.prototype.schedule = () => undefined;
  try {
    await runGit(["init", "-q", "-b", "main"], root);
    await runGit(["config", "core.fsmonitor", "false"], root);
    await runGit(["config", "core.untrackedCache", "false"], root);
    const files = 6000, directories = 300;
    const changes = Array.from({ length: files }, (_, i) => `M 100644 :1 src/d${i % directories}/file${i}.txt`);
    await runGitWithInput(["fast-import", "--quiet"], root,
      `blob\nmark :1\ndata 5\nbase\n\ncommit refs/heads/main\ncommitter Benchmark <benchmark@example.invalid> 1700000000 +0000\ndata 4\nbase\n${changes.join("\n")}\n\ndone\n`);
    await runGit(["read-tree", "--reset", "-u", "main"], root);
    const source = path.join(root, ".git/index"), before = await identity(source), samples = [];
    for (let round = 0; round < 4; round++) {
      await writeFile(path.join(root, "src/d0/file0.txt"), `edit ${round}\n`);
      await writeFile(path.join(root, `untracked-${round}.txt`), `new ${round}\n`);
      const timings: GitExecutionTiming[] = [], stop = setGitExecutionObserver(value => timings.push(value));
      const cpu = process.cpuUsage(), started = performance.now(); let actual!: WorkingTreeSnapshot;
      try { actual = await index.read(AbortSignal.timeout(60000)); } finally { stop(); }
      const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu);
      const expected = workingTreeSnapshot(root, parseWorkingTreeV2(await runGit([
        "status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=all",
      ], root, { env: { GIT_OPTIONAL_LOCKS: "0" } })));
      assert.deepEqual(normalized(actual), normalized(expected)); assert.deepEqual(await identity(source), before);
      samples.push({ round, elapsedMs, nodeCpuMs: (used.user + used.system) / 1000, gitCalls: timings.length,
        commands: timings.map(value => value.command), nativeExact: true, sourceIndexPreserved: true });
    }
    const report = { source: JSON.parse(process.env.GSC_BENCH_SOURCE!), fixture: { files, directories }, samples,
      coldScans: events.filter(event => event === "private status cold scan completed").length,
      scope: "Native foreground reads with optional warmup kept unavailable. No stale result reuse; every read compared to independent Git status and source index identity. Existing host load uncontrolled. Not active VS Code latency or GitHub network." };
    await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ coldScans: report.coldScans, samples }));
  } finally {
    StatusIndexWarmup.prototype.schedule = schedule;
    await index.dispose(); await gitProcesses.dispose(); await rm(directory, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
