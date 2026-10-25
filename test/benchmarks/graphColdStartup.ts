// production HTML 탐색 전부터 실제 ready callback·Git·첫/최종 Graph frame을 측정한다.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { benchmarkOverrides as mock } from "../helpers/benchmarkOverrides";
import { createGitOperationFixture } from "../helpers/gitOperationFixture";
import { createOperationGraphPanel } from "../helpers/graphOperationPanel";
import { GraphLiveRenderer } from "../helpers/graphLiveRenderer";
import { GraphPhaseResources } from "../helpers/graphPhaseResources";
import { readNativeGraphExpectation, readNativeRemoteTagExpectation } from "../helpers/graphNativeExpectation";
import { GitLogService } from "../../src/git/gitLogService";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { disposeWorkingTreeSnapshots } from "../../src/git/workingTreeSnapshot";
import { setOwnedFsmonitorPolicy } from "../../src/git/ownedFsmonitor";
import type { GraphRenderPerformance } from "../../src/webview/graphProtocol";

const source = JSON.parse(process.env.GSC_BENCH_SOURCE!);
delete process.env.GSC_BENCH_SOURCE_REF; delete process.env.GSC_BENCH_SOURCE;

/** 시작 요청이 끝난 뒤 늦은 작업트리·metadata 조회도 완료됐는지 확인한다. 실패 상태는 완료로 세지 않는다. */
async function settle(root: string, panel: any, metadataReady: () => boolean) {
  const deadline = Date.now() + 60000;
  const ready = () => !gitProcesses.isBusy(root) && !panel.loading && !panel.workingTree.state?.loading && metadataReady();
  while (Date.now() < deadline) {
    if (ready()) {
      await new Promise(resolve => setTimeout(resolve, 20));
      if (ready()) { assert.equal(panel.workingTree.state, undefined); return; }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Cold startup did not finish Native metadata reads");
}

/** 하나의 새 browser·fixture에서 전체 시작 비용을 잰다. setup/oracle/촬영은 측정 밖이다. */
async function main() {
  assert.ok(process.argv[2], "An explicit report path is required");
  assert.equal(process.env.GSC_BENCH_THROTTLE_BEFORE_LOAD, "1");
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-graph-cold-"));
  const stopMonitor = setOwnedFsmonitorPolicy(() => undefined);
  let completed = false, renderer: GraphLiveRenderer | undefined, panel: any, resources: GraphPhaseResources | undefined;
  try {
    const fixture = await createGitOperationFixture(directory), service = new GitLogService(fixture.root);
    renderer = await GraphLiveRenderer.create(); await renderer.prepareStartup();
    const received: Promise<void>[] = [], timings: GitExecutionTiming[] = [];
    const graph = createOperationGraphPanel({ mock } as any, service, message => renderer!.post(message)); panel = graph.panel;
    let readyCount = 0;
    renderer.onMessage(message => {
      if (message.type === "ready") readyCount++;
      const task = graph.receiveMessage(message); received.push(task); return task;
    });
    const cache: any = (service as any).localOnlyBranchCache, markerRead = typeof cache.getReadOnlyMap === "function" ? "getReadOnlyMap" : "getMap";
    const read = cache[markerRead].bind(cache); let pending = 0, failures = 0;
    mock.method(cache, markerRead, async () => { pending++; try { return await read(); } catch (error) { failures++; throw error; } finally { pending--; } });
    const metadataReady = () => pending === 0 && (!cache.remoteReady || !!cache.completed || failures > 0);
    if (process.env.GSC_BENCH_PHASE_RESOURCES === "1") {
      resources = await GraphPhaseResources.create(directory); await resources.begin(renderer, "cold-startup");
    }
    const stop = setGitExecutionObserver(timing => timings.push(timing));
    const startedAt = Date.now(), cpu = process.cpuUsage();
    let startup, phaseResources;
    try {
      await renderer.mount(graph.surface.webview.html);
      assert.equal(readyCount, 1, "Production Graph must initiate exactly one real ready callback");
      await Promise.all(received); await settle(fixture.root, panel, metadataReady);
      const latest = [...graph.messages].reverse().find(message => "performance" in message && message.performance)?.performance as GraphRenderPerformance | undefined;
      await renderer.waitForPendingFrame(latest);
      if (resources) phaseResources = await resources.finish(renderer, process.cpuUsage(cpu), timings.length);
      startup = await renderer.startupMetrics();
    } finally { stop(); }
    const measuredEndedAt = Date.now();
    const expected = await readNativeGraphExpectation(fixture.root, panel.commits.length), tags = await readNativeRemoteTagExpectation(fixture.root);
    const frame = await renderer.verify(expected, fixture.main, startedAt, false, undefined, fixture.mainBranch, tags);
    assert.equal(frame.exactRefs, true); assert.ok(startup.firstGraphFrameMs !== null);
    if (phaseResources) assert.equal(phaseResources.browserComplete, true);
    const report = { source, fixture: { files: fixture.files, commits: fixture.depth, branches: fixture.branches },
      mode: phaseResources?.phaseMemory ? "memory" : phaseResources ? "cpu" : "latency", cpuThrottle: Number(process.env.GSC_BENCH_RENDERER_CPU_THROTTLE || 1),
      startedAt, measuredEndedAt, elapsedMs: measuredEndedAt - startedAt, startup, phaseResources,
      gitProcesses: timings.length, gitCommands: timings.reduce((counts, timing) => { counts[timing.command] = (counts[timing.command] || 0) + 1; return counts; }, {} as Record<string, number>),
      nativeAndDomExact: true, frame, completed: true,
      scope: "New browser context, empty same-origin shell, browser-cold Graph assets; OS filesystem warm from source/fixture setup. CPU throttle before production HTML navigation. Actual registered ready callback, Native Git and first/final frame included; setup, Native oracle and screenshots excluded. No active VS Code, GitHub network or OS-wide contention claim." };
    await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n"); completed = true;
    console.error(JSON.stringify({ startup, gitProcesses: timings.length, nativeAndDomExact: true }));
  } finally {
    panel?.dispose(); await renderer?.dispose(); await resources?.dispose();
    await disposeWorkingTreeSnapshots(); await gitProcesses.dispose(); mock.restoreAll(); stopMonitor();
    if (completed) await rm(directory, { recursive: true, force: true });
    else console.error(`Preserved failed cold startup fixture: ${directory}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
