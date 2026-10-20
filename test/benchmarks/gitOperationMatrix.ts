// 실제 서비스의 준비/쓰기/Graph 최신 게시/후속 조회 비용을 사용자 저장소 없이 비교한다.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { runGit, runGitWithInput } from "../../src/git/gitExec";
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

type Operation = "initial" | "push" | "push-tracked" | "pull" | "pull-new-history" | "fetch" | "fetch-new-history" | "rebase" | "merge" | "merge-no-ff" | "pr-squash-cherry-pick" | "pr-cherry-pick" | "cherry-pick" | "checkout" | "checkout-unloaded" | "pull-known-history" | "fetch-known-history" | "fetch-no-change";
const OPERATIONS: Operation[] = ["push", "pull", "fetch", "rebase", "merge", "pr-squash-cherry-pick", "pr-cherry-pick", "cherry-pick", "checkout"];
const PUSH_THRESHOLD = process.env.GSC_BENCH_PUSH_THRESHOLD_BYTES === undefined ? undefined : Number(process.env.GSC_BENCH_PUSH_THRESHOLD_BYTES);
assert.ok(PUSH_THRESHOLD === undefined || (Number.isFinite(PUSH_THRESHOLD) && PUSH_THRESHOLD >= 0), "Push threshold must be a non-negative byte count");

