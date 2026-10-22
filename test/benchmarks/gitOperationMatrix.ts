// 실제 서비스의 준비/쓰기/Graph 최신 게시/후속 조회 비용을 사용자 저장소 없이 비교한다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { benchmarkOverrides as mock } from "../helpers/benchmarkOverrides";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { runGit } from "../../src/git/gitExec";
import { createGitOperationFixture as fixture } from "../helpers/gitOperationFixture";
import { GitLogService } from "../../src/git/gitLogService";
import { BranchOperationService } from "../../src/git/branchOperationService";
import { PullRequestOperationService } from "../../src/git/pullRequestOperationService";
import { PullService } from "../../src/git/pullService";
import { getCurrentPushPlan, pushCurrentWithAutoUpstream } from "../../src/git/pushService";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { disposeWorkingTreeSnapshots } from "../../src/git/workingTreeSnapshot";
import { createOperationGraphPanel } from "../helpers/graphOperationPanel";
import type { PullRequestInfo } from "../../src/git/pullRequestInfo";
import type { Commit } from "../../src/graph/graphTypes";
import type { GraphRenderPerformance } from "../../src/webview/graphProtocol";
import { GraphLiveRenderer } from "../helpers/graphLiveRenderer";
import { setOwnedFsmonitorPolicy } from "../../src/git/ownedFsmonitor";
import { startNodeCpuProfile } from "../helpers/nodeCpuProfile";
import { readNativeGraphExpectation, readNativeRemoteTagExpectation } from "../helpers/graphNativeExpectation";
import { GraphPhaseResources } from "../helpers/graphPhaseResources";
import { BenchmarkTurnGate } from "../helpers/benchmarkTurnGate";

type Operation = "initial" | "push" | "push-tracked" | "pull" | "pull-new-history" | "fetch" | "fetch-new-history" | "rebase" | "merge" | "merge-no-ff" | "pr-squash-cherry-pick" | "pr-cherry-pick" | "cherry-pick" | "checkout" | "checkout-unloaded" | "pull-known-history" | "fetch-known-history" | "fetch-no-change";
const OPERATIONS: Operation[] = ["push", "pull", "fetch", "rebase", "merge", "pr-squash-cherry-pick", "pr-cherry-pick", "cherry-pick", "checkout"];
const PUSH_THRESHOLD = process.env.GSC_BENCH_PUSH_THRESHOLD_BYTES === undefined ? undefined : Number(process.env.GSC_BENCH_PUSH_THRESHOLD_BYTES);
const benchmarkSource = JSON.parse(process.env.GSC_BENCH_SOURCE!);
// 측정 구간에는 baseline/candidate 선택·기록 환경 변수를 남기지 않는다.
delete process.env.GSC_BENCH_SOURCE_REF; delete process.env.GSC_BENCH_SOURCE;
assert.ok(PUSH_THRESHOLD === undefined || (Number.isFinite(PUSH_THRESHOLD) && PUSH_THRESHOLD >= 0), "Push threshold must be a non-negative byte count");

/** 행 순서와 무관하게 실제 HEAD·부모·ref와 최종 local-only 표시까지 같은 게시를 식별한다. */
function graphSignature(commits: readonly Commit[]): string {
  return JSON.stringify(commits.map(commit => [commit.hash, commit.parents, [...new Set(commit.refs)].sort(), [...commit.localOnlyBranches ?? []].sort()])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}


/** 늦게 끝난 Graph 보조 조회까지 비용에 포함하고 다음 시나리오로 넘어가기 전에 모두 정리한다. */
async function idle(root: string, panel: any, metadataReady: () => boolean = () => true, quietMs = 20): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!gitProcesses.isBusy(root) && !panel.loading && !panel.workingTree.state?.loading && metadataReady()) {
      await new Promise(resolve => setTimeout(resolve, quietMs));
      if (!gitProcesses.isBusy(root) && !panel.loading && !panel.workingTree.state?.loading && metadataReady()) return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Fixture Git/Graph work did not become idle.");
}

/** 같은 선택 PR의 원본 commit만 실제 작업에 사용하도록 완전한 Git 필드를 제공한다. */
function pullRequest(f: Awaited<ReturnType<typeof fixture>>): PullRequestInfo {
  return { number: 42, title: "Operation benchmark", state: "OPEN", url: "https://example.invalid/pull/42", headRefName: f.prBranch,
    headHash: f.pr, baseRefName: f.mainBranch, baseHash: f.main, author: "fixture", isDraft: false,
    commentCount: 0, fileCount: 3, commitHashes: f.prCommits, commitHashesComplete: true };
}

