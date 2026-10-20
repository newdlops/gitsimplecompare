// 외부 작업트리는 조회만 하고, 인자·커밋 내용·브랜치 이름을 저장하지 않는 Graph 병목 진단이다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "../../src/git/gitExec";
import { gitCommandPolicy } from "../../src/git/gitCommandPolicy";
import { setGitProcessPreparation } from "../../src/git/gitProcessRunner";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { GitLogService } from "../../src/git/gitLogService";

/** 원문 대신 해시만 메모리에서 비교한다. 해시와 실제 경로도 결과 파일에는 내보내지 않는다. */
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

/** 선택적 index/config 파일의 부재를 다른 읽기 실패와 구분한다. 쓰기나 디렉터리 생성은 하지 않는다. */
async function optionalDigest(file: string): Promise<string | undefined> {
  try { return digest(await readFile(file)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/**
 * 조회 전후 HEAD/index/config/refs가 같은지 확인한다. 사용자 작업에 잠금을 걸지 않는다.
 * @param root 실제 기존 작업트리 @param gitDir Native Git이 반환한 worktree metadata
 * @returns 비교용 증거와 민감한 이름을 제외한 ref 개수
 */
async function snapshot(root: string, gitDir: string) {
  const raw = await runGit(["for-each-ref", "--format=%(refname)%00%(objectname)"], root);
  const commonFile = await readFile(path.join(gitDir, "commondir"), "utf8").catch(error => {
    if (error.code === "ENOENT") return ""; throw error;
  });
  const common = commonFile ? path.resolve(gitDir, commonFile.replace(/\r?\n$/, "")) : gitDir;
  const files = await Promise.all(["HEAD", "index", "config.worktree"].map(name => optionalDigest(path.join(gitDir, name))));
  files.push(await optionalDigest(path.join(common, "config")));
  const refs = raw.split("\n").filter(Boolean);
  return { evidence: digest(JSON.stringify([digest(raw), files, commonFile])), counts: {
    local: refs.filter(ref => ref.startsWith("refs/heads/")).length,
    remote: refs.filter(ref => ref.startsWith("refs/remotes/")).length,
    tags: refs.filter(ref => ref.startsWith("refs/tags/")).length,
  } };
}

/** 서비스 단계의 비용만 계측하며 Git 인자·출력·에러 본문은 결과에 포함하지 않는다. */
async function measure<T>(label: string, read: () => Promise<T>) {
  const timings: GitExecutionTiming[] = [], stop = setGitExecutionObserver(timing => timings.push(timing));
  const cpu = process.cpuUsage(), rss = process.memoryUsage.rss(), started = performance.now();
  try {
    const value = await read(), used = process.cpuUsage(cpu);
    return { value, metrics: { label, elapsedMs: Math.round(performance.now() - started), nodeCpuMs: Math.round((used.user + used.system) / 1000),
      nodeRssDeltaMiB: (process.memoryUsage.rss() - rss) / 1048576,
      commands: timings.map(({ command, elapsedMs, syncSpawnMs, outcome, code }) => ({ command, elapsedMs, syncSpawnMs, outcome, code })) } };
  } finally { stop(); }
}

/** 현재 branch snapshot 두 번이 이름을 내보내지 않고도 완전히 같은 결과인지 비교한다. */
function branchSignature(snapshot: Awaited<ReturnType<GitLogService["getLocalBranchSnapshot"]>>): string {
  return digest(JSON.stringify(snapshot));
}

/**
 * Git 실행 직전에도 읽기 명령만 허용하고 optional index 쓰기를 강제로 끈다.
 * 네트워크·fetch·mutation·감시자 시작은 허용하지 않는다. 실패는 추가 조회 재시도 없이 종료한다.
 */
async function main() {
  const input = process.env.GSC_BENCH_READONLY_REPOSITORY, output = process.argv[2];
  assert.ok(input && output, "Set GSC_BENCH_READONLY_REPOSITORY and an output JSON path");
  const target = path.resolve(output);
  assert.ok([os.tmpdir(), "/private/tmp", "/tmp"].some(dir => target.startsWith(path.resolve(dir) + path.sep)), "Output must be under a temporary directory");
  const root = await realpath(input), allowed = new Set(["rev-parse", "for-each-ref", "log", "rev-list", "config", "merge-base", "show", "cat-file", "symbolic-ref", "show-ref", "remote"]);
  const reset = setGitProcessPreparation(async (args, cwd, options) => {
    const policy = gitCommandPolicy(args);
    assert.equal(path.resolve(cwd), root, "Unexpected repository");
    assert.ok(policy.readOnly && allowed.has(policy.command), "Readonly diagnosis rejected a mutation or network command");
    return { options: { ...options, env: { ...options.env, GIT_OPTIONAL_LOCKS: "0" } } };
  });
  try {
    const top = (await runGit(["rev-parse", "--show-toplevel"], root)).replace(/\r?\n$/, "");
    assert.equal(await realpath(top), root, "Select the actual worktree root");
    const gitDir = (await runGit(["rev-parse", "--absolute-git-dir"], root)).replace(/\r?\n$/, "");
    const before = await snapshot(root, gitDir), results = [], service = new GitLogService(root);
    let failure: { name: string; code?: string | number } | undefined;
    try {
      console.error("Reading existing repository history page...");
      const page = await measure("history-page", () => service.getCommitPage(300, 0, [], false));
      results.push({ ...page.metrics, rows: page.value.length });
      console.error("Reading first branch snapshot...");
      const first = await measure("branch-snapshot-first", () => service.getLocalBranchSnapshot());
      results.push({ ...first.metrics, branches: first.value.branches.length, invalidRefs: first.value.invalidRefs.length });
      console.error("Reading subsequent branch snapshot...");
      const next = await measure("branch-snapshot-next", () => service.getLocalBranchSnapshot());
      results.push({ ...next.metrics, branches: next.value.branches.length, invalidRefs: next.value.invalidRefs.length,
        sameAsFirst: branchSignature(first.value) === branchSignature(next.value) });
    } catch (error) { const detail = error as { name?: string; code?: string | number }; failure = { name: detail.name ?? "Error", code: detail.code }; }
    const after = await snapshot(root, gitDir);
    assert.equal(gitProcesses.isBusy(root), false, "Readonly diagnosis must release its Git processes");
    const report = { source: JSON.parse(process.env.GSC_BENCH_SOURCE!), readOnly: true, networkAllowed: false,
      repositoryUnchanged: before.evidence === after.evidence, references: before.counts, results, failure,
      limits: "Single readonly diagnosis, no mutation or real button/Graph frame timing. CPU/RSS are benchmark Node only; external user work is not blocked." };
    await writeFile(target, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify(report, null, 2));
    if (failure) process.exitCode = 1;
  } finally { reset(); await gitProcesses.dispose(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
