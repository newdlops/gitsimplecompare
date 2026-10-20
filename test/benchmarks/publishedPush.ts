// 작은 임계값으로 기존 이력을 잘못 재전송하는 경우를 실제 Git server update로 관찰한다.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit, runGitWithInput } from "../../src/git/gitExec";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { getCurrentPushPlan, pushCurrentWithAutoUpstream } from "../../src/git/pushService";
import type { PushProgress } from "../../src/git/sequentialPush";

const THRESHOLD = 2048;

/** shell hook의 출력 경로를 리터럴로 보존한다. */
function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/** 공개된 32개 조상과 신규 3개 커밋을 만들고, 원격은 조상만 이미 갖도록 준비한다. */
async function fixture(directory: string, large: boolean) {
  const root = path.join(directory, "repo"), remote = path.join(directory, "origin.git"), updates = path.join(directory, "updates");
  await mkdir(root); await mkdir(path.join(directory, "hooks"));
  await runGit(["-c", "init.templateDir=", "init", "-q", "--initial-branch=main"], root);
  for (const [key, value] of Object.entries({ "user.name": "Push Fixture", "user.email": "push@example.invalid",
    "core.fsmonitor": "false", "core.hooksPath": path.join(directory, "hooks"), "commit.gpgSign": "false" }))
    await runGit(["config", key, value], root);
  let mark = 1;
  const data = ["blob", "mark :1", "data 8", "fixture\n"];
  /** 일정한 부모·메시지·변경으로 fixture를 만들어 수백 번의 commit 프로세스를 피한다. */
  const commit = (ref: string, parent: number | undefined, message: string, changes: string[] = []) => {
    const current = ++mark;
    data.push(`commit refs/heads/${ref}`, `mark :${current}`, "committer Push Fixture <push@example.invalid> 1700000000 +0000",
      `data ${Buffer.byteLength(message)}`, message, ...(parent ? [`from :${parent}`] : []), ...changes, "");
    return current;
  };
  let base = commit("main", undefined, "base", ["M 100644 :1 tracked.txt"]);
  for (let index = 1; index < 32; index++) base = commit("main", base, `published ${index}`);
  let tip = base;
  if (large) { const payload = "larger feature change\n".repeat(512); data.push("blob", `mark :${++mark}`, `data ${Buffer.byteLength(payload)}`, payload); }
  const featureBlob = large ? mark : 1;
  for (let index = 0; index < 3; index++) tip = commit("feature", tip, `feature ${index}`, [`M 100644 :${featureBlob} feature-${index}.txt`]);
  await runGitWithInput(["fast-import", "--quiet"], root, data.join("\n") + "\n");
  await runGit(["reset", "--hard", "main"], root);
  await runGit(["-c", "init.templateDir=", "init", "-q", "--bare", "--initial-branch=main", remote], directory);
  await runGit(["remote", "add", "origin", remote], root);
  await runGit(["push", "-qu", "origin", "main"], root);
  const baseOid = (await runGit(["rev-parse", "main"], root)).trim();
  await mkdir(path.join(remote, "hooks"), { recursive: true });
  await writeFile(path.join(remote, "hooks/post-receive"), `#!/bin/sh\ncat >> ${quote(updates)}\n`, { mode: 0o755 });
  await runGit(["switch", "-q", "feature"], root);
  return { root, remote, updates, baseOid, head: (await runGit(["rev-parse", "HEAD"], root)).trim() };
}

/** 계획과 Native 전송을 따로 기록하고 원격의 실제 ref update·로컬 보존을 대조한다. */
async function measure(directory: string, large: boolean) {
  const f = await fixture(directory, large), index = await readFile(path.join(f.root, ".git/index"));
  await writeFile(path.join(f.root, "untracked.txt"), "keep local\n");
  const events: (PushProgress & { atMs: number })[] = [], calls: (GitExecutionTiming & { atMs: number })[] = [];
  const started = performance.now(), cpu = process.cpuUsage(), stop = setGitExecutionObserver(event => calls.push({ ...event, atMs: Math.round(performance.now() - started) }));
  let planMs = 0, result;
  try {
    const plan = await getCurrentPushPlan(f.root); planMs = Math.round(performance.now() - started);
    result = await pushCurrentWithAutoUpstream(f.root, plan, { sequentialThresholdBytes: THRESHOLD,
      onProgress: event => events.push({ ...event, atMs: Math.round(performance.now() - started) }) });
  } finally { stop(); }
  const elapsedMs = Math.round(performance.now() - started), used = process.cpuUsage(cpu);
  const received = (await readFile(f.updates, "utf8")).trim().split("\n").map(line => line.split(" ")[1]);
  assert.equal(received.at(-1), f.head); assert.equal(result.execution?.lastPushedCommit, f.head);
  assert.equal((await runGit(["rev-parse", "refs/heads/feature"], f.remote)).trim(), f.head);
  assert.equal((await runGit(["rev-parse", "refs/heads/main"], f.remote)).trim(), f.baseOid);
  assert.equal((await runGit(["rev-parse", "--abbrev-ref", "@{u}"], f.root)).trim(), "origin/feature");
  assert.deepEqual(await readFile(path.join(f.root, ".git/index")), index);
  assert.equal(await readFile(path.join(f.root, "untracked.txt"), "utf8"), "keep local\n");
  return { mode: large ? "shared-large-feature" : "shared-small-feature", thresholdBytes: THRESHOLD, publishedCommits: 32, newCommits: 3,
    elapsedMs, planMs, readyMs: events.find(event => event.phase === "ready")!.atMs,
    nativePushElapsedMs: calls.filter(event => event.command === "push").reduce((sum, event) => sum + event.elapsedMs, 0),
    directGitCalls: calls.length, nativePushes: calls.filter(event => event.command === "push").length,
    remoteRefUpdates: received.length, strategy: result.execution!.strategy, plannedTransfers: result.execution!.total,
    estimatedBytes: result.execution!.estimatedBytes, nodeCpuMs: Math.round((used.user + used.system) / 1000),
    nativeStateExact: true, indexAndUntrackedPreserved: true, commands: calls.map(({ command, elapsedMs, atMs }) => ({ command, elapsedMs, atMs })) };
}

/** 각 모드를 독립 저장소에서 한 번 실행하고 fixture와 source fingerprint를 원본 표본에 남긴다. */
async function main() {
  const output = process.argv[2]; assert.ok(output, "Output JSON path is required");
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-published-push-"));
  try {
    const results = [];
    for (const large of [false, true]) {
      const current = path.join(directory, large ? "large" : "small"); await mkdir(current);
      console.error(`Measuring ${large ? "large" : "small"} feature...`); results.push(await measure(current, large));
    }
    const report = { source: JSON.parse(process.env.GSC_BENCH_SOURCE!),
      scope: "Native Git with local bare remote; 2KiB test threshold scales the branch-history case, not production 50MiB network throughput; Node CPU excludes Git/helpers; no Graph", results };
    await writeFile(output, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
