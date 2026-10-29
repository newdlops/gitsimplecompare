// 격리 저장소에서 Native tree·부모·로컬 파일을 검증하고 브랜치 작업 구간만 계측한다.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { BranchOperationService } from "../../src/git/branchOperationService";
import { runGit, runGitWithInput } from "../../src/git/gitExec";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { disposeWorkingTreeSnapshots } from "../../src/git/workingTreeSnapshot";

interface Scenario { name: string; files: number; dirty: boolean; operation: "squash" | "rebase" }
const scenarios: Scenario[] = [
  { name: "small-dirty-squash", files: 100, dirty: true, operation: "squash" },
  { name: "large-dirty-squash", files: 10000, dirty: true, operation: "squash" },
  { name: "large-clean-squash", files: 10000, dirty: false, operation: "squash" },
  { name: "large-dirty-rebase", files: 10000, dirty: true, operation: "rebase" },
];

/** fast-import와 실제 checkout으로 동일한 파일·분기를 만들며 준비 시간은 표본에 넣지 않는다. */
async function fixture(directory: string, scenario: Scenario, round: number) {
  const root = path.join(directory, `${scenario.name}-${round}`); await mkdir(root);
  await runGit(["-c", "init.templateDir=", "init", "-q", "--initial-branch=main"], root);
  for (const [key, value] of Object.entries({ "user.name": "Branch Benchmark", "user.email": "branch@example.invalid",
    "core.hooksPath": "/dev/null", "core.fsmonitor": "false", "core.autocrlf": "false", "commit.gpgSign": "false" })) {
    await runGit(["config", key, value], root);
  }
  const lines = ["blob", "mark :1", "data 5", "base\n", "commit refs/heads/main", "mark :2",
    "committer Branch Benchmark <branch@example.invalid> 1700000000 +0000", "data 4", "base",
    ...Array.from({ length: scenario.files }, (_, i) => `M 100644 :1 file-${String(i).padStart(5, "0")}.txt`), "M 100644 :1 user.txt", ""];
  await runGitWithInput(["fast-import", "--quiet"], root, lines.join("\n") + "\n");
  await runGit(["reset", "--hard", "main"], root);
  await runGit(["switch", "-qc", "source"], root);
  for (const i of [0, 1, 2]) await writeFile(path.join(root, `file-${String(i).padStart(5, "0")}.txt`), `source ${i}\n`);
  await runGit(["add", "."], root); await runGit(["commit", "-qm", "source"], root);
  const source = (await runGit(["rev-parse", "HEAD"], root)).trim();
  await runGit(["switch", "-q", "main"], root);
  await writeFile(path.join(root, "destination.txt"), "destination\n");
  await runGit(["add", "."], root); await runGit(["commit", "-qm", "destination"], root);
  const before = (await runGit(["rev-parse", "HEAD"], root)).trim();
  const tree = (await runGit(["merge-tree", "--write-tree", before, source], root)).trim();
  if (scenario.dirty) {
    await writeFile(path.join(root, "user.txt"), "local unstaged work\n");
    await writeFile(path.join(root, "untracked.txt"), "local untracked work\n");
  }
  return { root, before, source, tree, config: await readFile(path.join(root, ".git/config")) };
}

/** 1개 파일 존재 검사만 동일 경계에 넣어 전체 checkout 생략 여부를 기록한다. */
function observeCheckout(service: BranchOperationService): () => boolean | undefined {
  const runtime = service as unknown as { commitSquash: (...args: [string, string, string, boolean?]) => Promise<void> };
  const commit = runtime.commitSquash.bind(service);
  let materialized: boolean | undefined;
  runtime.commitSquash = async (...args) => {
    materialized = await access(path.join(args[2], "file-00099.txt")).then(() => true, () => false);
    return commit(...args);
  };
  return () => materialized;
}

/** 작업 완료 뒤 별도 Native 조회로 결과와 사용자 내용을 검증하며 이 시간은 계측에서 제외한다. */
async function sample(directory: string, scenario: Scenario, round: number) {
  return measureFixture(await fixture(directory, scenario, round), scenario);
}