/** 실제 서비스 성공과 Graph의 HEAD/부모/ref가 같은 Git 상태인지 확인하는 하나의 측정이다. */
async function measure(f: Awaited<ReturnType<typeof fixture>>, operation: Operation, resources?: GraphPhaseResources) {
  f = await isolateIncomingCommit(f, operation);
  const git = (args: string[], cwd = f.root) => runGit(args, cwd);
  await git(["switch", "-qC", `bench-${operation}`, operation === "push" || operation === "push-tracked" ? f.pr : f.main]);
  await git(["update-ref", `refs/heads/${f.mainBranch}`, f.main], f.remote);
  if (operation === "push-tracked") {
    // 이름이 같은 기존 upstream을 고정해 새 브랜치 publish와 일반 push 준비 경로를 분리한다.
    await git(["update-ref", `refs/heads/bench-${operation}`, f.main], f.remote);
    await git(["update-ref", `refs/remotes/origin/bench-${operation}`, f.main]);
    await git(["config", `branch.bench-${operation}.remote`, "origin"]);
    await git(["config", `branch.bench-${operation}.merge`, `refs/heads/bench-${operation}`]);
  }
  if (operation === "pull" || operation === "pull-known-history" || operation === "pull-new-history") {
    await git(["config", `branch.bench-${operation}.remote`, "origin"]);
    await git(["config", `branch.bench-${operation}.merge`, `refs/heads/${f.mainBranch}`]);
    await git(["update-ref", `refs/heads/${f.mainBranch}`, operation === "pull-new-history" ? f.incomingPull : f.incoming], f.remote);
    if (operation === "pull-known-history") await git(["fetch", "-q", "origin"]);
  }
  if (operation === "fetch" || operation === "fetch-new-history") await git(["update-ref", "refs/heads/incoming", f.incoming], f.remote);
  if (operation === "fetch-new-history") await assert.rejects(git(["cat-file", "-e", f.incoming]), "Fresh fetch fixture must not already contain its incoming object");
  if (operation === "pull-new-history") await assert.rejects(git(["cat-file", "-e", f.incomingPull]), "Fresh pull fixture must not already contain its incoming object");
  if (operation === "fetch-known-history") await git(["update-ref", "refs/heads/known-history", f.main], f.remote);
  const publications: { at: number; signature: string; performance?: GraphRenderPerformance }[] = [];
  let measuring = false;
  const renderer = process.env.GSC_BENCH_LIVE_RENDERER === "1" ? await GraphLiveRenderer.create() : undefined;
  const service = new GitLogService(f.root), { panel, messages, surface } = createOperationGraphPanel({ mock } as any, service, message => {
    renderer?.post(message);
    if (measuring && (message.type === "graph" || message.type === "graphDelta")) publications.push({
      at: performance.now(), signature: graphSignature(panel.commits), performance: message.performance });
  });
  const branchReads: { startedAt: number; finishedAt?: number }[] = [];
  const readBranches = service.getLocalBranchSnapshot.bind(service);
  mock.method(service, "getLocalBranchSnapshot", async (...args: Parameters<typeof readBranches>) => {
    const timing = measuring ? { startedAt: Date.now(), finishedAt: undefined as number | undefined } : undefined;
    if (timing) branchReads.push(timing);
    try { return await readBranches(...args); } finally { if (timing) timing.finishedAt = Date.now(); }
  });
  const localOnlyFailures: string[] = [], cache: any = (service as any).localOnlyBranchCache;
  const markerRead = typeof cache.getReadOnlyMap === "function" ? "getReadOnlyMap" : "getMap";
  const getLocalOnlyMap = cache[markerRead].bind(cache);
  let pendingMarkers = 0;
  mock.method(cache, markerRead, async () => {
    pendingMarkers++;
    try { return await getLocalOnlyMap(); } catch (error) {
      localOnlyFailures.push(error instanceof Error ? error.message : String(error)); throw error;
    } finally { pendingMarkers--; }
  });
  /** 제품이 시작한 metadata 조회만 기다리며 benchmark가 별도 계산을 먼저 시작하지 않는다. */
  const metadataReady = () => pendingMarkers === 0 && (!cache.remoteReady || !!cache.completed || localOnlyFailures.length > 0);
  try {
    if (renderer) await renderer.mount(surface.webview.html);
    if (operation !== "initial") { assert.equal(await panel.runDirectGraph("ready"), true); await idle(f.root, panel, metadataReady, resources ? 150 : 20); }
    // Graph 행에서 checkout하는 일반 경로와 페이지 밖의 오래된 topic 이동을 별도 측정한다.
    const loadedTarget = operation === "checkout" && process.env.GSC_BENCH_CHECKOUT_LOADED_TARGET === "1";
    const visibleHashes = new Set<string>(panel.commits.map((commit: Commit) => commit.hash));
    const previousHead = panel.lastLocalBranches.find((branch: { current: boolean }) => branch.current)?.hash;
    const fixedLoadedTarget = loadedTarget && process.env.GSC_BENCH_CHECKOUT_FIXED_TARGET === "1";
    if (fixedLoadedTarget) assert.ok(visibleHashes.has(f.topic), "The same Native topic must be visible in both source pages");
    const checkoutTarget: string | undefined = fixedLoadedTarget ? f.topicBranch : loadedTarget
      ? panel.lastLocalBranches.filter((branch: { current: boolean; hash: string }) => !branch.current && branch.hash !== previousHead && visibleHashes.has(branch.hash))
        .sort((left: { name: string }, right: { name: string }) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))[0]?.name
      : operation === "checkout-unloaded" ? f.oldHistoryBranch : f.topicBranch;
    assert.ok(checkoutTarget, "Loaded checkout fixture needs an actual visible local branch tip");
    // 앞선 Native commit의 committer 시각/OID는 두 source에서 달라질 수 있다. 실제 checkout 파일 입력은 branch+tree로 맞춘다.
    const checkoutTree = operation.startsWith("checkout") ? (await git(["rev-parse", "--verify", `${checkoutTarget}^{tree}`])).trim() : undefined;
    const checkoutTargetFingerprint = checkoutTree
      ? createHash("sha256").update(checkoutTarget).update("\0").update(checkoutTree).digest("hex") : undefined;
    if (operation === "checkout-unloaded") assert.equal(visibleHashes.has(f.oldHistory), false, "Unloaded checkout requires a deeper fixture than the loaded Graph page");
    const initialSignature = graphSignature(panel.commits);
    const timings: (GitExecutionTiming & { finishedAtMs: number })[] = [];
    const unobserve = setGitExecutionObserver(timing => timings.push({ ...timing, finishedAtMs: performance.now() }));
    const active = new Set<number>(); let peakProcesses = 0;
    const register = gitProcesses.register.bind(gitProcesses), closed = gitProcesses.closed.bind(gitProcesses);
    mock.method(gitProcesses, "register", (...args: Parameters<typeof register>) => {
      const id = register(...args); active.add(id); peakProcesses = Math.max(peakProcesses, active.size); return id;
    });
    mock.method(gitProcesses, "closed", async (id: number) => { try { await closed(id); } finally { active.delete(id); } });
    const profile = await startNodeCpuProfile(operation);
    assert.ok(!resources || renderer, "Scoped resources require the live production renderer");
    assert.ok(!resources || !profile, "CPU sampling and scoped resource counters require separate runs");
    if (resources && renderer) await resources.begin(renderer, operation, "service");
    const started = performance.now(), cpu = process.cpuUsage(), rss = process.memoryUsage.rss();
    let peakRss = rss;
    const rssSample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage.rss()); }, 10);
    measuring = true;
    const beforeMessages = messages.length;
    let operationEnd: number, operationEndedAt: number, graphEnd: number;
    try {
      switch (operation) {
        case "initial": break;
        case "push": case "push-tracked": await pushCurrentWithAutoUpstream(f.root, await getCurrentPushPlan(f.root), { sequentialThresholdBytes: PUSH_THRESHOLD }); break;
        case "pull": case "pull-known-history": case "pull-new-history": assert.equal((await new PullService(f.root).pullCurrent()).status, "completed"); break;
        case "fetch": case "fetch-new-history": case "fetch-known-history": case "fetch-no-change": await service.fetchAll(); break;
        case "rebase": assert.equal((await new BranchOperationService(f.root).rebaseMerge(f.topicBranch)).status, "completed"); break;
        case "merge": assert.equal((await new BranchOperationService(f.root).squashMerge(f.topicBranch)).status, "completed"); break;
        case "merge-no-ff": await git(["merge", "--no-ff", "--no-edit", f.topicBranch]); break;
        case "pr-squash-cherry-pick": assert.equal((await new PullRequestOperationService(f.root).squashCherryPick(pullRequest(f))).status, "completed"); break;
        case "pr-cherry-pick": assert.equal((await new PullRequestOperationService(f.root).rebasePullRequest(pullRequest(f))).status, "completed"); break;
        case "cherry-pick": await service.cherryPick(f.prCommits[0]); break;
        case "checkout": case "checkout-unloaded": assert.ok(await service.getLocalBranchCheckoutState(checkoutTarget)); await service.checkoutLocalBranch(checkoutTarget); break;
      }
      operationEnd = performance.now();
      operationEndedAt = Date.now();
      const operationProcesses = timings.length;
      if (operation === "initial") assert.equal(await panel.runDirectGraph("ready"), true);
      else if (operation === "checkout" || operation === "checkout-unloaded") await panel.refreshAfterCheckoutAction();
      else if (operation.startsWith("fetch")) await panel.refreshAfterFetchAction();
      else await panel.refreshAfterGraphAction(operation === "push" || operation === "push-tracked" ? "references" : "graph");
      graphEnd = performance.now();
      await idle(f.root, panel, metadataReady, resources ? 150 : 20);
      if (resources && renderer) await renderer.waitForPendingFrame(publications.at(-1)?.performance);
      const settledAt = performance.now(), settledRss = process.memoryUsage.rss();
      clearInterval(rssSample); measuring = false;
      const cpuUsed = process.cpuUsage(cpu), commands: Record<string, number> = {}, graphCommands: Record<string, number> = {}, commandTimeMs: Record<string, number> = {};
      const phaseResources = resources && renderer ? await resources.finish(renderer, cpuUsed, timings.length) : undefined;
      await profile?.stop();
      for (const [index, timing] of timings.entries()) {
        commands[timing.command] = (commands[timing.command] ?? 0) + 1;
        commandTimeMs[timing.command] = (commandTimeMs[timing.command] ?? 0) + timing.elapsedMs;
        if (index >= operationProcesses) graphCommands[timing.command] = (graphCommands[timing.command] ?? 0) + 1;
      }
      if (operation === "fetch-new-history" || operation === "pull-new-history") assert.equal(graphCommands.log, 1, "Previously unknown history needs exactly one Graph page read");
      if (loadedTarget) assert.equal(graphCommands.log ?? 0, 0, "A visible checkout must reuse the existing Graph page");
      if (operation === "checkout-unloaded") assert.equal(graphCommands.log, 1, "A checkout outside the loaded page requires one history read");
      unobserve();
      const head = (await git(["rev-parse", "HEAD"])).trim();
      const actual = await readNativeGraphExpectation(f.root, panel.commits.length);
      const visibleHead = actual.find(commit => commit.refs.includes("HEAD"))?.hash;
      if (visibleHead !== undefined) assert.equal(visibleHead, head);
      assert.equal(panel.commits.find((commit: Commit) => commit.refs.includes("HEAD"))?.hash, visibleHead);
      const values = (commits: Commit[]) => new Map(commits.map(commit => [commit.hash, { parents: commit.parents, refs: [...new Set(commit.refs)].sort() }]));
      assert.deepEqual(values(panel.commits), values(actual));
      assert.equal(graphSignature(panel.commits), graphSignature(actual), "Final local-only markers must match independently seeded fresh Native data");
      assert.deepEqual(localOnlyFailures, [], "A swallowed marker read error is not a correct completed Graph");
      for (const commit of panel.commits as Commit[]) for (const ref of commit.refs) {
        const index = /^side-(\d+)$/.exec(ref)?.[1];
        if (index !== undefined && Number(index) < f.sharedUpstreamBranches) assert.ok(commit.localOnlyBranches?.includes(ref),
          `Missing upstream-relative marker: ${JSON.stringify({ ref, branch: panel.lastLocalBranches.find((value: { name: string }) => value.name === ref),
            remoteReady: cache.remoteReady, completed: !!cache.peek(), failures: localOnlyFailures })}`);
      }
      const finalSignature = graphSignature(panel.commits), graphAlreadyCurrent = initialSignature === finalSignature;
      // 같은 최종 상태가 한 frame 전에 연속 게시되면 renderer는 이전 ACK를 정상 생략하므로 마지막 게시를 검증한다.
      const latestPublication = publications.slice().reverse().find(publication => publication.at >= operationEnd && publication.signature === finalSignature);
      const latestPublishedAt = latestPublication?.at;
      assert.ok(latestPublishedAt !== undefined || graphAlreadyCurrent, "Changed final Git graph must have been published; unchanged data needs no repaint.");
      const liveRenderer = await renderer?.verify(panel.commits, head, operationEndedAt, graphAlreadyCurrent, latestPublication?.performance,
        panel.lastLocalBranches.find((branch: { current: boolean }) => branch.current)?.name,
        renderer ? await readNativeRemoteTagExpectation(f.root) : []);
      if (renderer && operation === "checkout" && process.env.GSC_BENCH_SCREENSHOTS) await renderer.capture(process.env.GSC_BENCH_SCREENSHOTS);
      return { operation, operationMs: Math.round(operationEnd - started), graphMs: Math.round(graphEnd - operationEnd),
        branchDetailsReads: branchReads.map(read => ({ startedAfterOperationMs: read.startedAt - operationEndedAt,
          durationMs: read.finishedAt === undefined ? null : read.finishedAt - read.startedAt,
          firstFrameBeforeDetails: !!liveRenderer?.mutationToFrameMs && read.finishedAt !== undefined &&
            operationEndedAt + liveRenderer.mutationToFrameMs < read.finishedAt })),
        ...(operation === "checkout" ? { checkoutTargetScope: fixedLoadedTarget ? "fixed-loaded-topic" : loadedTarget ? "loaded-page" : "topic" } : {}),
        ...(checkoutTargetFingerprint ? { checkoutTargetFingerprint, checkoutTargetFingerprintKind: "branch-and-tree" } : {}),
        ...(liveRenderer ? { liveRenderer } : {}),
        latestGraphPublishedMs: latestPublishedAt === undefined ? null : Math.round(latestPublishedAt - operationEnd), graphAlreadyCurrent, settledMs: Math.round(settledAt - started),
        processes: timings.length, operationProcesses, graphProcesses: timings.length - operationProcesses, peakProcesses,
        webviewMessages: messages.length - beforeMessages, graphPublications: publications.length,
        branchFilterPublications: messages.slice(beforeMessages).filter(message => message.type === "branchFilterOptions").length,
        branchFilterJsonBytes: messages.slice(beforeMessages).filter(message => message.type === "branchFilterOptions")
          .reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message)), 0),
        commands, graphCommands, commandTimeMs,
        ...(process.env.GSC_BENCH_TIMELINE === "1" ? { gitTimeline: timings.map(timing => ({ command: timing.command,
          scope: timing.repoRoot === f.root ? "checkout" : "owned-worktree", elapsedMs: timing.elapsedMs,
          spawnMs: timing.syncSpawnMs, finishedAfterStartMs: Math.round(timing.finishedAtMs - started), outcome: timing.outcome,
          ...(timing.statusIndex ? { statusIndex: timing.statusIndex, statusUntracked: timing.statusUntracked, optionalLocks: timing.optionalLocks } : {}) })) } : {}),
        nodeCpuMs: Math.round((cpuUsed.user + cpuUsed.system) / 1000),
        nodeCpuScope: "benchmark Node process including Playwright transport and RSS/idle sampling", settledQuietPeriodMs: resources ? 150 : 20,
        ...(phaseResources ? { phaseResources } : {}),
        rssDeltaMiB: Math.round((settledRss - rss) / 1048576), peakRssDeltaMiB: Math.round((peakRss - rss) / 1048576), historyExact: true };
    } finally { clearInterval(rssSample); measuring = false; unobserve(); await profile?.stop(); }
  } finally { panel.dispose(); await renderer?.dispose(); await disposeWorkingTreeSnapshots(); mock.restoreAll(); }
}

