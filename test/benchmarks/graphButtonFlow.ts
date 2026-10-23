// 실제 웹뷰 버튼 → 등록된 VS Code 메시지 callback → Native Git → 최종 Graph frame을 연결한다.
import assert from "node:assert/strict";
import { benchmarkOverrides as mock } from "../helpers/benchmarkOverrides";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "../../src/git/gitExec";
import { GitLogService } from "../../src/git/gitLogService";
import { RebaseService } from "../../src/git/rebaseService";
import { captureRebaseCheckout } from "../../src/git/rebasePlanSafety";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { disposeWorkingTreeSnapshots, setWorkingTreeSnapshotPolicy } from "../../src/git/workingTreeSnapshot";
import { logInfo } from "../../src/ui/outputLog";
import type { Commit } from "../../src/graph/graphTypes";
import type { GraphRenderPerformance } from "../../src/webview/graphProtocol";
import { createGitOperationFixture } from "../helpers/gitOperationFixture";
import { createOperationGraphPanel } from "../helpers/graphOperationPanel";
import { GraphLiveRenderer } from "../helpers/graphLiveRenderer";
import { readNativeGraphExpectation, readNativeRemoteTagExpectation } from "../helpers/graphNativeExpectation";
import { createGraphButtonDiagnostics, traceLocalOnlySnapshot } from "../helpers/graphButtonDiagnostics";
import { createPromisorPushFixture, missingPromisorBlobs, promisorPackState } from "../helpers/promisorPushFixture";
import { window, __errorMessages, __outputLines, __resetWindowMessages, __setQuickPickResult } from "../helpers/vscodeMock";
import { installPrButtonFixture, verifyPrButtonResult } from "../helpers/prButtonFixture";
import { probePrNotice } from "../helpers/prNoticeProbe";
import { GraphPhaseResources } from "../helpers/graphPhaseResources";
import { setOwnedFsmonitorPolicy } from "../../src/git/ownedFsmonitor";
import { startNodeCpuProfile, type NodeCpuProfile } from "../helpers/nodeCpuProfile";
import { BenchmarkTurnGate } from "../helpers/benchmarkTurnGate";
import { prepareCommitButtonExpectation, verifyCommitButtonResult } from "../helpers/graphCommitButtonFixture";

type Operation = "push" | "pull" | "fetch" | "interactive-rebase" | "fetch-no-change" | "checkout" | "pr-squash-cherry-pick" | "pr-cherry-pick"
  | "branch-squash-merge" | "branch-rebase-merge" | "cherry-pick";
const operations: Operation[] = ["push", "pull", "fetch", "interactive-rebase"];
const supportedOperations: Operation[] = [...operations, "fetch-no-change", "checkout", "pr-squash-cherry-pick", "pr-cherry-pick",
  "branch-squash-merge", "branch-rebase-merge", "cherry-pick"];
const benchmarkSource = JSON.parse(process.env.GSC_BENCH_SOURCE!);
// source 선택용 값은 Native 명령의 환경 입력에서 제외한다.
delete process.env.GSC_BENCH_SOURCE_REF; delete process.env.GSC_BENCH_SOURCE;

