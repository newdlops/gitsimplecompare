// 작은 임계값으로 기존 이력을 잘못 재전송하는 경우를 실제 Git server update로 관찰한다.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "../../src/git/gitExec";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { getCurrentPushPlan, pushCurrentWithAutoUpstream } from "../../src/git/pushService";
import type { PushProgress } from "../../src/git/sequentialPush";
import { createPublishedPushFixture } from "../helpers/publishedPushFixture";

const THRESHOLD = 2048;
const STALE_BRANCHES = Number(process.env.GSC_BENCH_PUBLISHED_HEADS ?? 0);
assert.ok(Number.isInteger(STALE_BRANCHES) && STALE_BRANCHES >= 0 && STALE_BRANCHES <= 4096, "Published head fixture must be between 0 and 4096");

/** 계획과 Native 전송을 따로 기록하고 원격의 실제 ref update·로컬 보존을 대조한다. */
async function measure(directory: string, large: boolean) {
  const f = await createPublishedPushFixture(directory, { largeFeature: large, staleBranches: STALE_BRANCHES }), index = await readFile(path.join(f.root, ".git/index"));
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
  return { mode: large ? "shared-large-feature" : "shared-small-feature", thresholdBytes: THRESHOLD, publishedCommits: f.publishedCommits, staleAdvertisedBranches: f.staleBranches, newCommits: 3,
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
