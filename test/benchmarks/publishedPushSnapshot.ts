// 기존 저장소는 읽기만 하고, 그 객체를 공유하는 소유 임시 bare 저장소끼리만 실제 push한다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "../../src/git/gitExec";
import { gitCommandPolicy } from "../../src/git/gitCommandPolicy";
import { setGitProcessPreparation } from "../../src/git/gitProcessRunner";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { pushBranchCommits } from "../../src/git/sequentialPush";

/** 원본 HEAD/index/config/refs의 내용은 메모리에서만 비교하며 원문과 hash를 결과에 내보내지 않는다. */
async function sourceIdentity(root: string, gitDir: string): Promise<string> {
  const refs = await runGit(["for-each-ref", "--format=%(refname)%00%(objectname)"], root);
  const data = await Promise.all(["HEAD", "index", "config"].map(async name => readFile(path.join(gitDir, name)).catch(error => {
    if (error.code === "ENOENT") return Buffer.alloc(0); throw error;
  })));
  const digest = createHash("sha256").update(refs); for (const bytes of data) digest.update(bytes);
  return digest.digest("hex");
}

/** Native Git 초기화는 이번 실행이 만든 디렉터리만 대상으로 하고 hook/서명/자동 정리는 끈다. */
async function createBare(directory: string, name: string, objects: string): Promise<string> {
  const root = path.join(directory, name);
  await runGit(["-c", "init.templateDir=", "init", "--bare", "-q", "--initial-branch=main", root], directory);
  for (const [key, value] of Object.entries({ "user.name": "Snapshot Benchmark", "user.email": "snapshot@example.invalid",
    "core.hooksPath": path.join(directory, "hooks"), "core.fsmonitor": "false", "commit.gpgSign": "false", "gc.auto": "0", "maintenance.auto": "false" }))
    await runGit(["config", key, value], root);
  await writeFile(path.join(root, "objects/info/alternates"), objects + "\n");
  return root;
}

/**
 * 실제 기존 이력 위에 소유 commit 세 개를 추가하고 소유 서버 main만 이미 게시된 기준점으로 둔다.
 * @param directory 임시 fixture @param base 읽기 전용 원본에서 고정한 commit @param objects 원본 object 디렉터리
 * @returns 원본 파일을 checkout하지 않고도 전체 이력/공유 이력 push 준비를 재현할 두 bare 저장소
 */
async function fixture(directory: string, base: string, objects: string) {
  await mkdir(path.join(directory, "hooks"));
  const root = await createBare(directory, "client.git", objects), remote = await createBare(directory, "receiver.git", objects);
  for (const repo of [root, remote]) await runGit(["update-ref", "refs/heads/main", base], repo);
  await runGit(["remote", "add", "origin", remote], root);
  const tree = (await runGit(["rev-parse", `${base}^{tree}`], root)).trim();
  let head = base;
  for (let index = 0; index < 3; index++) head = (await runGit(["commit-tree", tree, "-p", head, "-m", `owned snapshot commit ${index}`], root)).trim();
  await runGit(["update-ref", "refs/heads/feature", head], root);
  return { root, remote, head, tree };
}

/** 계획과 실제 단일 전송을 계측한다. 원본 조회, fixture 생성과 결과 확인 비용은 구간 밖이다. */
async function measure(f: Awaited<ReturnType<typeof fixture>>) {
  const executions: GitExecutionTiming[] = [], stop = setGitExecutionObserver(timing => executions.push(timing));
  const cpu = process.cpuUsage(), rss = process.memoryUsage.rss(), started = performance.now();
  let readyAt: number | undefined;
  try {
    const result = await pushBranchCommits(f.root, { branch: "feature", head: f.head, remote: "origin", targetRef: "refs/heads/feature" }, {
      onProgress: progress => { if (progress.phase === "ready") readyAt = performance.now(); },
    });
    const elapsedMs = Math.round(performance.now() - started), used = process.cpuUsage(cpu);
    stop(); assert.equal(result.strategy, "single"); assert.equal(result.completed, 1); assert.ok(readyAt !== undefined);
    assert.equal((await runGit(["rev-parse", "refs/heads/feature"], f.remote)).trim(), f.head);
    assert.equal((await runGit(["rev-parse", "refs/heads/feature^{tree}"], f.remote)).trim(), f.tree);
    assert.equal(gitProcesses.isBusy(f.root), false);
    return { elapsedMs, planningMs: Math.round(readyAt - started), nodeCpuMs: Math.round((used.user + used.system) / 1000),
      nodeRssDeltaMiB: (process.memoryUsage.rss() - rss) / 1048576, processes: executions.length, result,
      commands: executions.map(({command, elapsedMs, outcome, code}) => ({command, elapsedMs, outcome, code})),
      exactRemoteHeadAndTree: true, ownedProcessesIdle: true };
  } finally { stop(); }
}

