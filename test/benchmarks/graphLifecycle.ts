import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import * as v8 from "node:v8";
import path from "node:path";
import { Uri, window, __outputLines, __resetWindowMessages } from "../helpers/vscodeMock";
import { benchmarkOverrides as mock } from "../helpers/benchmarkOverrides";
import { createGitOperationFixture } from "../helpers/gitOperationFixture";
import { createLifecycleSurface, lifecycleEvent, lifecycleResourceUri } from "../helpers/graphLifecycleSurface";
import { GraphLiveRenderer } from "../helpers/graphLiveRenderer";
import { installPrButtonFixture } from "../helpers/prButtonFixture";
import { GitGraphPanel } from "../../src/webview/graphPanel";
import { GitLogService } from "../../src/git/gitLogService";
import { runGit } from "../../src/git/gitExec";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { setGitExecutionObserver } from "../../src/git/gitExecutionDiagnostics";
import { disposeWorkingTreeSnapshots } from "../../src/git/workingTreeSnapshot";
import { setOwnedFsmonitorPolicy } from "../../src/git/ownedFsmonitor";
import { readNativeRemoteTagExpectation } from "../helpers/graphNativeExpectation";
import type { ToWebviewMessage } from "../../src/webview/graphProtocol";

const requireFixture = createRequire(path.join(process.env.GSC_BENCH_WORKSPACE_ROOT || process.cwd(), "package.json"));
const { chromium } = requireFixture("playwright") as typeof import("@playwright/test");

/** 실행 중 프로세스·상태 게시가 안정된 실제 panel만 다음 단계로 넘긴다. */
async function settle(root: string, panel: any, lastPost: () => number, requireLoaded = true) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if ((!requireLoaded || panel.commits.length > 0) && !panel.loading && !panel.workingTree.state?.loading &&
      !gitProcesses.isBusy(root) && Date.now() - lastPost() > 150) return;
    await delay(25);
  }
  throw new Error(`Lifecycle did not settle: ${JSON.stringify({ loading: panel.loading, gitBusy: gitProcesses.isBusy(root) })}`);
}

/** Native에 보호할 작업 파일·index·설정·refs의 정확한 현재 바이트 증거를 만든다. */
async function protectedState(root: string) {
  const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  return { index: digest(await readFile(path.join(root, ".git/index"))), config: digest(await readFile(path.join(root, ".git/config"))),
    refs: await runGit(["for-each-ref", "--format=%(refname) %(objectname)"], root),
    userFile: await readFile(path.join(root, "preserved-lifecycle-work.txt"), "utf8") };
}

/** 소유 Node에서 GC 뒤 호스트의 보유 heap과 active resource 종류만 읽는다. */
async function nodeResources() {
  await new Promise<void>(resolve => setImmediate(resolve));
  global.gc?.();
  return { heapUsed: process.memoryUsage().heapUsed, resources: process.getActiveResourcesInfo().sort(),
    panelInstances: v8.queryObjects(GitGraphPanel), serviceInstances: v8.queryObjects(GitLogService),
    rendererInstances: v8.queryObjects(GraphLiveRenderer) };
}

