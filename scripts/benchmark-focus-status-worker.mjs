// mock 창 이벤트만 조작하며 실제 데스크톱 입력 없이 표시 소비자의 Native 비용을 계측한다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, stat, cp, rm } from "node:fs/promises";
import { tmpdir, loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url), directory = process.argv[2], output = process.argv[3];
const modules = { before: require(path.join(directory, "before.cjs")), after: require(path.join(directory, "after.cjs")) };
const rounds = Number(process.env.GSC_FOCUS_BENCH_ROUNDS ?? 4), lives = Number(process.env.GSC_FOCUS_BENCH_LIFECYCLES ?? 2);
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 4 && Number.isInteger(lives) && lives > 0 && lives <= 2);
const samples = [], trackedFiles = 10000, untrackedFiles = 2000;
let interrupted = false;
process.once("SIGTERM", () => { interrupted = true; void Promise.all(Object.values(modules).map(m => m.gitProcesses.dispose())); });

/** Native oracle와 실제 마지막 목록을 경로·상태 의미로 비교하며 지연된 +/- 보강은 제외한다. */
function normalized(groups) {
  const entries = values => values.map(({ status, path, oldPath }) => ({ status, path, ...(oldPath ? { oldPath } : {}) }))
    .sort((one, two) => Buffer.compare(Buffer.from(one.path), Buffer.from(two.path)));
  return { staged: entries(groups.staged), unstaged: entries(groups.unstaged) };
}

/** 실제 source index의 byte·inode·시각을 고정해 읽기 계측 중 사용자 index에 해당하는 fixture가 바뀌지 않게 한다. */
async function protectedIndex(m, root) {
  const file = path.resolve(root, (await m.runGit(["rev-parse", "--git-path", "index"], root)).trim());
  const info = await stat(file, { bigint: true });
  return [createHash("sha256").update(await readFile(file)).digest("hex"), String(info.ino), String(info.mtimeNs), String(info.ctimeNs)];
}

/** 한 Node harness와 그 자식 중 종료·wait가 확인된 Native CPU를 같은 경계에서 읽는다. */
function counters(capture) { return { wall: performance.now(), node: process.cpuUsage(), native: capture() }; }

/** 두 경계의 CPU와 wall을 분리하며 실제 사용자 클릭·Graph latency라는 이름을 붙이지 않는다. */
function delta(first, last) {
  const nodeCpuMs = (last.node.user - first.node.user + last.node.system - first.node.system) / 1000;
  const nativeCpuMs = last.native.userCpuMs - first.native.userCpuMs + last.native.systemCpuMs - first.native.systemCpuMs;
  return { wallMs: last.wall - first.wall, nodeCpuMs, nativeCpuMs, ownedCpuMs: nodeCpuMs + nativeCpuMs };
}

/** 표시용 이벤트 source를 메모리에만 두고 실제 VS Code·다른 확장에 이벤트를 보내지 않는다. */
function event() {
  const listeners = new Set();
  return { subscribe: callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
    fire: value => { for (const callback of listeners) callback(value); } };
}

/**
 * 한 release의 실제 provider·Changes·공유 status를 같은 root에 연결한다.
 * @param m 고정 commit에서 번들한 runtime @param root 소유 fixture @param cache 전용 cache directory
 * @param observed 실제 cache 복원·cold scan·warmup 횟수를 수집할 측정 상태
 * @returns mock 포커스 전환, 실제 두 표시 소비자, 정리 함수와 최종 목록
 */
