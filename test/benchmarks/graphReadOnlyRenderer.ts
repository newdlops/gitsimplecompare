// 실제 저장소는 읽기만 하고, 독립 Native 기준과 production Graph의 표시·입력 지연을 비교한다.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { runGit, setGitExecutableResolver, withGitConfigOverrides } from '../../src/git/gitExec';
import { setGitProcessPreparation } from '../../src/git/gitProcessRunner';
import { gitCommandPolicy } from '../../src/git/gitCommandPolicy';
import { gitProcesses } from '../../src/git/gitProcessRegistry';
import { readGraphLocalBranchSnapshot } from '../../src/git/graphLocalBranches';
import { readGitLogPageSnapshot } from '../../src/git/gitLogPage';
import { layoutGraph } from '../../src/graph/graphLayout';
import { GraphLiveRenderer } from '../helpers/graphLiveRenderer';
import { GraphPhaseResources } from '../helpers/graphPhaseResources';
import { setGitExecutionObserver, type GitExecutionTiming } from '../../src/git/gitExecutionDiagnostics';
import { productionHtmlBuilder } from '../helpers/graphProductionHtml';
import { createLifecycleSurface } from '../helpers/graphLifecycleSurface';
import { Uri } from '../helpers/vscodeMock';
import type { Commit } from '../../src/graph/graphTypes';
import type { GraphRenderPerformance } from '../../src/webview/graphProtocol';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** HEAD/index/config/packed refs와 전체 ref 집합의 원문은 메모리에서만 비교한다. */
async function protectedState(root: string) {
  const [gitDir, common] = (await runGit(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], root)).trim().split('\n');
  const files = [path.join(gitDir, 'HEAD'), path.join(gitDir, 'index'), path.join(gitDir, 'config.worktree'), path.join(common, 'config'), path.join(common, 'packed-refs')];
  const bytes = await Promise.all(files.map(async file => {
    try { return digest(await readFile(file)); }
    catch (error: any) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  }));
  const refs = await runGit(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)'], root);
  return { exact: digest(JSON.stringify([bytes, refs])), refCount: refs.split('\n').filter(Boolean).length };
}

