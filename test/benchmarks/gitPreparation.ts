import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runGit } from "../../src/git/gitExec";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { getCurrentPushPlan } from "../../src/git/pushService";
import { PrivateStatusIndex } from "../../src/git/privateStatusIndex";
import { parseWorkingTreeV2, workingTreeSnapshot, type WorkingTreeSnapshot } from "../../src/git/workingTreeStatusFormat";
import { gitProcesses } from "../../src/git/gitProcessRegistry";

/** 홀수 표본의 중앙값. 원본을 정렬·수정하지 않아 개별 표본도 결과에 보존한다. */
function median(values: number[]): number { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]; }

/** Native 전체 status와 의미만 비교하고 untracked 열거 순서는 정규화한다. */
function normalized(value: WorkingTreeSnapshot) {
  const sort = (items: typeof value.groups.staged) => [...items].sort((a, b) => a.path.localeCompare(b.path));
  return { head: value.head, branch: value.branch, upstream: value.upstream,
    staged: sort(value.groups.staged), unstaged: sort(value.groups.unstaged) };
}

/** 실제 완료한 Git 수·명령과 호출 Node의 CPU만 기록하며 비교 기준 Git 조회는 구간 밖에서 실행한다. */
async function sample(action: () => Promise<unknown>) {
  const calls: GitExecutionTiming[] = [], stop = setGitExecutionObserver(value => calls.push(value));
  const cpu = process.cpuUsage(), started = performance.now();
  try { await action(); }
  finally { stop(); }
  const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu), commands: Record<string, number> = {};
  assert.ok(calls.every(call => call.outcome === "success"));
  for (const call of calls) commands[call.command] = (commands[call.command] ?? 0) + 1;
  return { elapsedMs, nodeCpuMs: (used.user + used.system) / 1000, processes: calls.length, commands };
}

/** 파일 1천 개와 작은 outgoing commit 한 개의 일반 upstream 저장소를 로컬 bare 원격으로 구성한다. */
async function fixture(directory: string) {
  const root = path.join(directory, "repository"), remote = path.join(directory, "remote.git"); await mkdir(root);
  await runGit(["-c", "init.templateDir=", "init", "-q", "--initial-branch=main"], root);
  await mkdir(path.join(directory, "hooks"));
  for (const [key, value] of Object.entries({ "user.name": "Preparation Fixture", "user.email": "preparation@example.invalid",
    "core.hooksPath": path.join(directory, "hooks"), "core.fsmonitor": "false", "commit.gpgsign": "false", "push.default": "simple" })) {
    await runGit(["config", key, value], root);
  }
  for (let index = 0; index < 1000; index++) await writeFile(path.join(root, `file-${index}.txt`), `base ${index}\n`);
  await runGit(["add", "."], root); await runGit(["commit", "-qm", "base"], root);
  const base = (await runGit(["rev-parse", "HEAD"], root)).trim();
  await runGit(["-c", "init.templateDir=", "init", "-q", "--bare", remote], directory);
  await runGit(["remote", "add", "origin", remote], root); await runGit(["push", "-qu", "origin", "main"], root);
  await writeFile(path.join(root, "file-0.txt"), "outgoing\n"); await runGit(["add", "."], root);
  await runGit(["commit", "-qm", "outgoing"], root);
  return { root, base, head: (await runGit(["rev-parse", "HEAD"], root)).trim() };
}

/** 준비 조회만 1회 워밍업·5회 측정하고 매 status의 새 변경·staging 및 원본 index 보존을 확인한다. */
async function main(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-preparation-benchmark-")); let index: PrivateStatusIndex | undefined;
  try {
    const f = await fixture(directory), plans = [], statuses = [];
    for (let round = -1; round < 5; round++) {
      const value = await sample(async () => {
        const plan = await getCurrentPushPlan(f.root);
        assert.equal(plan.mode, "plain"); assert.equal(plan.branch, "main"); assert.equal(plan.upstream, "origin/main");
        assert.equal(plan.snapshot.head, f.head); assert.equal(plan.snapshot.remoteHead, f.base);
        assert.equal(plan.snapshot.targetRef, "refs/heads/main");
      });
      if (round >= 0) plans.push(value);
    }
    index = new PrivateStatusIndex(f.root, () => undefined);
    for (let round = -1; round < 5; round++) {
      await writeFile(path.join(f.root, "file-1.txt"), `round ${round}\n`);
      if (round % 2 === 0) await runGit(["add", "file-1.txt"], f.root);
      const before = await readFile(path.join(f.root, ".git/index"));
      const expected = workingTreeSnapshot(f.root, parseWorkingTreeV2(await runGit([
        "status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=all",
      ], f.root, { env: { GIT_OPTIONAL_LOCKS: "0" } })));
      const value = await sample(async () => assert.deepEqual(normalized(await index!.read(new AbortController().signal)), normalized(expected)));
      assert.deepEqual(await readFile(path.join(f.root, ".git/index")), before);
      if (round >= 0) statuses.push(value);
    }
    const summarize = (samples: typeof plans) => ({ samples, median: { elapsedMs: median(samples.map(s => s.elapsedMs)),
      nodeCpuMs: median(samples.map(s => s.nodeCpuMs)), processes: median(samples.map(s => s.processes)) } });
    const result = { version: JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")).version,
      source: process.env.GSC_BENCH_SOURCE ? JSON.parse(process.env.GSC_BENCH_SOURCE) : undefined,
      fixture: { files: 1000, outgoingCommits: 1, network: "local-bare-only", fsmonitor: false, warmup: 1, samples: 5 },
      pushPlanning: summarize(plans), repeatedStatus: summarize(statuses), statusExact: true, originalIndexPreserved: true };
    if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } finally { await index?.dispose(); await gitProcesses.dispose(); await rm(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