/** 같은 browser/Node에서 production panel을 반복해 열고 가시성·갱신·종료의 자원을 검증한다. */
async function main() {
  assert.ok(process.argv[2], "Explicit report path required"); assert.ok(global.gc, "GC must be explicitly enabled");
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-graph-lifecycle-")); let completed = false;
  const originalCreate = Object.getOwnPropertyDescriptor(window, "createWebviewPanel");
  const browser = await chromium.launch({ headless: true });
  const focus = lifecycleEvent<{ focused: boolean }>();
  const stopMonitor = setOwnedFsmonitorPolicy(() => undefined);
  let created = 0, nativeCommands = 0, renderer: GraphLiveRenderer | undefined;
  let transport: ReturnType<typeof createLifecycleSurface> | undefined, lastPost = 0;
  const stopObservation = setGitExecutionObserver(() => { nativeCommands++; });
  try {
    const fixture = await createGitOperationFixture(directory); await installPrButtonFixture(fixture, 80);
    await writeFile(path.join(fixture.root, "preserved-lifecycle-work.txt"), "Preserved user work\n", { flag: "wx" });
    const before = await protectedState(fixture.root);
    mock.method(Uri, "joinPath", (base: { fsPath: string }, ...parts: string[]) => lifecycleResourceUri(path.join(base.fsPath, ...parts)));
    mock.method(window, "onDidChangeWindowState", focus.subscribe as any);
    Object.defineProperty(window, "createWebviewPanel", { configurable: true, value: () => {
      created++; transport = createLifecycleSurface((message: ToWebviewMessage) => { lastPost = Date.now(); renderer?.post(message); });
      return transport.surface;
    } });
    const cycles = [];
    for (let cycle = 0; cycle < 8; cycle++) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      renderer = new (GraphLiveRenderer as any)(browser, page);
      const service = new GitLogService(fixture.root), extension = Uri.file(process.cwd());
      GitGraphPanel.createOrShow(extension, service);
      const current = (GitGraphPanel as any).current, surface = transport!;
      renderer!.onMessage(message => surface.receive(message).then(() => undefined));
      await renderer!.mount(surface.surface.webview.html); await settle(fixture.root, current, () => lastPost);
      // 첫 실제 locator/click이 설치하는 Playwright 내부 listener는 제품의 반복 구독 증가와 분리한다.
      await renderer!.clickControl("#refresh-graph"); await settle(fixture.root, current, () => lastPost);
      const head = (await runGit(["rev-parse", "HEAD"], fixture.root)).trim();
      const remoteTags = await readNativeRemoteTagExpectation(fixture.root);
      await renderer!.verify(current.commits, head, Date.now(), true, undefined, fixture.mainBranch, remoteTags);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("HeapProfiler.collectGarbage"); const initial = await cdp.send("Memory.getDOMCounters");
      const rounds = [];
      for (let round = 0; round < 4; round++) {
        await renderer!.clickControl("#refresh-graph"); await settle(fixture.root, current, () => lastPost);
        surface.surface.hide(); const reads = nativeCommands;
        GitGraphPanel.refreshOpen(fixture.root, "hiddenLifecycleProbe"); GitGraphPanel.refreshOpen(fixture.root, "hiddenLifecycleProbe");
        await delay(180); assert.equal(nativeCommands, reads, "Hidden panel must not start Git reads");
        GitGraphPanel.createOrShow(extension, service); await settle(fixture.root, current, () => lastPost);
        assert.equal(created, cycle + 1, "Reveal must reuse the current panel");
        await cdp.send("HeapProfiler.collectGarbage"); rounds.push(await cdp.send("Memory.getDOMCounters"));
      }
      await renderer!.verify(current.commits, head, Date.now(), true, undefined, fixture.mainBranch,
        remoteTags);
      await cdp.send("HeapProfiler.collectGarbage"); const final = await cdp.send("Memory.getDOMCounters"); await cdp.detach();
      console.error("Lifecycle DOM counters", JSON.stringify({ cycle, initial, rounds, final }));
      await writeFile(process.argv[2] + ".checkpoint.json", JSON.stringify({ cycle, initial, rounds, final, completedCycles: cycles }, null, 2) + "\n");
      assert.ok(final.jsEventListeners <= initial.jsEventListeners + 8, "Refresh/reveal listener count must stay bounded");
      if (cycle % 2) GitGraphPanel.refreshOpen(fixture.root, "closeDuringReadProbe");
      surface.surface.dispose(); await page.close(); renderer = undefined;
      await settle(fixture.root, current, () => lastPost, false);
      assert.equal(GitGraphPanel.getOpenRepositoryRoot(), undefined); assert.equal(focus.size(), 0);
      assert.equal(surface.stats().subscriptions, 0); assert.equal(surface.stats().latePosts, 0);
      assert.equal(browser.contexts().length, 0); assert.deepEqual(await protectedState(fixture.root), before);
      __outputLines.length = 0; __resetWindowMessages(); const resources = await nodeResources();
      cycles.push({ cycle, created, initial, rounds, final, surface: surface.stats(), nativeIdle: true, ...resources });
      console.error(`Completed Graph lifecycle ${cycle + 1}/8`);
    }
    const measured = cycles.slice(2), first = measured.slice(0, 3), last = measured.slice(-3);
    const mean = (rows: typeof cycles) => rows.reduce((sum, row) => sum + row.heapUsed, 0) / rows.length;
    assert.ok(mean(last) - mean(first) < 3 * 1024 * 1024, "Post-GC host heap growth exceeded the probe budget");
    for (const key of ["panelInstances", "serviceInstances", "rendererInstances"] as const) {
      assert.ok(Math.max(...last.map(row => row[key])) <= Math.max(...first.map(row => row[key])), `${key} must not retain closed instances`);
    }
    for (const kind of ["Timeout", "Immediate", "ProcessWrap", "PipeWrap"]) {
      const maximum = (rows: typeof cycles) => Math.max(...rows.map(row => row.resources.filter(value => value === kind).length));
      assert.ok(maximum(last) <= maximum(first) + 1, `${kind} must not accumulate across closed panels`);
    }
    completed = true;
    await writeFile(process.argv[2], JSON.stringify({ source: JSON.parse(process.env.GSC_BENCH_SOURCE!), cycles,
      protectedStateExact: true, closedContextsExact: true, hiddenReadsSuppressed: true, boundedNodeResources: true,
      nodeHeapGrowthBytes: mean(last) - mean(first),
      scope: "Same Node and Chromium; 8 production panel open/close cycles, each 4 real refresh-button clicks and 4 hide/deferred-refresh/reveal command rounds, alternating close during reads. Real Native Git in an owned fixture, 80 mocked GitHub PR rows; VS Code window/transport events are faithfully modelled, no OS focus or real user worktree writes. DOM/listener counters after GC, host heap after GC; no total RSS/physical peak claim." }, null, 2) + "\n");
  } finally {
    transport?.surface.dispose(); await browser.close(); stopObservation(); stopMonitor();
    await disposeWorkingTreeSnapshots(); await gitProcesses.dispose(); mock.restoreAll();
    if (originalCreate) Object.defineProperty(window, "createWebviewPanel", originalCreate); else Reflect.deleteProperty(window, "createWebviewPanel");
    if (completed) await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
