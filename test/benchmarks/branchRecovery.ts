// 실제 브랜치 서비스와 Undo의 비용을 분리하고 모든 측정 뒤 Native Git 결과를 검증한다.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { BranchOperationService } from "../../src/git/branchOperationService";
import { runGit, runGitWithInput } from "../../src/git/gitExec";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { disposeWorkingTreeSnapshots } from "../../src/git/workingTreeSnapshot";

export interface Scenario { name: string; files: number; dirty: boolean; operation: "squash" | "rebase" }
interface Fixture { root: string; head: string; source: string; tree: string; config: Buffer; scenario: Scenario }

/** 준비 비용은 제외하고 동일한 부모/내용을 가진 분기와 로컬 편집을 만든다. */
export async function fixture(directory: string, scenario: Scenario): Promise<Fixture> {
  const root = path.join(directory, scenario.name); await mkdir(root);
  await runGit(["-c", "init.templateDir=", "init", "-qb", "main"], root);
  for (const [key, value] of Object.entries({ "user.name": "Branch Benchmark", "user.email": "branch@example.invalid",
    "core.hooksPath": "/dev/null", "core.fsmonitor": "false", "core.autocrlf": "false", "commit.gpgSign": "false" })) {
    await runGit(["config", key, value], root);
  }
  const lines = ["blob", "mark :1", "data 5", "base\n", "commit refs/heads/main", "mark :2",
    "committer Branch Benchmark <branch@example.invalid> 1700000000 +0000", "data 4", "base",
    ...Array.from({ length: scenario.files }, (_, i) => `M 100644 :1 file-${i}.txt`), "M 100644 :1 user.txt", ""];
  await runGitWithInput(["fast-import", "--quiet"], root, lines.join("\n") + "\n");
  await runGit(["reset", "--hard", "main"], root); await runGit(["switch", "-qc", "source"], root);
  for (const i of [0, 1, 2]) await writeFile(path.join(root, `file-${i}.txt`), `source ${i}\n`);
  await runGit(["add", "."], root); await runGit(["commit", "-qm", "source"], root);
  const source = (await runGit(["rev-parse", "HEAD"], root)).trim();
  await runGit(["switch", "-q", "main"], root);
  await writeFile(path.join(root, "destination.txt"), "destination\n");
  await runGit(["add", "."], root); await runGit(["commit", "-qm", "destination"], root);
  const head = (await runGit(["rev-parse", "HEAD"], root)).trim();
  const tree = (await runGit(["merge-tree", "--write-tree", head, source], root)).trim();
  if (scenario.dirty) {
    await writeFile(path.join(root, "user.txt"), "local unstaged work\n");
    await writeFile(path.join(root, "untracked.txt"), "local untracked work\n");
  }
  return { root, head, source, tree, config: await readFile(path.join(root, ".git/config")), scenario };
}

/** 서비스 구간만 observer로 감싸고 Git 자식 CPU를 포함하지 않는 Node CPU를 명확히 분리한다. */
async function timed<T>(action: () => Promise<T>) {
  const calls: GitExecutionTiming[] = [], stop = setGitExecutionObserver(row => calls.push(row));
  const cpu = process.cpuUsage(), start = performance.now();
  try {
    const value = await action(), elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
    return { value, metrics: { elapsedMs, gitCalls: calls.length, nodeCpuMs: (used.user + used.system) / 1000,
      commands: calls.map(row => ({ command: row.command, elapsedMs: row.elapsedMs })) } };
  } finally { stop(); }
}

/** 로컬 편집·index·설정·stash·임시 worktree를 측정 바깥에서 검증한다. */
async function verifyLocalState(f: Fixture): Promise<void> {
  assert.equal(await readFile(path.join(f.root, "user.txt"), "utf8"), f.scenario.dirty ? "local unstaged work\n" : "base\n");
  if (f.scenario.dirty) assert.equal(await readFile(path.join(f.root, "untracked.txt"), "utf8"), "local untracked work\n");
  assert.equal(await runGit(["diff", "--cached", "--name-only"], f.root), "");
  assert.equal(await runGit(["stash", "list"], f.root), "");
  assert.equal((await runGit(["symbolic-ref", "--short", "HEAD"], f.root)).trim(), "main");
  assert.deepEqual(await readFile(path.join(f.root, ".git/config")), f.config);
  assert.equal((await runGit(["worktree", "list", "--porcelain"], f.root)).split("\n").filter(line => line.startsWith("worktree ")).length, 1);
}

/**
 * 같은 fixture에서 작업→Undo 계획→Undo를 따로 측정한다. Undo로 다음 표본의 시작 HEAD를 복원한다.
 * @param f 소유한 격리 저장소 @returns 각 구간의 시간/호출 수와 사후 Native 검증 완료 표식
 */
export async function measure(f: Fixture) {
  assert.equal((await runGit(["rev-parse", "HEAD"], f.root)).trim(), f.head);
  await verifyLocalState(f);
  const service = new BranchOperationService(f.root);
  const operation = await timed(() => f.scenario.operation === "squash" ? service.squashMerge("source") : service.rebaseMerge("source"));
  assert.equal(operation.value.status, "completed");
  assert.equal((await runGit(["rev-parse", "HEAD^{tree}"], f.root)).trim(), f.tree);
  assert.equal((await runGit(["rev-parse", "HEAD"], f.root)).trim(), operation.value.afterHead);
  assert.equal((await runGit(["log", "-1", "--format=%P"], f.root)).trim(), f.scenario.operation === "squash" ? f.head : f.source);
  assert.equal((await runGit(["show", "HEAD:user.txt"], f.root)).trim(), "base");
  await verifyLocalState(f);
  const prepare = await timed(() => service.prepareUndo("main"));
  assert.equal(prepare.value.restoredHead, f.head); assert.equal(prepare.value.expectedHead, operation.value.afterHead);
  const undo = await timed(() => service.undoLastOperation("main", prepare.value));
  assert.equal(undo.value.restoredHead, f.head);
  assert.equal((await runGit(["rev-parse", "HEAD"], f.root)).trim(), f.head);
  await assert.rejects(runGit(["rev-parse", "--verify", operation.value.snapshotRef], f.root));
  await verifyLocalState(f);
  return { operation: operation.metrics, prepareUndo: prepare.metrics, undo: undo.metrics, nativeVerified: true };
}

/** fixture 삭제 전에 이 번들이 소유한 상태 감시기와 Git 자식을 모두 회수한다. */
export async function dispose(): Promise<void> { await disposeWorkingTreeSnapshots(); await gitProcesses.dispose(); }