function display(m, root, cache, observed) {
  const changes = event(), focus = event(), noop = () => ({ dispose() {} });
  m.window.state = { focused: true }; m.window.onDidChangeWindowState = focus.subscribe;
  Object.assign(m.workspace, { workspaceFolders: [{ uri: m.Uri.file(root), name: "owned", index: 0 }],
    onDidChangeConfiguration: noop, onDidChangeWorkspaceFolders: noop, onDidSaveTextDocument: noop,
    onDidCreateFiles: noop, onDidDeleteFiles: noop, onDidRenameFiles: noop,
    getConfiguration: section => ({ get: (key, fallback) => section === "git" && key === "enabled" ? false
      : section === "git" && key === "decorations.enabled" ? true : fallback }),
    createFileSystemWatcher: () => ({ dispose() {}, onDidChange: noop, onDidCreate: noop, onDidDelete: noop }) });
  m.Uri.parse = value => m.Uri.file(value);
  const releasePolicy = m.setWorkingTreeSnapshotPolicy(() => ({ useCache: true, cancelUnused: true }), (label, fields) => {
    if (label === "private status index cache restored") observed.cacheRestored++;
    if (label === "private status cold scan completed") observed.coldScans.push(fields.elapsedMs);
    if (label === "private status index warmup started") observed.warmupsStarted++;
    if (label === "private status index warmup completed") observed.warmupsCompleted++;
  }, cache);
  const releaseChanged = m.onWorkingTreeSnapshotInvalidated(root => changes.fire(root));
  const service = new m.GitService(root), applied = [];
  const deps = { registry: { get: () => service }, changesView: { getActiveRepo: () => root, setStatusGroups: value => applied.push(value) },
    vscodeGitStatus: { getStatusGroups: async () => undefined, getStatusRevision: () => 0 } };
  const provider = new m.WorkingTreeFileDecorationProvider({ resolve: async () => service },
    { version: 1, onDidChange: changes.subscribe, getStatus: (root, options) => m.readWorkingTreeSnapshot(root, options) });
  return { deps, applied, provider, service,
    focus: value => {
      m.window.state = { focused: value };
      // 실제 release의 extension wiring처럼 새 버전에만 Changes의 blur 해제를 연결한다.
      if (!value) m.status.pauseWorkingStatusRefresh?.(deps);
      focus.fire({ focused: value });
    },
    dispose: async () => {
      m.status.disposeWorkingStatusRefresh(deps); provider.dispose(); releaseChanged();
      await m.disposeWorkingTreeSnapshots(); await m.gitProcesses.dispose(); releasePolicy();
    } };
}

/**
 * 최초 실제 Native status spawn 뒤 5ms에 blur하고, rapid=10ms/hidden=200ms 뒤 복귀한다.
 * @returns 전체 display lifecycle의 CPU, 복귀→최신 표시, 실제 Git 실행과 취소 관찰
 */