/** 원본에 허용하는 Git 명령을 제한하고, 전송 URL은 소유 임시 서버로 고정한다. 원본에는 어떤 쓰기도 하지 않는다. */
async function main() {
  assert.ok(!process.env.GIT_DIR && !process.env.GIT_WORK_TREE && !process.env.GIT_INDEX_FILE && !process.env.GIT_COMMON_DIR,
    "A custom Git worktree environment is not supported by this readonly source fixture");
  const input = process.env.GSC_BENCH_READONLY_REPOSITORY, output = process.argv[2]; assert.ok(input && output);
  assert.ok(path.resolve(output).startsWith("/private/tmp/") || path.resolve(output).startsWith(path.resolve(os.tmpdir()) + path.sep));
  const source = await realpath(input), directory = await mkdtemp(path.join(os.tmpdir(), "gsc-published-snapshot-"));
  const reset = setGitProcessPreparation(async (args, cwd, options) => {
    const root = path.resolve(cwd), command = gitCommandPolicy(args);
    if (root === source) assert.ok(command.readOnly && ["rev-parse", "for-each-ref"].includes(command.command), "The source only permits metadata reads");
    else assert.ok(root === directory || root.startsWith(directory + path.sep), "Unexpected operation root");
    if (command.command === "ls-remote") assert.ok(args.includes(path.join(directory, "receiver.git")), "Advertisement must use the owned local receiver");
    if (command.command === "push") assert.ok(root === path.join(directory, "client.git") && args.includes("origin"), "Push must use the owned fixture remote");
    return { options: { ...options, env: { ...options.env, GIT_OPTIONAL_LOCKS: "0" } } };
  });
  try {
    assert.equal(await realpath((await runGit(["rev-parse", "--show-toplevel"], source)).trim()), source);
    const gitDir = (await runGit(["rev-parse", "--absolute-git-dir"], source)).trim();
    const common = (await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], source)).trim();
    const objects = await realpath(path.join(common, "objects")), before = await sourceIdentity(source, gitDir);
    const pinned = process.env.GSC_BENCH_SNAPSHOT_COMMIT;
    assert.ok(!pinned || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pinned), "Pinned source must be an immutable commit OID");
    const base = (await runGit(["rev-parse", `${pinned ?? "HEAD"}^{commit}`], source)).trim(), f = await fixture(directory, base, objects);
    console.error("Measuring owned push over existing immutable history...");
    const result = await measure(f), unchanged = before === await sourceIdentity(source, gitDir);
    assert.ok(unchanged, "External source state changed during the observation");
    const report = { source: JSON.parse(process.env.GSC_BENCH_SOURCE!), sourceRepositoryUnchanged: unchanged, immutableSourcePinned: !!pinned,
      scenario: "Three owned commits over existing readonly history; local owned bare receiver already publishes the base", result,
      limits: "Existing source objects are shared through alternates, without checkout or object copying. No actual user/remote mutation, network, Graph timing or whole-OS CPU/RSS measurement. Node CPU is parent only." };
    // 결과의 lastPushedCommit은 원본 OID를 포함할 수 있어 외부 진단 결과에는 보내지 않는다.
    delete (report.result.result as Partial<typeof report.result.result>).lastPushedCommit;
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", {flag:"wx"}); console.log(JSON.stringify(report, null, 2));
  } finally { reset(); await gitProcesses.dispose(); await rm(directory, {recursive:true, force:true}); }
}
main().catch(error => { console.error(error instanceof Error ? {name:error.name,message:error.message.replaceAll(process.env.GSC_BENCH_READONLY_REPOSITORY ?? "\0", "<readonly-source>")} : "Snapshot benchmark failed"); process.exitCode=1; });
