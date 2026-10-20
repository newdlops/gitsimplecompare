// 실제 웹뷰 버튼 → 등록된 VS Code 메시지 callback → Native Git → 최종 Graph frame을 연결한다.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "../../src/git/gitExec";
import { GitLogService } from "../../src/git/gitLogService";
import { RebaseService } from "../../src/git/rebaseService";
import { captureRebaseCheckout } from "../../src/git/rebasePlanSafety";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { disposeWorkingTreeSnapshots } from "../../src/git/workingTreeSnapshot";
import type { Commit } from "../../src/graph/graphTypes";
import type { GraphRenderPerformance } from "../../src/webview/graphProtocol";
import { createGitOperationFixture } from "../helpers/gitOperationFixture";
import { createOperationGraphPanel } from "../helpers/graphOperationPanel";
import { GraphLiveRenderer } from "../helpers/graphLiveRenderer";
import { window, __errorMessages, __resetWindowMessages, __setQuickPickResult } from "../helpers/vscodeMock";

type Operation = "push" | "pull" | "fetch" | "interactive-rebase";
const operations: Operation[] = ["push", "pull", "fetch", "interactive-rebase"];

/** 예외나 무한 대기를 성공으로 세지 않고 기다리던 대상을 제한 시간 오류에 남긴다. */
async function within<T>(promise: Promise<T>, label: string, milliseconds = 60000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

/** 연속 게시가 안정된 뒤 늦은 status나 오래된 frame을 최종 상태로 오인하지 않게 한다. */
async function settle(root: string, panel: any, messages: readonly unknown[]): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const count = messages.length;
    if (!gitProcesses.isBusy(root) && !panel.loading && !panel.workingTree.state?.loading) {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (!gitProcesses.isBusy(root) && !panel.loading && !panel.workingTree.state?.loading && messages.length === count) return;
    } else await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Button flow did not settle");
}