/** Native full decoration을 제품 파서 없이 HEAD/branch/tag 표시 이름으로 바꾼다. */
function decorations(raw: string) {
  const values: string[] = [];
  const shorten = (value: string) => value.replace(/^refs\/(heads|remotes)\//, '');
  for (const value of raw ? raw.split(', ') : []) {
    if (value === 'HEAD') values.push('HEAD');
    else if (value.startsWith('HEAD -> ')) values.push('HEAD', shorten(value.slice(8)));
    else if (value.startsWith('tag: refs/tags/')) values.push('tag:' + value.slice(15));
    else if (!['refs/stash', 'grafted', 'replaced'].includes(value)) values.push(shorten(value));
  }
  return values;
}

/** 필드와 record를 모두 NUL로 고정한 별도 Native log를 기준으로 쓴다. 네트워크·제품 파서는 쓰지 않는다. */
async function nativePage(root: string, count: number): Promise<Commit[]> {
  const raw = await runGit(['log', '--topo-order', '--decorate=full', '--no-color', '--no-patch', '--no-show-signature', '--encoding=UTF-8',
    '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%D%x00%s', '-z', `-n${count}`, '--branches', '--remotes', '--tags'], root);
  const fields = raw.split('\0'); if (fields.at(-1) === '') fields.pop();
  assert.equal(fields.length % 7, 0);
  const commits: Commit[] = [];
  for (let index = 0; index < fields.length; index += 7) {
    const [hash, parents, authorName, authorEmail, dateIso, refs, subject] = fields.slice(index, index + 7);
    commits.push({ hash, parents: parents ? parents.split(' ') : [], authorName, authorEmail, dateIso, refs: decorations(refs), subject });
  }
  return commits;
}

/** 한 번의 새 headless 문서에서 실제 이력과 branch 상태를 production HTML에 전달한다. */
async function measure(root: string, count: number, html: string, resources: ReadonlyMap<string, string>, meter?: GraphPhaseResources) {
  const expected = await nativePage(root, count);
  const renderer = await GraphLiveRenderer.create();
  const delay = monitorEventLoopDelay({ resolution: 20 });
  const timings: GitExecutionTiming[] = [];
  let stopObserver = () => {};
  try {
    await renderer.prepareStartup();
    await (renderer as any).page.addInitScript(() => {
      window.addEventListener('pointerdown', event => {
        if (!event.isTrusted || event.button !== 0) return;
        const sample = (window as any).__gscSelectionSample = { started: performance.now() };
        requestAnimationFrame(() => requestAnimationFrame(() => { sample.frameMs = performance.now() - sample.started; }));
      }, true);
    });
    let readyCount = 0, task: Promise<void> | undefined, metadata: GraphRenderPerformance | undefined;
    let commits: Commit[] = [], branchSnapshot: unknown, graphData: ReturnType<typeof layoutGraph> | undefined,
      currentBranch: string | undefined, head = '', readMs = 0, layoutMs = 0, edges = 0, lanes = 0, branchCount = 0;
    renderer.onMessage(message => {
      if (message.type !== 'ready') return;
      readyCount++;
      task = (async () => {
        const started = performance.now();
        const [page, branches] = await Promise.all([
          readGitLogPageSnapshot(root, count, 0, [], AbortSignal.timeout(15000)),
          readGraphLocalBranchSnapshot(root, runGit, undefined, AbortSignal.timeout(15000)),
        ]);
        readMs = performance.now() - started; commits = page.page; branchSnapshot = branches;
        assert.ok(isDeepStrictEqual(commits, expected), 'Native page semantic mismatch; private values omitted');
        assert.equal(branches.invalidRefs.length, 0);
        const layoutStart = performance.now(), data = graphData = layoutGraph(commits);
        layoutMs = performance.now() - layoutStart; edges = data.edges.length; lanes = data.laneCount; branchCount = branches.branches.length;
        head = branches.branches.find(branch => branch.current)?.hash ?? commits.find(commit => commit.refs.includes('HEAD'))?.hash ?? '';
        currentBranch = branches.branches.find(branch => branch.current)?.name;
        renderer.post({ type: 'branchStatus', branches: branches.branches, worktrees: [] });
        metadata = { traceId: `readonly-${count}`, cause: 'readonly-actual-dag-probe', kind: 'initial', extensionStartedAt: startedAt, sentAt: Date.now() };
        renderer.post({ type: 'graph', data, revision: 0, performance: metadata,
          state: { loadedCount: commits.length, reset: true, loading: false, hasMore: false, hasMoreBefore: false, colorScope: 'readonly-actual-dag' } });
      })();
      return task;
    });
    if (meter) await meter.begin(renderer, `readonly-graph-${count}`, 'service');
    stopObserver = setGitExecutionObserver(timing => timings.push(timing));
    const loadBefore = os.loadavg(), cpu = process.cpuUsage(), startedAt = Date.now(); delay.enable();
    const renderProfile = await renderer.startCpuProfile(`real-dag-${count}-render`);
    await renderer.mount(html, resources);
    const deadline = Date.now() + 5000;
    while (!task && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(task, 'Production ready message was not observed'); assert.equal(readyCount, 1); await task;
    await renderer.waitForPendingFrame(metadata);
    const endedAt = Date.now(), used = process.cpuUsage(cpu); delay.disable();
    const phaseResources = meter ? await meter.finish(renderer, used, timings.length) : undefined;
    stopObserver();
    await renderProfile?.stop();
    const startup = await renderer.startupMetrics();
    const { exactRemoteTags, exactLocalOnly, ...frame } = await renderer.verify(expected, head, startedAt, false, metadata, currentBranch);
    const inputProfile = await renderer.startCpuProfile(`real-dag-${count}-selection`);
    const inputStart = performance.now();
    const selectedHash = commits.some(commit => commit.hash === head) ? head : commits[0].hash;
    await renderer.clickControl(`#graph-content .row[data-hash="${selectedHash}"] .commit-hash`);
    await renderer.waitForPendingFrame();
    const selectionRoundTripMs = performance.now() - inputStart;
    await inputProfile?.stop();
    const selectionEvent = await (renderer as any).page.evaluate(() => ({
      frameMs: (window as any).__gscSelectionSample?.frameMs,
    }));
    assert.ok(Number.isFinite(selectionEvent.frameMs));
    assert.equal(await renderer.countElements('#graph-content .row.selected'), 1);
    const resetRepeats = count === 5000 ? Number(process.env.GSC_BENCH_RESET_REPEATS || 0) : 0;
    assert.ok(Number.isInteger(resetRepeats) && resetRepeats >= 0 && resetRepeats <= 12);
    let fullReset;
    if (resetRepeats) {
      const targetIndex = Math.min(3000, commits.length - 1);
      await renderer.clickControl(`#graph-content .row[data-hash="${commits[targetIndex].hash}"] .commit-hash`);
      const samples = [];
      /** 실제 full reset을 게시한다. DOM oracle은 측정 뒤에만 실행해 생략된 subtree를 미리 펼치지 않는다. */
      const reset = async (index: number) => {
        const performance: GraphRenderPerformance = { traceId: `full-reset-${count}-${index}`, cause: 'readonly-full-reset',
          kind: 'initial', extensionStartedAt: Date.now(), sentAt: Date.now() };
        renderer.post({ type: 'graph', data: graphData!, performance,
          state: { reset: true, loading: false, hasMore: false, hasMoreBefore: false, loadedCount: count, colorScope: 'readonly-actual-dag' } });
        await renderer.waitForPendingFrame(performance);
        return renderer.readCompletedPaint(performance);
      };
      await reset(-2); await reset(-1);
      if (meter) await meter.begin(renderer, `readonly-full-reset-${count}`, 'service');
      const cpu = process.cpuUsage();
      for (let index = 0; index < resetRepeats; index++) samples.push(await reset(index));
      const resources = meter ? await meter.finish(renderer, process.cpuUsage(cpu), 0) : undefined;
      await renderer.verify(expected, head, Date.now(), true, undefined, currentBranch);
      fullReset = { targetIndex, warmups: 2, samples, resources, nativeAndDomExact: true,
        scope: 'Same captured Native data, real full-reset messages and a distant selected row. Native/DOM oracle excluded from measured series. Within-lifetime samples are correlated; CPU counters unthrottled and separate from latency.' };
    }
    const resetCycles = Number(process.env.GSC_BENCH_REPEAT_CYCLES || 0), lifecycle = [];
    assert.ok(Number.isInteger(resetCycles) && resetCycles >= 0 && resetCycles <= 12);
    if (resetCycles) {
      await (renderer as any).page.mouse.move(0, 0);
      await (renderer as any).page.keyboard.press('Escape');
      const smallCount = Math.min(300, commits.length), data = graphData!;
      for (let cycle = 0; cycle < resetCycles; cycle++) {
        for (const next of [{ ...data, rows: data.rows.slice(0, smallCount), edges: data.edges.filter(edge => edge.fromRow < smallCount && edge.toRow < smallCount) }, data]) {
          const performance: GraphRenderPerformance = { traceId: `reset-${count}-${cycle}-${next.rows.length}`, cause: 'readonly-reset-cycle',
            kind: 'initial', extensionStartedAt: Date.now(), sentAt: Date.now() };
          renderer.post({ type: 'graph', revision: cycle + 1, data: next, performance,
            state: { reset: true, loading: false, hasMore: false, hasMoreBefore: false, loadedCount: next.rows.length, colorScope: 'readonly-actual-dag' } });
          await renderer.waitForPendingFrame(performance);
        }
        await renderer.verify(expected, head, Date.now(), true, undefined, currentBranch);
        lifecycle.push({ cycle, ...await renderer.readCollectedDomState() });
      }
      const last = lifecycle.at(-1)!;
      assert.ok(lifecycle.every(sample => sample.documents === last.documents && sample.nodes === last.nodes && sample.jsEventListeners === last.jsEventListeners), 'DOM resources grew across identical reset cycles');
    }
    return { count: commits.length, branches: branchCount, edges, lanes, profiled: !!renderProfile, cpuThrottle: Number(process.env.GSC_BENCH_RENDERER_CPU_THROTTLE || 1),
      startedAt, endedAt, elapsedMs: endedAt - startedAt, readMs, layoutMs, nodeCpuMs: (used.user + used.system) / 1000,
      nodeEventLoopDelayMaxMs: delay.max / 1e6, readyCount, startup, frame, selectionRoundTripMs, selectionEvent, phaseResources,
      commands: timings.map(({ command, elapsedMs, syncSpawnMs, outcome }) => ({ command, elapsedMs, syncSpawnMs, outcome })),
      systemLoadBefore: loadBefore, systemLoadAfter: os.loadavg(), nativeSemanticsExact: true, selectionExact: true,
      inputFingerprint: digest(JSON.stringify([expected, branchSnapshot])), fullReset, lifecycle };
  } finally { stopObserver(); delay.disable(); await renderer.dispose(); }
}

/** 실제 저장소의 모든 Git 명령 직전 allowlist를 검사하고 선택적 쓰기·lazy fetch·fsmonitor를 끈다. */
async function main() {
  const output = path.resolve(process.argv[2] || '');
  assert.ok([os.tmpdir(), '/private/tmp', '/tmp'].some(directory => output.startsWith(path.resolve(directory) + path.sep)), 'Output must be under a temporary directory');
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete process.env[key];
  process.env.GIT_OPTIONAL_LOCKS = '0'; process.env.GIT_NO_LAZY_FETCH = '1';
  const input = process.env.GSC_BENCH_READONLY_REPOSITORY;
  assert.ok(input, 'An explicit existing repository is required');
  const selected = { root: await realpath(input), executable: process.env.GSC_BENCH_GIT_EXECUTABLE || 'git' };
  const restoreExecutable = setGitExecutableResolver(() => selected.executable);
  const allow = new Set(['rev-parse', 'for-each-ref', 'log', 'show-ref', 'symbolic-ref']);
  const restorePreparation = setGitProcessPreparation(async (args, cwd, options) => {
    const policy = gitCommandPolicy(args);
    assert.equal(path.resolve(cwd), selected.root, 'Unexpected repository');
    assert.ok(policy.readOnly && allow.has(policy.command), 'Nonlocal or mutation command rejected');
    assert.equal(options.env?.GIT_INDEX_FILE, undefined, 'Scratch/source index access is not needed');
    return { options: { ...options, readTimeoutMs: Math.min(options.readTimeoutMs ?? 15000, 15000),
      env: withGitConfigOverrides({ ...options.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }, { 'core.fsmonitor': 'false' }) } };
  });
  let resourceDirectory: string | undefined, meter: GraphPhaseResources | undefined;
  try {
    const top = await runGit(['rev-parse', '--show-toplevel'], selected.root);
    assert.ok(await realpath(top.replace(/\r?\n$/, '')) === selected.root, 'Select an actual worktree root');
    if (process.env.GSC_BENCH_PHASE_RESOURCES === '1') {
      resourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'gsc-readonly-graph-resources-'));
      meter = await GraphPhaseResources.create(resourceDirectory);
    }
    const before = await protectedState(selected.root);
    const bundle = await readFile(path.join(process.cwd(), 'media/bundled/graph.js'));
    const css = await readFile(path.join(process.cwd(), 'media/graph/graph.css'));
    const controlsCss = await readFile(path.join(process.cwd(), 'media/graph/graphControls.css'));
    const resources = new Map<string, string>();
    for (const [key, variable, expectedVariable] of [
      ['media/bundled/graph.js', 'GSC_BENCH_RENDERER_BUNDLE_PATH', 'GSC_BENCH_RENDERER_BUNDLE_SHA256'],
      ['media/graph/graph.css', 'GSC_BENCH_RENDERER_CSS_PATH', 'GSC_BENCH_RENDERER_CSS_SHA256'],
      ['media/graph/graphControls.css', 'GSC_BENCH_RENDERER_CONTROLS_CSS_PATH', 'GSC_BENCH_RENDERER_CONTROLS_CSS_SHA256'],
    ]) {
      const file = process.env[variable]; if (!file) continue;
      const bytes = await readFile(file);
      assert.ok(process.env[expectedVariable] && digest(bytes) === process.env[expectedVariable], 'Baseline media identity mismatch');
      resources.set(key, bytes.toString('utf8'));
    }
    const html = (await productionHtmlBuilder())(createLifecycleSurface(() => {}).surface, Uri.file(process.cwd()));
    const report: any = { observedAt: new Date().toISOString(), source: JSON.parse(process.env.GSC_BENCH_SOURCE || '{}'),
      mode: Number(process.env.GSC_BENCH_REPEAT_CYCLES) ? 'lifecycle' : meter ? 'resources' : process.env.GSC_BENCH_RENDERER_PROFILE_DIR ? 'profile' : 'latency',
      sourceVersion: JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8')).version, repoAlias: digest(selected.root).slice(0, 12), bundleSha256: digest(bundle),
      label: process.env.GSC_BENCH_RENDERER_LABEL || 'working-tree',
      effectiveBundleSha256: digest(resources.get('media/bundled/graph.js') ?? bundle),
      effectiveCssSha256: digest(resources.get('media/graph/graph.css') ?? css),
      effectiveControlsCssSha256: digest(resources.get('media/graph/graphControls.css') ?? controlsCss),
      referenceCount: before.refCount, results: [], completed: false,
      scope: 'Actual repository, independent Native page oracle and production Git readers/layout/HTML/bundle in a fresh owned headless Chromium for each row count. No VS Code transport, GitHub/remote-tag/status/local-only loading, UI focus change or repository write. Native oracle runs before each measurement and warms filesystem caches. Input is frontend selection plus two frames, not backend detail loading.' };
    const counts = (process.env.GSC_BENCH_RENDERER_COUNTS || '300,1200,5000').split(',').map(Number);
    assert.ok(counts.length && counts.every(count => [300, 1200, 5000].includes(count)));
    for (const count of counts) {
      report.results.push(await measure(selected.root, count, html, resources, meter));
      await writeFile(output, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify(report.results.at(-1)));
    }
    const after = await protectedState(selected.root);
    assert.ok(before.exact === after.exact, 'Protected source state changed; diagnosis cannot claim preservation');
    assert.equal(digest(await readFile(path.join(process.cwd(), 'media/bundled/graph.js'))), report.bundleSha256);
    assert.equal(digest(await readFile(path.join(process.cwd(), 'media/graph/graph.css'))), digest(css));
    assert.equal(digest(await readFile(path.join(process.cwd(), 'media/graph/graphControls.css'))), digest(controlsCss));
    assert.equal(gitProcesses.isBusy(selected.root), false);
    report.repositoryProtectedStateExact = true; report.completed = true;
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  } finally {
    restorePreparation(); restoreExecutable();
    const closed = await Promise.allSettled([meter?.dispose(), gitProcesses.dispose()]);
    if (resourceDirectory) await rm(resourceDirectory, { recursive: true, force: true });
    assert.ok(closed.every(result => result.status === 'fulfilled'), 'Owned readonly resources did not close');
  }
}
main().catch(error => { console.error(JSON.stringify({ failed: true, name: error.name, code: error.code,
  message: 'Readonly Graph verification failed; private values omitted' })); process.exitCode = 1; });