/** 행 순서와 무관하게 실제 HEAD·부모·ref와 최종 local-only 표시까지 같은 게시를 식별한다. */
function graphSignature(commits: readonly Commit[]): string {
  return JSON.stringify(commits.map(commit => [commit.hash, commit.parents, [...new Set(commit.refs)].sort(), [...commit.localOnlyBranches ?? []].sort()])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

/** benchmark 밖의 저장소를 입력받지 않고 고정된 트리/히스토리/branch 수의 fixture만 생성한다. */
async function fixture(directory: string) {
  const root = path.join(directory, "repository"), remote = path.join(directory, "remote.git");
  await mkdir(root); await mkdir(path.join(directory, "hooks"));
  await runGit(["-c", "init.templateDir=", "init", "-q", "--initial-branch=main"], root);
  for (const [key, value] of Object.entries({ "user.name": "Operation Fixture", "user.email": "operations@example.invalid",
    "core.fsmonitor": "false", "core.hooksPath": path.join(directory, "hooks"), "commit.gpgSign": "false", "push.default": "simple" })) {
    await runGit(["config", key, value], root);
  }
  const files = Number(process.env.GSC_BENCH_FILES || 1000), depth = Number(process.env.GSC_BENCH_COMMITS || 1000);
  const branches = Number(process.env.GSC_BENCH_BRANCHES || 100);
  assert.ok([files, depth, branches].every(value => Number.isSafeInteger(value) && value > 0));
  let nextMark = 1;
  const data: string[] = ["blob", `mark :${nextMark++}`, "data 13", "fixture data\n"];
  const marks: number[] = [];
  /** fast-import의 각 commit을 인자로 고정해 fixture 생성에 수천 Git 프로세스를 만들지 않는다. */
  const addCommit = (ref: string, parent: number | undefined, name: string, changes: string[] = []) => {
    const mark = nextMark++; marks.push(mark);
    data.push(`commit refs/heads/${ref}`, `mark :${mark}`, "committer Operation Fixture <operations@example.invalid> 1700000000 +0000",
      `data ${Buffer.byteLength(name)}`, name, ...(parent ? [`from :${parent}`] : []), ...changes, "");
    return mark;
  };
  let main = addCommit("main", undefined, "base", Array.from({ length: files }, (_, index) => `M 100644 :1 tracked-${index}.txt`));
  const history = [main];
  for (let index = 1; index < depth; index++) { main = addCommit("main", main, `main ${index}`); history.push(main); }
  for (let index = 0; index < branches; index++) addCommit(`side-${index}`, history[Math.max(0, depth - index * 3 - 1)], `side ${index}`,
    [`M 100644 :1 side-${index}.txt`]);
  const topic = addCommit("topic", history[Math.max(0, depth - 8)], "topic", ["M 100644 :1 topic.txt"]);
  let pr = main;
  const prMarks: number[] = [];
  for (let index = 0; index < 3; index++) { pr = addCommit("pr-source", pr, `PR ${index}`, [`M 100644 :1 pr-${index}.txt`]); prMarks.push(pr); }
  const oldHistory = history[Math.max(0, depth - 601)];
  data.push("reset refs/heads/old-history", `from :${oldHistory}`, "");
  const marksFile = path.join(directory, "marks");
  await runGitWithInput(["fast-import", "--quiet", `--export-marks=${marksFile}`], root, data.join("\n") + "\n");
  const objectIds = new Map((await readFile(marksFile, "utf8")).trim().split("\n").map(line => {
    const [mark, oid] = line.split(" "); return [Number(mark.slice(1)), oid];
  }));
  await runGit(["reset", "--hard", "main"], root);
  await runGit(["-c", "init.templateDir=", "init", "-q", "--bare", "--initial-branch=main", remote], directory);
  await runGit(["remote", "add", "origin", remote], root);
  await runGit(["push", "-qu", "origin", "main", "refs/heads/side-*:refs/heads/side-*"], root);
  const sharedUpstreamBranches = Number(process.env.GSC_BENCH_SHARED_UPSTREAM_BRANCHES || 0);
  assert.ok(Number.isSafeInteger(sharedUpstreamBranches) && sharedUpstreamBranches >= 0 && sharedUpstreamBranches <= branches);
  if (sharedUpstreamBranches) {
    // 각 feature는 자기 원격에도 게시돼 있지만 upstream은 main인 실제 PR 개발 형태를 재현한다.
    // branch.merge는 다중 값이므로 추가 대신 교체해 Native Git이 이전 첫 값을 선택하지 않게 한다.
    for (let index = 0; index < sharedUpstreamBranches; index++)
      await runGit(["config", "--local", "--replace-all", `branch.side-${index}.merge`, "refs/heads/main"], root);
  }
  const mainOid = objectIds.get(main)!;
  const tree = (await runGit(["rev-parse", "main^{tree}"], root)).trim();
  const incoming = (await runGit(["-c", "user.name=Operation Fixture", "-c", "user.email=operations@example.invalid",
    "commit-tree", tree, "-p", mainOid, "-m", "incoming remote change"], remote)).trim();
  // fresh pull과 fresh fetch가 같은 객체를 먼저 받아 버리지 않도록 서로 다른 미공개 commit을 만든다.
  const incomingPull = (await runGit(["-c", "user.name=Operation Fixture", "-c", "user.email=operations@example.invalid",
    "commit-tree", tree, "-p", mainOid, "-m", "incoming pull change"], remote)).trim();
  return { root, remote, main: mainOid, incoming, incomingPull, oldHistory: objectIds.get(oldHistory)!, topic: objectIds.get(topic)!, pr: objectIds.get(pr)!,
    prCommits: prMarks.map(mark => objectIds.get(mark)!), files, depth, branches, sharedUpstreamBranches };
}

/** 늦게 끝난 Graph 보조 조회까지 비용에 포함하고 다음 시나리오로 넘어가기 전에 모두 정리한다. */
async function idle(root: string, panel: any): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!gitProcesses.isBusy(root) && !panel.workingTree.state?.loading) {
      await new Promise(resolve => setTimeout(resolve, 20));
      if (!gitProcesses.isBusy(root) && !panel.workingTree.state?.loading) return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Fixture Git/Graph work did not become idle.");
}

/** 같은 선택 PR의 원본 commit만 실제 작업에 사용하도록 완전한 Git 필드를 제공한다. */
function pullRequest(f: Awaited<ReturnType<typeof fixture>>): PullRequestInfo {
  return { number: 42, title: "Operation benchmark", state: "OPEN", url: "https://example.invalid/pull/42", headRefName: "pr-source",
    headHash: f.pr, baseRefName: "main", baseHash: f.main, author: "fixture", isDraft: false,
    commentCount: 0, fileCount: 3, commitHashes: f.prCommits, commitHashesComplete: true };
}

/** 실제 서비스 성공과 Graph의 HEAD/부모/ref가 같은 Git 상태인지 확인하는 하나의 측정이다. */
async function measure(f: Awaited<ReturnType<typeof fixture>>, operation: Operation) {
  const git = (args: string[], cwd = f.root) => runGit(args, cwd);
  await git(["switch", "-qC", `bench-${operation}`, operation === "push" || operation === "push-tracked" ? f.pr : f.main]);
  await git(["update-ref", "refs/heads/main", f.main], f.remote);
  if (operation === "push-tracked") {
    // 이름이 같은 기존 upstream을 고정해 새 브랜치 publish와 일반 push 준비 경로를 분리한다.
    await git(["update-ref", `refs/heads/bench-${operation}`, f.main], f.remote);
    await git(["update-ref", `refs/remotes/origin/bench-${operation}`, f.main]);
    await git(["config", `branch.bench-${operation}.remote`, "origin"]);
    await git(["config", `branch.bench-${operation}.merge`, `refs/heads/bench-${operation}`]);
  }
  if (operation === "pull" || operation === "pull-known-history" || operation === "pull-new-history") {
    await git(["config", `branch.bench-${operation}.remote`, "origin"]);
    await git(["config", `branch.bench-${operation}.merge`, "refs/heads/main"]);
    await git(["update-ref", "refs/heads/main", operation === "pull-new-history" ? f.incomingPull : f.incoming], f.remote);
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
  const getLocalOnlyMap = cache.getMap.bind(cache);
  mock.method(cache, "getMap", async () => {
    try { return await getLocalOnlyMap(); } catch (error) {
      localOnlyFailures.push(error instanceof Error ? error.message : String(error)); throw error;
    }
  });
  try {
    if (renderer) await renderer.mount(surface.webview.html);
    if (operation !== "initial") { assert.equal(await panel.runDirectGraph("ready"), true); await idle(f.root, panel); }
    // Graph 행에서 checkout하는 일반 경로와 페이지 밖의 오래된 topic 이동을 별도 측정한다.
    const loadedTarget = operation === "checkout" && process.env.GSC_BENCH_CHECKOUT_LOADED_TARGET === "1";
    const visibleHashes = new Set<string>(panel.commits.map((commit: Commit) => commit.hash));
    const previousHead = panel.lastLocalBranches.find((branch: { current: boolean }) => branch.current)?.hash;
    const checkoutTarget: string | undefined = loadedTarget
      ? panel.lastLocalBranches.find((branch: { current: boolean; hash: string }) => !branch.current && branch.hash !== previousHead && visibleHashes.has(branch.hash))?.name
      : operation === "checkout-unloaded" ? "old-history" : "topic";
    assert.ok(checkoutTarget, "Loaded checkout fixture needs an actual visible local branch tip");
    if (operation === "checkout-unloaded") assert.equal(visibleHashes.has(f.oldHistory), false, "Unloaded checkout requires a deeper fixture than the loaded Graph page");
    const initialSignature = graphSignature(panel.commits);
    const timings: GitExecutionTiming[] = [];
    const unobserve = setGitExecutionObserver(timing => timings.push(timing));
    const active = new Set<number>(); let peakProcesses = 0;
    const register = gitProcesses.register.bind(gitProcesses), closed = gitProcesses.closed.bind(gitProcesses);
    mock.method(gitProcesses, "register", (...args: Parameters<typeof register>) => {
      const id = register(...args); active.add(id); peakProcesses = Math.max(peakProcesses, active.size); return id;
    });
    mock.method(gitProcesses, "closed", async (id: number) => { try { await closed(id); } finally { active.delete(id); } });
    const profile = await startNodeCpuProfile(operation);
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
        case "rebase": assert.equal((await new BranchOperationService(f.root).rebaseMerge("topic")).status, "completed"); break;
        case "merge": assert.equal((await new BranchOperationService(f.root).squashMerge("topic")).status, "completed"); break;
        case "merge-no-ff": await git(["merge", "--no-ff", "--no-edit", "topic"]); break;
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
      await idle(f.root, panel);
      const settledAt = performance.now(), settledRss = process.memoryUsage.rss();
      clearInterval(rssSample); measuring = false;
      const cpuUsed = process.cpuUsage(cpu), commands: Record<string, number> = {}, graphCommands: Record<string, number> = {}, commandTimeMs: Record<string, number> = {};
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
      const actual = await new GitLogService(f.root).getCommitPage(panel.commits.length, 0, [], false);
      const visibleHead = actual.find(commit => commit.refs.includes("HEAD"))?.hash;
      if (visibleHead !== undefined) assert.equal(visibleHead, head);
      assert.equal(panel.commits.find((commit: Commit) => commit.refs.includes("HEAD"))?.hash, visibleHead);
      const values = (commits: Commit[]) => new Map(commits.map(commit => [commit.hash, { parents: commit.parents, refs: [...new Set(commit.refs)].sort() }]));
      assert.deepEqual(values(panel.commits), values(actual));
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
        panel.lastLocalBranches.find((branch: { current: boolean }) => branch.current)?.name);
      if (renderer && operation === "checkout" && process.env.GSC_BENCH_SCREENSHOTS) await renderer.capture(process.env.GSC_BENCH_SCREENSHOTS);
      return { operation, operationMs: Math.round(operationEnd - started), graphMs: Math.round(graphEnd - operationEnd),
        branchDetailsReads: branchReads.map(read => ({ startedAfterOperationMs: read.startedAt - operationEndedAt,
          durationMs: read.finishedAt === undefined ? null : read.finishedAt - read.startedAt,
          firstFrameBeforeDetails: !!liveRenderer?.mutationToFrameMs && read.finishedAt !== undefined &&
            operationEndedAt + liveRenderer.mutationToFrameMs < read.finishedAt })),
        ...(operation === "checkout" ? { checkoutTargetScope: loadedTarget ? "loaded-page" : "topic" } : {}),
        ...(liveRenderer ? { liveRenderer } : {}),
        latestGraphPublishedMs: latestPublishedAt === undefined ? null : Math.round(latestPublishedAt - operationEnd), graphAlreadyCurrent, settledMs: Math.round(settledAt - started),
        processes: timings.length, operationProcesses, graphProcesses: timings.length - operationProcesses, peakProcesses,
        webviewMessages: messages.length - beforeMessages, graphPublications: publications.length,
        branchFilterPublications: messages.slice(beforeMessages).filter(message => message.type === "branchFilterOptions").length,
        branchFilterJsonBytes: messages.slice(beforeMessages).filter(message => message.type === "branchFilterOptions")
          .reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message)), 0),
        commands, graphCommands, commandTimeMs, nodeCpuMs: Math.round((cpuUsed.user + cpuUsed.system) / 1000),
        nodeCpuScope: "benchmark Node process including Playwright transport and RSS/idle sampling",
        rssDeltaMiB: Math.round((settledRss - rss) / 1048576), peakRssDeltaMiB: Math.round((peakRss - rss) / 1048576), historyExact: true };
    } finally { clearInterval(rssSample); measuring = false; unobserve(); await profile?.stop(); }
  } finally { panel.dispose(); await renderer?.dispose(); await disposeWorkingTreeSnapshots(); mock.restoreAll(); }
}