/** 같은 fixture에서 source ref/OID 입력만 비교할 때도 동일한 계측·Native 사후 검증을 사용한다. */
async function measureFixture(f: Awaited<ReturnType<typeof fixture>>, scenario: Scenario, symbolicSource = false) {
  const service = new BranchOperationService(f.root);
  if (symbolicSource) {
    // 격리된 control에서만 이전 Native 인자를 재현한다. 실제 target 존재 검사는 그대로 수행한다.
    const runtime = service as unknown as { assertSourceBranch: (name: string) => Promise<string> };
    const resolve = runtime.assertSourceBranch.bind(service);
    runtime.assertSourceBranch = async name => { await resolve(name); return name; };
  }
  const checkout = observeCheckout(service), timings: GitExecutionTiming[] = [];
  const stop = setGitExecutionObserver(row => timings.push(row)), cpu = process.cpuUsage(), started = performance.now();
  let result: Awaited<ReturnType<BranchOperationService["squashMerge"]>>;
  try { result = await (scenario.operation === "rebase" ? service.rebaseMerge("source") : service.squashMerge("source")); }
  finally { stop(); }
  const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu);
  assert.equal(result.status, "completed");
  assert.equal((await runGit(["rev-parse", "HEAD^{tree}"], f.root)).trim(), f.tree);
  assert.equal((await runGit(["rev-parse", "HEAD"], f.root)).trim(), result.afterHead);
  if (scenario.operation === "squash") assert.equal((await runGit(["log", "-1", "--format=%P"], f.root)).trim(), f.before);
  else await runGit(["merge-base", "--is-ancestor", f.source, "HEAD"], f.root);
  assert.equal((await runGit(["show", "HEAD:user.txt"], f.root)).trim(), "base");
  assert.equal(await readFile(path.join(f.root, "user.txt"), "utf8"), scenario.dirty ? "local unstaged work\n" : "base\n");
  if (scenario.dirty) assert.equal(await readFile(path.join(f.root, "untracked.txt"), "utf8"), "local untracked work\n");
  assert.equal(await runGit(["diff", "--cached", "--name-only"], f.root), "");
  assert.equal(await runGit(["stash", "list"], f.root), "");
  assert.deepEqual(await readFile(path.join(f.root, ".git/config")), f.config);
  assert.equal((await runGit(["worktree", "list", "--porcelain"], f.root)).split("\n").filter(line => line.startsWith("worktree ")).length, 1);
  const commands = Object.fromEntries([...new Set(timings.map(row => row.command))].sort().map(command =>
    [command, { count: timings.filter(row => row.command === command).length,
      elapsedMs: timings.filter(row => row.command === command).reduce((sum, row) => sum + row.elapsedMs, 0) }]));
  return { elapsedMs, nodeCpuMs: (used.user + used.system) / 1000, gitCalls: timings.length, commands,
    unchangedFileMaterializedAtCommit: checkout(), nativeTreeMatches: true, localChangesPreserved: true };
}

/**
 * clean 경로의 유일한 Native 인자 변경을 한 저장소에서 ABBA 순서로 분리 측정한다.
 * 제품 source는 같고 ref를 다시 전달하는 control만 테스트 내부에서 주입한다. 이전 버전 전체 비교는 아니다.
 */
async function compareCleanInputs(directory: string) {
  const scenario = scenarios.find(value => value.name === "large-clean-squash")!, f = await fixture(directory, scenario, 0);
  for (const symbolic of [true, false]) {
    await runGit(["reset", "--hard", f.before], f.root); await measureFixture(f, scenario, symbolic);
  }
  const samples = [];
  for (const symbolic of [true, false, false, true, true, false, false, true, true, false, false, true]) {
    await runGit(["reset", "--hard", f.before], f.root);
    samples.push({ input: symbolic ? "symbolic-control" : "fixed-oid", ...await measureFixture(f, scenario, symbolic) });
  }
  return { kind: "same-source-clean-input-control", source: JSON.parse(process.env.GSC_BENCH_SOURCE || "null"),
    fixture: scenario, warmupPerInput: 1, order: "ABBA repeated three times; A=symbolic-control, B=fixed-oid", samples,
    medians: Object.fromEntries(["symbolic-control", "fixed-oid"].map(input => {
      const rows = samples.filter(value => value.input === input);
      return [input, { elapsedMs: median(rows.map(value => value.elapsedMs)), nodeCpuMs: median(rows.map(value => value.nodeCpuMs)),
        gitCalls: median(rows.map(value => value.gitCalls)) }];
    })) };
}

/** 정렬된 복사본에서 중앙값을 구한다. 짝수 표본인 입력 control은 가운데 두 값 중 큰 값을 사용한다. */
function median(values: number[]): number { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]; }

/** 읽은 사용자 저장소나 외부 서버 없이 소유한 임시 fixture만 실행하고 모든 자식을 회수한다. */
async function main(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-branch-squash-benchmark-"));
  try {
    if (process.env.GSC_BENCH_INPUT_CONTROL === "1") {
      const result = await compareCleanInputs(directory);
      if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
      console.log(JSON.stringify(result.medians)); return;
    }
    const results = [];
    for (const scenario of scenarios) {
      await sample(directory, scenario, -1);
      const samples = [];
      for (let round = 0; round < 3; round++) samples.push(await sample(directory, scenario, round));
      results.push({ ...scenario, samples, median: { elapsedMs: median(samples.map(row => row.elapsedMs)),
        nodeCpuMs: median(samples.map(row => row.nodeCpuMs)), gitCalls: median(samples.map(row => row.gitCalls)) } });
      console.log(JSON.stringify({ scenario: scenario.name, median: results.at(-1)!.median }));
    }
    const result = { source: JSON.parse(process.env.GSC_BENCH_SOURCE || "null"), warmup: 1, samples: 3,
      scope: "Native branch service completion; fixture preparation and final verification excluded; Node CPU excludes Git/OS CPU", results };
    if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
  } finally { await disposeWorkingTreeSnapshots(); await gitProcesses.dispose(); await rm(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