/** 정확한 HEAD/ref/부모/local-only 상태를 가진 최종 게시만 선택한다. */
function signature(commits: readonly Commit[]): string {
  return JSON.stringify(commits.map(commit => [commit.hash, commit.parents, [...new Set(commit.refs)].sort(), [...commit.localOnlyBranches ?? []].sort()])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

/** 각 작업은 독립 fixture와 local bare remote만 사용하며 실제 사용자 작업트리나 외부 네트워크에 쓰지 않는다. */
async function measure(directory: string, operation: Operation) {
  const f = await createGitOperationFixture(directory), branch = `button-${operation}`;
  await runGit(["switch", "-qC", branch, operation === "push" || operation === "interactive-rebase" ? f.pr : f.main], f.root);
  if (operation === "pull") {
    await runGit(["config", `branch.${branch}.remote`, "origin"], f.root);
    await runGit(["config", `branch.${branch}.merge`, "refs/heads/main"], f.root);
    await runGit(["update-ref", "refs/heads/main", f.incomingPull], f.remote);
  }
  if (operation === "fetch") await runGit(["update-ref", "refs/heads/incoming", f.incoming], f.remote);
  assert.equal((await runGit(["remote", "get-url", "--push", "origin"], f.root)).trim(), f.remote, "Only the owned local bare receiver is permitted");
  __resetWindowMessages();
  mock.method(window, "showWarningMessage", async (_message: string, ...choices: unknown[]) => choices.find(choice => typeof choice === "string"));
  __setQuickPickResult(items => items.find((item: any) => item?.kind !== -1));
  const renderer = await GraphLiveRenderer.create(), service = new GitLogService(f.root);
  let measuring = false;
  const publications: { at: number; signature: string; performance?: GraphRenderPerformance }[] = [];
  const transport = createOperationGraphPanel({ mock } as any, service, message => {
    renderer.post(message);
    if (measuring && (message.type === "graph" || message.type === "graphDelta")) publications.push({
      at: performance.now(), signature: signature(transport.panel.commits), performance: message.performance });
  });
  const { panel, messages, surface, receiveMessage } = transport;
  let ready!: () => void, actionDone!: () => void, actionFailed!: (error: unknown) => void;
  const initialized = new Promise<void>(resolve => { ready = resolve; });
  const action = new Promise<void>((resolve, reject) => { actionDone = resolve; actionFailed = reject; });
  void action.catch(() => undefined);
  const requestType = operation === "interactive-rebase" ? "runGraphRebase" : operation;
  let receivedAt: number | undefined, completedAt: number | undefined;
  renderer.onMessage(async message => {
    try {
      if (message.type === requestType) { assert.equal(receivedAt, undefined, "One click must send one mutation request"); receivedAt = performance.now(); }
      await receiveMessage(message);
      if (message.type === "ready") ready();
      if (message.type === requestType) { completedAt = performance.now(); actionDone(); }
    } catch (error) { actionFailed(error); throw error; }
  });
  try {
    await renderer.mount(surface.webview.html);
    await within(initialized, "actual ready callback");
    await settle(f.root, panel, messages);
    assert.ok(panel.commits.length > 0); assert.deepEqual(__errorMessages, []);
    if (operation === "interactive-rebase") {
      const checkout = await captureRebaseCheckout(f.root), commits = await new RebaseService(f.root).getCommits(f.main, false, false);
      renderer.post({ type: "graphRebasePlan", plan: { branch, base: f.main, root: false, baseReason: "selected", checkout, commits,
        items: [{ hash: f.prCommits[0], action: "reword", message: "rewritten click\n\nfirst body" },
          { hash: f.prCommits[1], action: "squash", message: "combined click\n\ncombined body" }, { hash: f.prCommits[2], action: "pick" }] } });
    }
    const initial = signature(panel.commits), beforeMessages = messages.length, timings: GitExecutionTiming[] = [];
    const stop = setGitExecutionObserver(timing => timings.push(timing));
    const started = performance.now(), clickedAt = Date.now(), cpu = process.cpuUsage();
    measuring = true;
    try {
      if (operation === "interactive-rebase") await renderer.clickNamedControl("Start rebase");
      else await renderer.clickControl(`#${operation}-graph`);
      await within(action, `${requestType} handler`);
      await settle(f.root, panel, messages);
      measuring = false; stop();
      const settled = performance.now(), used = process.cpuUsage(cpu), final = signature(panel.commits);
      assert.ok(receivedAt !== undefined && completedAt !== undefined);
      assert.deepEqual(__errorMessages, [], "The actual message handler must not hide a Git failure in an error toast");
      const head = (await runGit(["rev-parse", "HEAD"], f.root)).trim();
      const verifier = new GitLogService(f.root);
      const local = (await verifier.getLocalBranchSnapshot()).branches;
      const remote = (await runGit(["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(symref)", "refs/remotes/"], f.root))
        .trim().split("\n").filter(Boolean).flatMap(line => {
          const [name, hash, symbolic] = line.split("\0"); return symbolic ? [] : [{ name, hash }];
        });
      verifier.seedGraphBranchTips(local, remote);
      const fresh = await verifier.getCommitPage(panel.commits.length, 0, [], true);
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
      if (operation === "interactive-rebase") {
        const bodies = (await runGit(["log", "--reverse", "--format=%B%x00", `${f.main}..HEAD`], f.root)).split("\0").map(value => value.trim()).filter(Boolean);
        assert.deepEqual(bodies, ["combined click\n\ncombined body", "PR 2"]);
        assert.equal((await runGit(["rev-parse", "HEAD^{tree}"], f.root)).trim(), (await runGit(["rev-parse", `${f.pr}^{tree}`], f.root)).trim());
      }
      assert.equal((await runGit(["status", "--porcelain=v1"], f.root)).trim(), "");
      const publication = publications.slice().reverse().find(value => value.at >= started && value.signature === final);
      assert.ok(publication || initial === final, "Changed final state must have a publication caused after the click");
      const frame = await renderer.verify(panel.commits, head, clickedAt, initial === final, publication?.performance, branch);
      return { operation, transport: "actual-rendered-button-and-registered-message-callback", fixture: { files: f.files, commits: f.depth, branches: f.branches },
        clickToRequestMs: Math.round(receivedAt - started), handlerMs: Math.round(completedAt - receivedAt),
        clickToFirstFrameMs: frame.mutationToFrameMs, clickToFinalFrameMs: frame.latestMutationToFrameMs,
        clickToSettledMs: Math.round(settled - started), nativeStateExact: true, cleanWorkingTree: true,
        nodeCpuMs: Math.round((used.user + used.system) / 1000), nodeCpuScope: "benchmark Node including Playwright transport; Git/Chromium/OS CPU excluded",
        processes: timings.length, commands: timings.map(({ command, elapsedMs, syncSpawnMs, outcome, code }) => ({ command, elapsedMs, syncSpawnMs, outcome, code })),
        graphPublications: publications.length, webviewMessages: messages.length - beforeMessages, frame };
    } finally { measuring = false; stop(); }
  } finally { panel.dispose(); await renderer.dispose(); await disposeWorkingTreeSnapshots(); await gitProcesses.dispose(); mock.restoreAll(); }
}

/** 모든 사례를 같은 규모로 실행하고 fixture와 browser 자원은 종료 시 회수한다. */
async function main() {
  const selected = (process.env.GSC_BENCH_OPERATIONS?.split(",") ?? operations) as Operation[];
  assert.ok(selected.length && selected.every(value => operations.includes(value)), "Unknown button operation");
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-graph-button-flow-"));
  try {
    const results = [];
    for (const operation of selected) {
      const scenario = path.join(directory, operation); await mkdir(scenario);
      console.error(`Clicking ${operation}...`); results.push(await measure(scenario, operation));
    }
    const report = { source: JSON.parse(process.env.GSC_BENCH_SOURCE!), network: "owned-local-bare-only", results,
      scope: "Production HTML/CSP/JS button and extension callback with real Native Git; VS Code transport/window/pickers are replaced. No real user worktree writes or OS window focus." };
    await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