/** 요청된 모든 작업을 동일한 fixture 규모로 실행하고 결과 외의 임시 파일/프로세스를 남기지 않는다. */
async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-operation-matrix-"));
  let stopMonitor: (() => void) | undefined;
  try {
    const f = await fixture(directory), results = [];
    if (process.env.GSC_BENCH_MONITOR_POLICY === "1") stopMonitor = setOwnedFsmonitorPolicy(() => undefined);
    const selected = process.env.GSC_BENCH_OPERATIONS?.split(",") as Operation[] | undefined;
    for (const operation of selected ?? OPERATIONS) {
      console.error(`Measuring ${operation}...`);
      results.push(await measure(f, operation));
    }
    const result = { version: JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")).version,
      source: process.env.GSC_BENCH_SOURCE ? JSON.parse(process.env.GSC_BENCH_SOURCE) : undefined,
      fixture: { files: f.files, commits: f.depth, branches: f.branches, sharedUpstreamBranches: f.sharedUpstreamBranches,
        network: "local-bare-only", monitorPolicy: !!stopMonitor, pushThresholdBytes: PUSH_THRESHOLD }, results };
    const output = process.argv[2];
    if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } finally { stopMonitor?.(); await disposeWorkingTreeSnapshots(); await gitProcesses.dispose(); await rm(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
