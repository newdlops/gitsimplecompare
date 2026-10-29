// 실제 계획 생성의 시간과 Native 호출을 읽기 전용으로 측정하고 마지막에는 같은 계획을 실행한다.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { RebaseService, type RebasePlanInfo } from "../../src/git/rebaseService";
import { runGit, runGitWithInput } from "../../src/git/gitExec";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { disposeWorkingTreeSnapshots } from "../../src/git/workingTreeSnapshot";

export interface Scenario { name: string; commits: number; upstream: boolean; outside: boolean }
interface Fixture {
  root: string; base: string; head: string; target: string; hashes: string[]; scenario: Scenario;
  tree: string; targetTree: string; index: Buffer; config: Buffer;
}

/** 같은 1천 파일·1천 공통 커밋 뒤에 독립 변경을 fast-import하고 준비 비용을 측정에서 제외한다. */
export async function fixture(directory: string, scenario: Scenario): Promise<Fixture> {
  const root = path.join(directory, scenario.name), marksFile = path.join(directory, `${scenario.name}.marks`);
  await mkdir(root); await runGit(["-c", "init.templateDir=", "init", "-qb", "main"], root);
  for (const [key, value] of Object.entries({ "user.name": "Rebase Plan Benchmark", "user.email": "plan@example.invalid",
    "core.hooksPath": "/dev/null", "core.fsmonitor": "false", "core.autocrlf": "false", "commit.gpgSign": "false" })) {
    await runGit(["config", key, value], root);
  }
  let mark = 1;
  const data = ["blob", "mark :1", "data 5", "base\n"];
  /** 각 commit의 부모·내용·메시지를 고정해 source별 plan과 Native 결과를 비교한다. */
  const commit = (ref: string, parent: number | undefined, subject: string, changes: string[]) => {
    const id = ++mark;
    data.push(`commit refs/heads/${ref}`, `mark :${id}`, "committer Plan <plan@example.invalid> 1700000000 +0000",
      `data ${Buffer.byteLength(subject)}`, subject, ...(parent ? [`from :${parent}`] : []), ...changes, "");
    return id;
  };
  let base = commit("main", undefined, "root", Array.from({ length: 1000 }, (_, i) => `M 100644 :1 file-${i}.txt`));
  for (let i = 1; i < 1000; i++) base = commit("main", base, `base ${i}`, []);
  const target = commit("target", base, "target", ["M 100644 :1 target.txt"]);
  let head = base;
  const hashes: number[] = [];
  for (let i = 0; i < scenario.commits; i++) {
    head = commit("topic", head, `topic ${i}`, [`M 100644 :1 topic-${i}.txt`]); hashes.push(head);
  }
  await runGitWithInput(["fast-import", "--quiet", `--export-marks=${marksFile}`], root, data.join("\n") + "\n");
  const ids = new Map((await readFile(marksFile, "utf8")).trim().split("\n").map(line => {
    const [id, oid] = line.split(" "); return [Number(id.slice(1)), oid];
  }));
  await runGit(["reset", "--hard", "main"], root);
  await runGit(["switch", "-q", "topic"], root);
  if (scenario.upstream) await runGit(["branch", "--set-upstream-to=main", "topic"], root);
  return { root, base: ids.get(base)!, head: ids.get(head)!, target: ids.get(target)!, hashes: hashes.map(id => ids.get(id)!), scenario,
    tree: (await runGit(["rev-parse", "HEAD^{tree}"], root)).trim(),
    targetTree: (await runGit(["merge-tree", "--write-tree", ids.get(head)!, ids.get(target)!], root)).trim(),
    index: await readFile(path.join(root, ".git/index")), config: await readFile(path.join(root, ".git/config")) };
}

/** 전체 계획과 파일 정보를 측정하고 원래 ref·index·config 및 고정된 fixture 내용과 대조한다. */
export async function measure(f: Fixture) {
  const calls: GitExecutionTiming[] = [], stop = setGitExecutionObserver(row => calls.push(row));
  const start = performance.now(), cpu = process.cpuUsage();
  let plan: RebasePlanInfo;
  try {
    plan = await new RebaseService(f.root).prepareCurrentBranchPlan(f.scenario.upstream ? undefined : f.hashes[0],
      f.scenario.outside ? f.target : f.head);
  } finally { stop(); }
  const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
  assert.equal(plan.branch, "topic"); assert.equal(plan.base, f.base); assert.equal(plan.root, false);
  assert.equal(plan.baseReason, f.scenario.upstream ? "upstream" : "selected");
  assert.equal(plan.onto, f.scenario.outside ? f.target : undefined); assert.equal(plan.checkout?.head, f.head);
  assert.deepEqual(plan.commits.map(commit => commit.hash), f.hashes);
  for (const [index, commit] of plan.commits.entries()) {
    assert.equal(commit.subject, `topic ${index}`); assert.equal(commit.body, "");
    assert.deepEqual(commit.files, [{ status: "A", path: `topic-${index}.txt`, oldPath: undefined, additions: 1, deletions: 0 }]);
  }
  assert.equal((await runGit(["rev-parse", "HEAD"], f.root)).trim(), f.head);
  assert.deepEqual(await readFile(path.join(f.root, ".git/index")), f.index);
  assert.deepEqual(await readFile(path.join(f.root, ".git/config")), f.config);
  return { plan, metrics: { elapsedMs, gitCalls: calls.length, nodeCpuMs: (used.user + used.system) / 1000,
    commands: calls.map(row => ({ command: row.command, elapsedMs: row.elapsedMs })), nativePlanVerified: true } };
}

/**
 * 측정 뒤 각 source의 실제 Start로 계획을 실행한다. 파일 tree·부모·순서와 clean 상태를 확인한다.
 * @param f 소유 fixture @param plan 같은 source가 반환한 계획 @param editorScript 실제 번들 helper 경로
 * @returns 측정에 포함하지 않은 Native 재작성 검증 결과
 */
export async function verifyExecution(f: Fixture, plan: RebasePlanInfo, editorScript: string) {
  await runGit(["reset", "--hard", f.head], f.root);
  const items = (f.scenario.outside ? plan.commits : [...plan.commits].reverse()).map(commit => ({ hash: commit.hash, action: "pick" as const }));
  const result = await new RebaseService(f.root, { nativeEditors: true }).start(plan.base, false, items, editorScript, plan.onto, plan.checkout);
  assert.equal(result.status, "completed", result.message);
  assert.equal((await runGit(["rev-parse", "HEAD^{tree}"], f.root)).trim(), f.scenario.outside ? f.targetTree : f.tree);
  const subjects = (await runGit(["log", "--reverse", "--format=%s", `${plan.onto || f.base}..HEAD`], f.root)).trim().split("\n");
  assert.deepEqual(subjects, items.map(item => plan.commits.find(commit => commit.hash === item.hash)!.subject));
  const oldest = (await runGit(["rev-list", "--reverse", `${plan.onto || f.base}..HEAD`], f.root)).trim().split("\n")[0];
  assert.equal((await runGit(["rev-parse", `${oldest}^`], f.root)).trim(), plan.onto || f.base);
  assert.equal(await runGit(["status", "--porcelain=v1"], f.root), "");
  return { nativeTreeMatches: true, parentAndOrderMatch: true, cleanWorkingTree: true };
}

/** 소유 fixture 삭제 전에 각 번들의 감시자와 Native 자식 수명을 정리한다. */
export async function dispose(): Promise<void> { await disposeWorkingTreeSnapshots(); await gitProcesses.dispose(); }