async function measure(root, cache, variant, kind, capture, expected) {
  const m = modules[variant], original = m.gitProcesses.register, commands = [], timers = [];
  let ui, firstChild, firstStatusSpawnedAt, actionError, actionResolve, resume, atResume, atBlur, before, visible;
  const observed = { cacheRestored: 0, coldScans: [], warmupsStarted: 0, warmupsCompleted: 0 };
  const action = new Promise(resolve => { actionResolve = resolve; });
  const stopObserver = m.setGitExecutionObserver(value => commands.push({ command: value.command, elapsedMs: value.elapsedMs, outcome: value.outcome, code: value.code }));
  m.gitProcesses.register = function (...args) {
    const id = original.apply(this, args);
    if (!firstChild && args[1] === root && args[2] === "status") {
      firstChild = args[0];
      firstStatusSpawnedAt = performance.now();
      if (kind === "active") actionResolve();
      else timers.push(setTimeout(() => {
        try {
          atBlur = { ...counters(capture), firstStatusStillRunning: firstChild.exitCode === null && firstChild.signalCode === null };
          ui.focus(false); ui.service.invalidateStatusCache(false);
          timers.push(setTimeout(() => {
            try {
              atResume = counters(capture); ui.focus(true);
              resume = m.status.refreshWorkingStatus(ui.deps, { reason: "windowFocusedReconcile", forceGit: true, focusScoped: true });
              void resume.catch(() => undefined);
            } catch (error) { actionError = error; }
            actionResolve();
          }, kind === "rapid" ? 10 : 200));
        } catch (error) { actionError = error; actionResolve(); }
      }, 5));
    }
    return id;
  };
  let initial;
  try {
    before = counters(capture); ui = display(m, root, cache, observed);
    initial = m.status.refreshWorkingStatus(ui.deps, { reason: "viewReady", focusScoped: true });
    void initial.catch(() => undefined);
    const timeout = setTimeout(() => { actionError = new Error("First Native status did not start"); actionResolve(); }, 10000);
    try { await action; } finally { clearTimeout(timeout); }
    if (actionError) throw actionError;
    await Promise.all([initial, resume]);
    const badge = await ui.provider.provideFileDecoration(m.Uri.file(path.join(root, "src/d0/0.txt")), { isCancellationRequested: false });
    visible = counters(capture);
    const final = ui.applied.at(-1);
    await ui.dispose(); ui = undefined;
    const end = counters(capture);
    assert.deepEqual(normalized(final), expected); assert.equal(badge?.badge, "M");
    assert.equal(m.gitProcesses.isBusy(root), false);
    assert.ok(commands.every(value => value.outcome !== "error" || value.code === "ABORT_ERR"), "Only expected consumer cancellations may fail");
    return { ...delta(before, end), visibleReadyMs: visible.wall - before.wall,
      resumeToVisibleMs: atResume ? visible.wall - atResume.wall : undefined,
      hiddenStage: atResume ? delta(before, atResume) : undefined,
      resumedStage: atResume ? delta(atResume, end) : undefined,
      firstStatusStillRunningAtBlur: atBlur?.firstStatusStillRunning,
      actualBlurAfterStartMs: atBlur ? atBlur.wall - before.wall : undefined,
      actualBlurAfterStatusSpawnMs: atBlur ? atBlur.wall - firstStatusSpawnedAt : undefined,
      statusCacheEvents: observed,
      gitCalls: commands.length, statusCalls: commands.filter(value => value.command === "status").length,
      cancelledCalls: commands.filter(value => value.outcome === "error").length, commands };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    if (ui) await ui.dispose();
    stopObserver(); m.gitProcesses.register = original;
  }
}

/** 완료된 전용 UNTR cache를 fixture 밖 template에 만들어 warm/cold 입력을 매번 동일하게 복제한다. */
async function warmTemplate(m, root, cache) {
  let done;
  const complete = new Promise(resolve => { done = resolve; });
  const release = m.setWorkingTreeSnapshotPolicy(() => ({ useCache: true, cancelUnused: true }),
    (label, fields) => { if (label === "private status index warmup completed") done(fields.persisted); }, cache);
  try {
    await m.readWorkingTreeSnapshot(root);
    const timeout = setTimeout(() => done(false), 10000);
    try { assert.equal(await complete, true, "Warm template must be persisted before measurement"); }
    finally { clearTimeout(timeout); }
  } finally { await m.disposeWorkingTreeSnapshots(); await m.gitProcesses.dispose(); release(); }
}

/** 소유 저장소만 생성하며 320개 tracked directory로 실제 cold-scan 경로의 경계를 통과시킨다. */
async function createFixture(m, parent) {
  const root = path.join(parent, "main"); await mkdir(root);
  await m.runGit(["-c", "init.templateDir=", "init", "-q", "-b", "main"], root);
  await m.runGit(["config", "core.fsmonitor", "false"], root);
  await m.runGit(["config", "core.hooksPath", parent], root);
  const files = Array.from({ length: trackedFiles }, (_, index) => `M 100644 :1 src/d${index % 320}/${index}.txt`);
  await m.runGitWithInput(["fast-import", "--quiet"], root, "blob\nmark :1\ndata 5\nbase\n\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ndata 4\nbase\n" + files.join("\n") + "\n\ndone\n");
  await m.runGit(["read-tree", "--reset", "-u", "main"], root);
  return root;
}