/** 예외나 무한 대기를 성공으로 세지 않고 기다리던 대상을 제한 시간 오류에 남긴다. */
async function within<T>(promise: Promise<T>, label: string, milliseconds = 60000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

/** 연속 게시가 안정된 뒤 늦은 status나 오래된 frame을 최종 상태로 오인하지 않게 한다. */
async function settle(root: string, panel: any, messages: readonly unknown[], metadataReady: () => boolean,
  readiness?: () => Record<string, unknown>): Promise<void> {
  // 제품의 Native 조회 제한은 30초다. 준비 대기가 먼저 status를 취소하지 않게 여유를 주되 실패는 그대로 거부한다.
  const deadline = Date.now() + 45000;
  /** ready가 비동기로 시작한 PR/stack 조회까지 끝나야 초기 Native 작업이 클릭 구간에 섞이지 않는다. */
  const initialReadsReady = () => metadataReady() && !messages.reduce((busy: boolean, value) => {
    const message = value as { type?: string; key?: string; busy?: boolean };
    return message.type === "graphBusy" && message.key === "graph-pr-list" ? !!message.busy : busy;
  }, false);
  while (Date.now() < deadline) {
    const count = messages.length;
    if (!gitProcesses.isBusy(root) && !panel.loading && !panel.workingTree.state?.loading && initialReadsReady()) {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (!gitProcesses.isBusy(root) && !panel.loading && !panel.workingTree.state?.loading && initialReadsReady() && messages.length === count) return;
    } else await new Promise(resolve => setTimeout(resolve, 20));
  }
  const state = { root, gitBusy: gitProcesses.isBusy(root), loading: panel.loading,
    workingTreeLoading: panel.workingTree.state?.loading, metadataReady: metadataReady(), initialReadsReady: initialReadsReady(),
    ...readiness?.(), latestMessages: messages.slice(-8).map(value => {
      const message = value as { type?: string; key?: string; busy?: boolean };
      return { type: message.type, key: message.key, busy: message.busy };
    }), latestOutput: __outputLines.slice(-14) };
  // 실패 원문은 큰 fixture 정리가 끝나기 전에 남겨, cleanup 대기를 실행 중인 Git으로 오해하지 않게 한다.
  console.error("Button flow readiness timeout", JSON.stringify(state));
  throw new Error("Button flow did not settle: " + JSON.stringify(state));
}

/** 정확한 HEAD/ref/부모/local-only 상태를 가진 최종 게시만 선택한다. */
function signature(commits: readonly Commit[]): string {
  return JSON.stringify(commits.map(commit => [commit.hash, commit.parents, [...new Set(commit.refs)].sort(), [...commit.localOnlyBranches ?? []].sort()])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

/** 실제 push URL과 fetch promisor를 분리한 blobless fixture를 기존 버튼 계약에 맞춘다. */
async function partialPushFixture(directory: string) {
  const promisorBlobBytes = Number(process.env.GSC_BENCH_PROMISOR_BLOB_BYTES || 1024 * 1024);
  assert.ok(Number.isSafeInteger(promisorBlobBytes) && promisorBlobBytes > 0 && promisorBlobBytes <= 8 * 1024 * 1024);
  const f = await createPromisorPushFixture(directory, { blobCount: 8, blobBytes: promisorBlobBytes });
  await runGit(["remote", "set-url", "--push", "origin", f.receiver], f.root);
  return { ...f, remote: f.receiver, main: f.base, pr: f.head, prCommits: f.commits,
    incoming: f.head, incomingPull: f.head, oldHistory: f.base, topic: f.head,
    files: 9, depth: 3, branches: 3, sharedUpstreamBranches: 0, promisorBlobBytes,
    mainBranch: "main", topicBranch: "topic", prBranch: "pr-source", oldHistoryBranch: "old-history" };
}

/**
 * 로드된 branch chip을 누르는 시나리오의 대상을 제품 렌더 전에 Native 첫 페이지로 확정한다.
 * @param fixture 소유한 합성/borrowed 저장소. 기존 topic이 보이면 그대로 사용한다.
 * @returns 동점 commit 날짜로 topic이 페이지 밖이면 같은 크기의 합성 side branch를 선택한 fixture다.
 * 준비 구간에서만 읽으며 ref·이력·날짜를 바꾸거나 제품이 고른 행으로 성공 기준을 낮추지 않는다.
 */
async function loadedCheckoutFixture<T extends { root: string; main: string; topic: string; topicBranch: string }>(fixture: T): Promise<T> {
  const hashes = new Set((await runGit(["log", "--topo-order", "--format=%H", "-n300", "--branches", "--remotes", "--tags"], fixture.root))
    .trim().split("\n"));
  if (hashes.has(fixture.topic)) return fixture;
  assert.equal(process.env.GSC_BENCH_BORROWED_FIXTURE, undefined, "A borrowed checkout needs its explicit synthetic topic in the Native page");
  const output = await runGit(["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads/side-*"], fixture.root);
  const target = output.trim().split("\n").map(line => line.split("\t"))
    .find(([name, hash]) => /^side-\d+$/.test(name) && hash !== fixture.main && hashes.has(hash));
  assert.ok(target, "The owned fixture needs a noncurrent side-branch chip in the Native first page");
  return { ...fixture, topicBranch: target[0], topic: target[1] };
}

/** 각 작업은 독립 fixture와 local bare remote만 사용하며 실제 사용자 작업트리나 외부 네트워크에 쓰지 않는다. */
async function measure(directory: string, operation: Operation, resources?: GraphPhaseResources) {
  const partial = operation === "push" && process.env.GSC_BENCH_PROMISOR_PUSH === "1";
  let f = await (partial ? partialPushFixture(directory) : createGitOperationFixture(directory, process.env.GSC_BENCH_BORROWED_FIXTURE));
  const branch = `button-${operation}`;
  const commitOperation = operation === "branch-squash-merge" || operation === "branch-rebase-merge" || operation === "cherry-pick";
  if (partial) {
    // 같은 commit에 fixture HEAD만 연결한다. switch의 Native unpack-trees 사전 fetch를 측정 준비에 섞지 않는다.
    await runGit(["update-ref", `refs/heads/${branch}`, f.pr], f.root);
    await runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], f.root);
    assert.equal(await missingPromisorBlobs(f.root, (f as Awaited<ReturnType<typeof partialPushFixture>>).blobs), 8, "Fixture branch setup must keep blobs missing");
  } else await runGit(["switch", "-qC", branch, operation === "push" || operation === "interactive-rebase" || operation === "branch-rebase-merge" ? f.pr : f.main], f.root);
  if (operation === "pull") {
    await runGit(["config", `branch.${branch}.remote`, "origin"], f.root);
    await runGit(["config", `branch.${branch}.merge`, `refs/heads/${f.mainBranch}`], f.root);
    // borrowed catalog에는 합성 main의 tracking ref가 없다. 아직 수신하지 않은 incoming은 그대로 두고
    // 원래 게시된 main만 재현해 일반 pull이 upstream 설정 picker로 바뀌지 않도록 한다.
    await runGit(["update-ref", `refs/remotes/origin/${f.mainBranch}`, f.main], f.root);
    assert.equal((await runGit(["rev-parse", "--verify", "@{upstream}"], f.root)).trim(), f.main);
    await runGit(["update-ref", `refs/heads/${f.mainBranch}`, f.incomingPull], f.remote);
  }
  if (operation === "fetch") await runGit(["update-ref", "refs/heads/incoming", f.incoming], f.remote);
  // 최신 Git의 첫 fetch는 origin/HEAD를 만들 수 있다. 실제 무변경 비교는 이 초기 ref 설정 뒤에 시작한다.
  if (operation === "fetch-no-change") await runGit(["fetch", "--all", "--prune"], f.root);
  if (operation === "checkout" || commitOperation) f = await loadedCheckoutFixture(f);
  const commitExpected = commitOperation ? await prepareCommitButtonExpectation(f.root, f.topic) : undefined;
  const localHintScenario = process.env.GSC_BENCH_LOCAL_CHANGE_HINT_SCENARIO;
  assert.ok(!localHintScenario || ["known", "stale"].includes(localHintScenario));
  assert.ok(!localHintScenario || supportedOperations.includes(operation));
  const localFile = `gsc-local-hint-${localHintScenario === "stale" ? "previous" : "current"}.txt`;
  const finalLocalFile = "gsc-local-hint-current.txt", localContents = "Preserved local work for the actual button scenario.\n";
  if (localHintScenario) {
    for (const file of [localFile, finalLocalFile]) assert.equal((await runGit(["ls-tree", "--name-only", "HEAD", "--", file], f.root)).trim(), "");
    await writeFile(path.join(f.root, localFile), localContents, { flag: "wx" });
  }
  // 클릭 이후 비용만 비교하는 선택 실행에서는 UI 준비 전에도 동일한 Native 입력 검증을 한다.
  // 앱 캐시를 채우지 않지만 OS 파일 캐시는 따뜻해지므로 cold-start 성능 근거와 구분해 기록한다.
  const validatedInputBeforeGraph = process.env.GSC_BENCH_VALIDATE_INPUT_STATUS === "1";
  const validatedInputStatus = validatedInputBeforeGraph
    ? (await runGit(["status", "--porcelain=v1"], f.root, { readTimeoutMs: 600000 })).trim() : undefined;
  assert.equal((await runGit(["remote", "get-url", "--push", "origin"], f.root)).trim(), f.remote, "Only the owned local bare receiver is permitted");
  __resetWindowMessages();
  mock.method(window, "showWarningMessage", async (_message: string, ...choices: unknown[]) => choices.find(choice => typeof choice === "string"));
  __setQuickPickResult(items => items.find((item: any) => operation === "branch-squash-merge" ? item.action === "squashMerge"
    : operation === "branch-rebase-merge" ? item.action === "rebaseMerge" : item?.kind !== -1));
  const prOperation = operation === "pr-squash-cherry-pick" || operation === "pr-cherry-pick";
  const prListCount = prOperation || process.env.GSC_BENCH_PR_LIST_ALL_OPERATIONS === "1"
    ? await installPrButtonFixture(f, Number(process.env.GSC_BENCH_PR_LIST_SIZE || 1)) : undefined;
  const noticeHoldMs = Number(process.env.GSC_BENCH_PR_NOTICE_HOLD_MS || 0);
  const notice = prOperation ? probePrNotice(noticeHoldMs) : undefined;
  const stopMonitor = process.env.GSC_BENCH_MONITOR_POLICY === "1" ? setOwnedFsmonitorPolicy(() => undefined) : undefined;
  const stopSnapshotPolicy = setWorkingTreeSnapshotPolicy(() => ({ useCache: true, cancelUnused: true }), logInfo);
  const renderer = await GraphLiveRenderer.create(), service = new GitLogService(f.root);
  let measuring = false;
  const publicationDiagnostics = process.env.GSC_BENCH_BUTTON_DIAGNOSTICS === "1";
  const publications: { at: number; signature: string; performance?: GraphRenderPerformance; changes?: Record<string, unknown> }[] = [];
  const transport = createOperationGraphPanel({ mock } as any, service, message => {
    renderer.post(message);
    if (measuring && (message.type === "graph" || message.type === "graphDelta")) publications.push({
      at: performance.now(), signature: signature(transport.panel.commits), performance: message.performance,
      ...(publicationDiagnostics ? { changes: { type: message.type,
        rows: message.type === "graph" ? message.data.rows.length : message.delta.rows.length,
        rowUpdates: message.type === "graphDelta" ? message.delta.rowUpdates.length : undefined,
        edges: message.type === "graph" ? message.data.edges.length : message.delta.edges.length,
        edgeUpdates: message.type === "graphDelta" ? message.delta.edgeUpdates.length : undefined,
        workingTreePending: message.state?.workingTree?.loading === true,
        branchDetailsPending: message.state?.branchDetails?.loading === true } } : {}) });
  });
  const { panel, messages, surface, receiveMessage } = transport;
  const processPhases = process.env.GSC_BENCH_PROCESS_PHASES === "1";
  const diagnostics = process.env.GSC_BENCH_BUTTON_DIAGNOSTICS === "1" || processPhases
    ? createGraphButtonDiagnostics({ mock } as any, { filesystem: !processPhases }) : undefined;
  const markerFailures: string[] = [], cache: any = (service as any).localOnlyBranchCache;
  const localOnlyDiagnostics = process.env.GSC_BENCH_LOCAL_ONLY_DIAGNOSTICS === "1" ? traceLocalOnlySnapshot({ mock } as any, cache) : undefined;
  const markerRead = typeof cache.getReadOnlyMap === "function" ? "getReadOnlyMap" : "getMap";
  const getMarkers = cache[markerRead].bind(cache);
  let pendingMarkers = 0;
  mock.method(cache, markerRead, async () => {
    pendingMarkers++;
    try { return await getMarkers(); } catch (error) {
      markerFailures.push(error instanceof Error ? error.message : String(error)); throw error;
    } finally { pendingMarkers--; }
  });
  /** 실제 callback이 시작한 metadata만 기다리고 별도의 사전 계산으로 측정을 예열하지 않는다. */
  const metadataReady = () => pendingMarkers === 0 && (!cache.remoteReady || !!cache.completed || markerFailures.length > 0);
  /** 준비 대기가 실패했을 때 캐시 상태만 읽는다. 새 Native 조회나 예열은 시작하지 않는다. */
  const readiness = () => ({ pendingMarkers, remoteReady: cache.remoteReady, completed: !!cache.completed, markerFailures });
  let ready!: () => void, actionDone!: () => void, actionFailed!: (error: unknown) => void;
  const initialized = new Promise<void>(resolve => { ready = resolve; });
  const action = new Promise<void>((resolve, reject) => { actionDone = resolve; actionFailed = reject; });
  void action.catch(() => undefined);
  const requestType = prOperation ? "pullRequestAction" : operation === "interactive-rebase" ? "runGraphRebase" : operation === "fetch-no-change" ? "fetch"
    : operation === "checkout" || operation.startsWith("branch-") ? "branchAction" : operation === "cherry-pick" ? "cherryPick" : operation;
  let receivedAt: number | undefined, completedAt: number | undefined;
  let noticeAtCompletion: ReturnType<ReturnType<typeof probePrNotice>["handlerState"]> | undefined;
  renderer.onMessage(async message => {
    try {
      if (message.type === requestType) { assert.equal(receivedAt, undefined, "One click must send one mutation request"); receivedAt = performance.now(); }
      await receiveMessage(message);
      if (message.type === "ready") ready();
      if (message.type === requestType) { completedAt = performance.now(); noticeAtCompletion = notice?.handlerState(); actionDone(); }
    } catch (error) { actionFailed(error); throw error; }
  });
  let nodeProfile: NodeCpuProfile | undefined, rendererProfile: NodeCpuProfile | undefined;
  let lastSourceWriteEpoch: number | undefined;
  const stopWriteObservation = gitProcesses.onDidFinishWrite(root => {
    if (measuring && path.resolve(root) === path.resolve(f.root)) lastSourceWriteEpoch = Date.now();
  });
  try {
    await renderer.mount(surface.webview.html);
    await within(initialized, "actual ready callback");
    await settle(f.root, panel, messages, metadataReady, readiness);
    assert.equal(panel.workingTree.state, undefined, "Initial working-tree status must finish successfully, not become unavailable or paused");
    assert.ok(panel.commits.length > 0); assert.deepEqual(__errorMessages, []);
    if (operation === "checkout" || commitOperation) assert.ok(panel.commits.some((commit: Commit) => commit.hash === f.topic), "The action target must be in the actual loaded page");
    const initialRefs = operation === "fetch-no-change" ? await runGit(["for-each-ref", "--format=%(refname) %(objectname)"], f.root) : undefined;
    let initialStatus = partial || localHintScenario ? (await runGit(["status", "--porcelain=v1"], f.root)).trim() : "";
    if (validatedInputBeforeGraph) assert.equal(initialStatus, validatedInputStatus, "Graph initialization must preserve the independently validated Native input");
    const originalIndex = partial ? await readFile(path.join(f.root, ".git/index")) : undefined;
    const initialPacks = partial ? await promisorPackState(f.root) : undefined;
    if (partial) assert.equal(await missingPromisorBlobs(f.root, (f as Awaited<ReturnType<typeof partialPushFixture>>).blobs), 8, "Initial Graph must not hydrate blobs");
    if (prListCount) {
      await renderer.clickControl("#graph-pr-list");
      assert.equal(messages.filter(message => message.type === "pullRequestOverview").at(-1)?.overview.pullRequests.length, prListCount);
      assert.equal(await renderer.countElements("#detail .pr-card"), prListCount, "Actual dense PR list must be rendered before measuring");
    }
    if (operation === "interactive-rebase") {
      const checkout = await captureRebaseCheckout(f.root), commits = await new RebaseService(f.root).getCommits(f.main, false, false);
      renderer.post({ type: "graphRebasePlan", plan: { branch, base: f.main, root: false, baseReason: "selected", checkout, commits,
        items: [{ hash: f.prCommits[0], action: "reword", message: "rewritten click\n\nfirst body" },
          { hash: f.prCommits[1], action: "squash", message: "combined click\n\ncombined body" }, { hash: f.prCommits[2], action: "pick" }] } });
    }
    if (localHintScenario === "stale") {
      // UI가 기억한 경로를 정리하고 다른 위치에 편집을 만든다. 새 경로는 제품의 상태 캐시에 주입하지 않는다.
      await rm(path.join(f.root, localFile));
      await writeFile(path.join(f.root, finalLocalFile), localContents, { flag: "wx" });
      initialStatus = (await runGit(["status", "--porcelain=v1"], f.root)).trim();
    }
    // 초기 Graph/PR/계획의 남은 frame이 첫 클릭의 CPU·시간으로 섞이지 않도록 실제 renderer까지 기다린다.
    await renderer.waitForPendingFrame();
    const hintLogStart = __outputLines.length;
    const initial = signature(panel.commits), beforeMessages = messages.length, timings: GitExecutionTiming[] = [];
    const profiling = !!(process.env.GSC_BENCH_CPU_PROFILE_DIR || process.env.GSC_BENCH_RENDERER_PROFILE_DIR);
    assert.ok(!resources || !profiling, "CPU sampling and resource counters require separate runs");
    if (profiling) {
      nodeProfile = await startNodeCpuProfile(operation);
      rendererProfile = await renderer.startCpuProfile(operation);
    }
    await resources?.begin(renderer,operation);
    const stop = setGitExecutionObserver(timing => timings.push(timing));
    const started = performance.now(), clickedAt = Date.now(), cpu = process.cpuUsage();
    measuring = true;
    diagnostics?.start();
    try {
      if (operation === "interactive-rebase") await renderer.clickNamedControl("Start rebase");
      else if (prOperation) await renderer.clickControl(`#pr-op-42-${operation === "pr-squash-cherry-pick" ? "squash" : "rebase"}`);
      else if (operation === "checkout" || operation.startsWith("branch-")) await renderer.clickControl(`.ref[data-checkout-branch="${f.topicBranch}"]`);
      else if (operation === "cherry-pick") {
        await renderer.clickControl(`.row[data-hash="${f.topic}"] .subject`, "right");
        await renderer.clickMenuItem("Cherry-pick Commit");
      }
      else if (operation === "fetch-no-change") await renderer.clickControl("#fetch-graph");
      else await renderer.clickControl(`#${operation}-graph`);
      const actionTimeout = Number(process.env.GSC_BENCH_ACTION_TIMEOUT_MS || 60000);
      assert.ok(Number.isSafeInteger(actionTimeout) && actionTimeout > 0 && actionTimeout <= 15 * 60 * 1000);
      await within(action, `${requestType} handler`, actionTimeout);
      await settle(f.root, panel, messages, metadataReady, readiness);
      assert.equal(panel.workingTree.state, undefined, "Final working-tree status must finish successfully, not hide a Native read failure");
      // 실제 버튼 검증도 사후 Native 조회 전에 마지막 화면 frame을 확정한다.
      await renderer.waitForPendingFrame(publications.at(-1)?.performance);
      measuring = false; stop();
      const diagnostic = diagnostics?.finish();
      const settled = performance.now(), used = process.cpuUsage(cpu), final = signature(panel.commits);
      const phaseResources=await resources?.finish(renderer,used,timings.length);
      if (profiling) await Promise.all([nodeProfile?.stop(), rendererProfile?.stop()]);
      assert.ok(receivedAt !== undefined && completedAt !== undefined);
      assert.deepEqual(__errorMessages, [], "The actual message handler must not hide a Git failure in an error toast");
      assert.deepEqual(markerFailures, [], "A swallowed marker error is not a correct completed button flow");
      const head = (await runGit(["rev-parse", "HEAD"], f.root)).trim();
      const fresh = await readNativeGraphExpectation(f.root, panel.commits.length);
      const nativeSignature = signature(fresh);
      if (final !== nativeSignature) {
        const actual = new Map<string, unknown[]>(JSON.parse(final).map((value: unknown[]) => [String(value[0]), value]));
        const expected = new Map<string, unknown[]>(JSON.parse(nativeSignature).map((value: unknown[]) => [String(value[0]), value]));
        console.error("Native metadata mismatch", JSON.stringify({ actual: actual.size, expected: expected.size,
          differences: [...new Set([...actual.keys(), ...expected.keys()])].filter(hash => JSON.stringify(actual.get(hash)) !== JSON.stringify(expected.get(hash)))
            .slice(0, 8).map(hash => ({ actual: actual.get(hash), expected: expected.get(hash) })),
          messages: messages.slice(beforeMessages).map(message => message.type) }));
      }
      assert.ok(final === nativeSignature, "Final metadata must match a fresh Native snapshot, including local-only markers");
      if (operation === "push") assert.equal((await runGit(["rev-parse", `refs/heads/${branch}`], f.remote)).trim(), f.pr);
      if (operation === "pull") assert.equal(head, f.incomingPull);
      if (operation === "fetch") assert.equal((await runGit(["rev-parse", "refs/remotes/origin/incoming"], f.root)).trim(), f.incoming);
      if (operation === "fetch-no-change") assert.equal(await runGit(["for-each-ref", "--format=%(refname) %(objectname)"], f.root), initialRefs, "Unchanged fetch fixture must preserve every Native ref");
      if (operation === "checkout") assert.equal(head, f.topic);
      if (commitExpected && commitOperation) await verifyCommitButtonResult(f.root, operation, commitExpected);
      if (prOperation) await verifyPrButtonResult(f, operation === "pr-squash-cherry-pick");
      if (operation === "interactive-rebase") {
        const bodies = (await runGit(["log", "--reverse", "--format=%B%x00", `${f.main}..HEAD`], f.root)).split("\0").map(value => value.trim()).filter(Boolean);
        assert.deepEqual(bodies, ["combined click\n\ncombined body", "PR 2"]);
        assert.equal((await runGit(["rev-parse", "HEAD^{tree}"], f.root)).trim(), (await runGit(["rev-parse", `${f.pr}^{tree}`], f.root)).trim());
      }
      assert.equal((await runGit(["status", "--porcelain=v1"], f.root)).trim(), partial || localHintScenario ? initialStatus : "");
      if (localHintScenario) assert.equal(await readFile(path.join(f.root, finalLocalFile), "utf8"), localContents,
        "A faster preflight must not consume or lose local changes");
      if (partial) assert.deepEqual(await readFile(path.join(f.root, ".git/index")), originalIndex);
      const promisor = partial ? { initialPacks, finalPacks: await promisorPackState(f.root),
        missingBlobs: await missingPromisorBlobs(f.root, (f as Awaited<ReturnType<typeof partialPushFixture>>).blobs), localChangesPreserved: true } : undefined;
      const publication = publications.slice().reverse().find(value => value.at >= started && value.signature === final);
      assert.ok(publication || initial === final, "Changed final state must have a publication caused after the click");
      const frame = await renderer.verify(panel.commits, head, clickedAt, initial === final, publication?.performance,
        operation === "checkout" ? f.topicBranch : branch, await readNativeRemoteTagExpectation(f.root));
      if (localHintScenario) {
        assert.equal(await renderer.countElements("#graph-content > .row.ongoing-row"), 1);
        assert.equal(await renderer.countElements("#graph-content > .row.staged-row"), 1);
      }
      // 실제 선택/세 viewport 촬영은 시간·CPU 창과 독립 Native oracle이 모두 끝난 뒤에만 실행한다.
      if (process.env.GSC_BENCH_SCREENSHOT_DIR) await renderer.capture(path.join(process.env.GSC_BENCH_SCREENSHOT_DIR, operation));
      return { operation, transport: "actual-rendered-button-and-registered-message-callback", fixture: { files: f.files, commits: f.depth, branches: f.branches,
        monitorPolicy: !!stopMonitor,
        ...(validatedInputBeforeGraph ? { nativeInputValidatedBeforeGraph: true,
          inputScope: "Native status validated before Graph mount; normal initial Graph/PR load precedes click; no previous-process app caches; filesystem warm, not cold-start timing" } : {}),
        ...(process.env.GSC_BENCH_FIXTURE_MANIFEST ? { ownedInputReused: true } : {}),
        ...(partial ? { promisorBlobBytes: (f as Awaited<ReturnType<typeof partialPushFixture>>).promisorBlobBytes } : {}),
        ...(localHintScenario ? { localHintScenario } : {}),
        ...(prListCount ? { pullRequests: prListCount } : {}) },
        clickToRequestMs: Math.round(receivedAt - started), handlerMs: Math.round(completedAt - receivedAt),
        clickToFirstFrameMs: frame.mutationToFrameMs, clickToFinalFrameMs: frame.latestMutationToFrameMs,
        ...(lastSourceWriteEpoch === undefined || frame.latestMutationToFrameMs === null ? {} : {
          lastSourceWriteAfterClickMs: lastSourceWriteEpoch - clickedAt,
          lastSourceWriteToFinalFrameMs: frame.latestMutationToFrameMs - (lastSourceWriteEpoch - clickedAt),
          lastSourceWriteScope: "Last owned Git write close in source worktree; signed frame difference, may precede cleanup" }),
        clickToSettledMs: Math.round(settled - started), nativeStateExact: true, cleanWorkingTree: initialStatus === "",
        ...(localHintScenario ? { localChangesPreserved: true, recentPathConfirmations: __outputLines.slice(hintLogStart)
          .filter(line => line.includes("working tree change confirmed from recent paths")).length,
          missedHintsWithFullScan: __outputLines.slice(hintLogStart).filter(line => line.includes("working tree change hint missed; full scan required")).length,
          compactReplayWorktreeSelections: __outputLines.slice(hintLogStart)
            .filter(line => line.includes("PR replay index-only worktree prepared")).length,
          summaryPathConfirmations: __outputLines.slice(hintLogStart)
            .filter(line => line.includes("private status summary change confirmed from recent paths")).length,
          summaryMissesWithFullScan: __outputLines.slice(hintLogStart)
            .filter(line => line.includes("private status summary hint missed; full scan required")).length } : {}),
        ...(profiling ? { instrumentedCpuProfile: true, profileScope: "actual click through settled final renderer frames; sampling overhead remains, not comparative latency" } : {}),
        nodeCpuMs: Math.round((used.user + used.system) / 1000), nodeCpuScope: "benchmark Node including Playwright transport; Git/Chromium/OS CPU excluded",
        processes: timings.length, commands: timings.map(({ command, elapsedMs, syncSpawnMs, outcome, code }) => ({ command, elapsedMs, syncSpawnMs, outcome, code })),
        graphPublications: publications.length, webviewMessages: messages.length - beforeMessages, frame,
        ...(phaseResources?{phaseResources}:{}),
        ...(noticeAtCompletion ? { notice: { modeledHoldMs: noticeHoldMs, pendingAtHandlerCompletion: noticeAtCompletion.pending,
          gitToHandlerMs: Math.round(completedAt - noticeAtCompletion.gitCompletedAt),
          gitToFinalFrameMs: frame.latestMutationToFrameMs === null ? null : Math.max(0, frame.latestMutationToFrameMs - (noticeAtCompletion.gitCompletedEpoch - clickedAt)) } } : {}),
        ...(diagnostic ? { diagnostic: { ...diagnostic, publications: publications.map(value => ({
          afterClickMs: Math.round(value.at - started), kind: value.performance?.kind, ...value.changes })) } } : {}),
        ...(promisor ? { promisor } : {}), ...(localOnlyDiagnostics ? {localOnlyDiagnostics:localOnlyDiagnostics()} : {}) };
    } finally { measuring = false; stop(); }
  } finally {
    // benchmark의 대기 제한이 끝나도 이미 시작한 Native 쓰기를 둔 채 fixture를 지우지 않는다.
    if (receivedAt !== undefined && completedAt === undefined) await action.catch(() => undefined);
    try { if (nodeProfile || rendererProfile) await Promise.all([nodeProfile?.stop(), rendererProfile?.stop()]); }
    finally { stopWriteObservation(); panel.dispose(); notice?.dispose(); await renderer.dispose(); stopMonitor?.(); await disposeWorkingTreeSnapshots(); stopSnapshotPolicy(); await gitProcesses.dispose(); mock.restoreAll(); }
  }
}

/** 모든 사례를 같은 규모로 실행하고 fixture와 browser 자원은 종료 시 회수한다. */
async function main() {
  const selected = (process.env.GSC_BENCH_OPERATIONS?.split(",") ?? operations) as Operation[];
  assert.ok(selected.length && selected.every(value => supportedOperations.includes(value)), "Unknown button operation");
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-graph-button-flow-"));
  let completed = false;
  try {
    const results = [], gate = BenchmarkTurnGate.fromEnvironment();
    await gate?.ready(selected);
    for (const [index, operation] of selected.entries()) {
      await gate?.wait(index, operation);
      const scenario = path.join(directory, operation); await mkdir(scenario);
      const resources=process.env.GSC_BENCH_PHASE_RESOURCES==="1"?await GraphPhaseResources.create(scenario):undefined;
      // 별도 진단에서만 준비 중 Git의 명령 이름·수명 결과를 즉시 기록한다. 인자·입력·출력은 남기지 않는다.
      const startup = process.env.GSC_BENCH_STARTUP_DIAGNOSTICS === "1"
        ? setGitExecutionObserver(timing => console.error("startup Git", JSON.stringify(timing))) : undefined;
      let scenarioCompleted = false;
      try{console.error(`Clicking ${operation}...`);results.push(await measure(scenario,operation,resources));scenarioCompleted=true;}
      finally{startup?.();try{await resources?.dispose();}finally{
        if(scenarioCompleted)await rm(scenario,{recursive:true,force:true});
        else console.error(`Preserved failed owned button fixture: ${scenario}`);
      }}
      await gate?.complete(index, results.at(-1));
    }
    const report = { source: benchmarkSource, environmentKeys: Object.keys(process.env).length, network: "owned-local-bare-only", results,
      scope: "Production HTML/CSP/JS button and extension callback with real Native Git; VS Code transport/window/pickers and selected PR GitHub list metadata are replaced. No real user worktree writes or OS window focus." };
    await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2));
    completed = true;
  } finally { if (completed) await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