/**
 * 앞선 fetch/pull이 같은 객체를 미리 받아도 fresh-history 사례가 known-history로 바뀌지 않게 한다.
 * @param f 이 실행이 소유한 저장소와 bare 원격 @param operation 독립적인 새 객체가 필요한 시나리오
 * @returns 새 객체를 원격에만 만든 fixture 사본. 측정 구간 전 실행하며 실제 사용자 저장소는 사용하지 않는다.
 */
async function isolateIncomingCommit(f: Awaited<ReturnType<typeof fixture>>, operation: Operation) {
  if (operation !== "fetch-new-history" && operation !== "pull-new-history") return f;
  const tree = (await runGit(["rev-parse", `${f.main}^{tree}`], f.remote)).trim();
  const hash = (await runGit(["-c", "user.name=Operation Fixture", "-c", "user.email=operations@example.invalid",
    "commit-tree", tree, "-p", f.main, "-m", `unseen ${operation} fixture`], f.remote,
    { env: { GIT_AUTHOR_DATE: "1700000001 +0000", GIT_COMMITTER_DATE: "1700000001 +0000" } })).trim();
  return operation === "fetch-new-history" ? { ...f, incoming: hash } : { ...f, incomingPull: hash };
}

/** 요청된 모든 작업을 동일한 fixture 규모로 실행하고 결과 외의 임시 파일/프로세스를 남기지 않는다. */
async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-operation-matrix-"));
  let stopMonitor: (() => void) | undefined;
  let resources: GraphPhaseResources | undefined;
  try {
    if (process.env.GSC_BENCH_PHASE_RESOURCES === "1") resources = await GraphPhaseResources.create(directory);
    const f = await fixture(directory, process.env.GSC_BENCH_BORROWED_FIXTURE), results = [];
    if (process.env.GSC_BENCH_MONITOR_POLICY === "1") stopMonitor = setOwnedFsmonitorPolicy(() => undefined);
    const selected = process.env.GSC_BENCH_OPERATIONS?.split(",") as Operation[] | undefined;
    const primePublishedPush = process.env.GSC_BENCH_PRIME_CENSORED_PUSH === "1";
    assert.ok(!primePublishedPush || (selected?.[0] === "initial" && !selected.includes("push")),
      "Censored baseline priming is only allowed after initial and must not stand in for a measured push");
    const operations = selected ?? OPERATIONS, turnGate = BenchmarkTurnGate.fromEnvironment();
    await turnGate?.ready(operations);
    for (const [index, operation] of operations.entries()) {
      await turnGate?.wait(index, operation);
      console.error(`Measuring ${operation}...`);
      const result = await measure(f, operation, resources); results.push(result);
      if (turnGate) { await gitProcesses.dispose(); await turnGate.complete(index, result); }
      // 오래 걸리는 원시 Git 사례를 중지해도 이미 끝난 검증 결과는 완성 결과와 구분해 보존한다.
      if (process.env.GSC_BENCH_CHECKPOINTS === "1" && process.argv[2]) {
        await writeFile(process.argv[2] + ".partial.json", JSON.stringify({ partial: true,
          source: benchmarkSource, environmentKeys: Object.keys(process.env).length, results }) + "\n");
      }
      if (primePublishedPush && operation === "initial") {
        // 원래 push의 중단 표본은 따로 보존한다. 후속 비교만 완료 후와 같은 ref/upstream 조건으로 맞춘다.
        assert.equal((await runGit(["remote", "get-url", "--push", "origin"], f.root)).trim(), f.remote);
        await runGit(["switch", "-qC", "bench-push", f.pr], f.root);
        await runGit(["push", "--set-upstream", "origin", "bench-push:refs/heads/bench-push"], f.root);
        console.error("Primed the censored push outside measured phases; it is not a completed application push sample.");
      }
    }
    const result = { version: JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")).version,
      source: benchmarkSource, environmentKeys: Object.keys(process.env).length,
      fixture: { files: f.files, commits: f.depth, branches: f.branches, sharedUpstreamBranches: f.sharedUpstreamBranches,
        network: "local-bare-only", monitorPolicy: !!stopMonitor, pushThresholdBytes: PUSH_THRESHOLD,
        ...(primePublishedPush ? { primedCensoredPushOutsideMeasurement: true } : {}) }, results };
    const output = process.argv[2];
    if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } finally { await resources?.dispose(); stopMonitor?.(); await disposeWorkingTreeSnapshots(); await gitProcesses.dispose(); await rm(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