/** 파일 상태와 untracked 범위를 두 소유 작업트리에 같은 내용으로 채운다. */
async function editFixture(root) {
  await writeFile(path.join(root, "src/d0/0.txt"), "modified\n");
  for (let index = 0; index < 16; index++) await mkdir(path.join(root, `untracked-${index}`));
  for (let index = 0; index < untrackedFiles; index += 50) await Promise.all(Array.from({ length: 50 }, (_, offset) => {
    const number = index + offset; return writeFile(path.join(root, `untracked-${number % 16}`, `${number}.txt`), "untracked\n");
  }));
}

const parent = await mkdtemp(path.join(tmpdir(), "gsc-focus-resource-owned-"));
try {
  const m = modules.after, probeDirectory = path.join(parent, "probe"); await mkdir(probeDirectory);
  const capture = await m.loadChildResourceProbe(probeDirectory), main = await createFixture(m, parent);
  const roots = [main];
  if (lives === 2) {
    const linked = path.join(parent, "linked"); await m.runGit(["worktree", "add", "--detach", "-q", linked, "main"], main); roots.push(linked);
  }
  const systemLoadBefore = loadavg();
  for (let life = 0; life < roots.length; life++) {
    const root = roots[life]; await editFixture(root);
    const expected = normalized(m.workingTreeSnapshot(root, m.parseWorkingTreeV2(await m.runGit([
      "status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=all"], root))).groups);
    const protectedBefore = await protectedIndex(m, root), template = path.join(parent, `template-${life}`); await mkdir(template);
    await warmTemplate(m, root, template);
    for (const warmth of ["cold", "warm"]) for (const kind of ["active", "hidden", "rapid"]) {
      for (let round = 0; round < rounds; round++) {
        const order = (life + round) % 2 ? ["after", "before"] : ["before", "after"];
        for (const variant of order) {
          assert.equal(interrupted, false, "Benchmark interrupted");
          const cache = await mkdtemp(path.join(parent, "sample-cache-"));
          try {
            if (warmth === "warm") await cp(template, cache, { recursive: true });
            samples.push({ life, rootKind: life ? "linked" : "main", warmth, kind, round, order, variant,
              ...await measure(root, cache, variant, kind, capture, expected) });
          } finally { await rm(cache, { recursive: true, force: true }); }
        }
      }
      assert.deepEqual(await protectedIndex(m, root), protectedBefore);
      console.log(JSON.stringify({ fixture: life + 1, warmth, kind, samples: samples.length }));
    }
  }
  const report = { recordedAt: new Date().toISOString(), baseline: "db9ed984ba5a3d88b106652162e505eb7ce0d6f3",
    candidate: "0111964845245cb54d330bc58e971de000a35663", node: process.version,
    fixture: { trackedFiles, trackedDirectories: 320, untrackedFiles, untrackedDirectories: 16, lifecycles: roots.length },
    protocol: { rounds, blurAfterFirstNativeStatusSpawnMs: 5, rapidResumeDelayMs: 10, hiddenResumeDelayMs: 200,
      mockEventsOnly: true, userRepositoriesTouched: false, actualDesktopInput: false, processInspectionIncludedInNativeCpu: true,
      measuredScope: "Two display consumers through real GitService/shared/private status, including awaited read disposal. Setup, warm template, oracle, assertions and fixture removal excluded.",
      systemLoadBefore, systemLoadAfter: loadavg(), controlledHostCpuLoad: false, actualCodeCpuClaim: false },
    allFinalNativeGroupsEqual: true, allSourceIndexesUnchanged: true, samples };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ completed: true, samples: samples.length, output }));
} finally {
  await Promise.all(Object.values(modules).map(async m => { await m.disposeWorkingTreeSnapshots(); await m.gitProcesses.dispose(); }));
  await rm(parent, { recursive: true, force: true });
}
