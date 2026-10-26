import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { refreshWorkingStatus, pauseWorkingStatusRefresh, disposeWorkingStatusRefresh } from "../src/commands/workingStatusRefresh";
import type { CommandDeps } from "../src/commands/shared";
import type { StatusGroups } from "../src/git/gitService";
import { SharedGitRead, type SharedReadOptions } from "../src/git/sharedGitRead";
import { window } from "./helpers/vscodeMock";

/**
 * 실제 실행의 close 또는 provider 응답을 원하는 생명주기 경계까지 보류한다.
 * @returns T 형식의 결과 Promise와 테스트에서 그 결과를 완료할 resolve 함수
 */
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/**
 * 실제 공유 실행기와 Changes 명령을 연결해 UI 적용·소비자 취소·close 경계를 제어한다.
 * @param t timer와 미완료 조회를 회수할 테스트 컨텍스트
 * @returns 명령 의존성, 공유 조회, 관찰값, provider 응답과 Native close를 조절할 함수
 */
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous: StatusGroups = { staged: [{ status: "M", path: "previous.txt" }], unstaged: [] };
  const current: StatusGroups = { staged: [], unstaged: [{ status: "A", path: "current.txt" }] };
  const close = gate<StatusGroups>(), stats = gate<StatusGroups>();
  const signals: AbortSignal[] = [], statsSignals: AbortSignal[] = [];
  const applied: StatusGroups[] = [];
  const calls = { cli: 0, stats: 0 };
  let generation = 0, provider: StatusGroups | undefined;
  let readProvider = async () => provider;
  const shared = new SharedGitRead<StatusGroups>(async signal => {
    signals.push(signal);
    const value = signals.length === 1 ? await close.promise : current;
    signal.throwIfAborted();
    return value;
  }, value => structuredClone(value));
  const service = {
    getStatusGeneration: () => generation, mutatedRecently: () => false,
    getStatusGroups: (options: SharedReadOptions) => { calls.cli++; return shared.read(options); },
    addStatusStats: async (_groups: StatusGroups, signal: AbortSignal) => {
      calls.stats++; statsSignals.push(signal); return stats.promise;
    },
  };
  const deps = {
    registry: { get: () => service },
    changesView: { getActiveRepo: () => "/repo", setStatusGroups: (value: StatusGroups) => applied.push(value) },
    vscodeGitStatus: { getStatusGroups: () => readProvider(), getStatusRevision: () => 0 },
  } as unknown as CommandDeps;
  const originalWindowState = window.state;
  t.after(async () => {
    window.state = originalWindowState;
    disposeWorkingStatusRefresh(deps); close.resolve(previous); stats.resolve(current);
    await shared.dispose(); await settle();
  });
  return {
    deps, shared, close, stats, previous, current, signals, statsSignals, applied, calls,
    provider: (value?: StatusGroups) => { provider = value; },
    providerRead: (read: typeof readProvider) => { readProvider = read; },
    invalidate: () => { generation++; shared.invalidate(); },
    focused: (value: boolean) => { window.state = { focused: value }; },
  };
}

test("focus pause releases a Changes consumer before generation retry and preserves the next focused result", async t => {
  const f = fixture(t);
  const running = refreshWorkingStatus(f.deps, { reason: "viewReady" });
  await settle();
  assert.equal(f.signals.length, 1);
  assert.equal(pauseWorkingStatusRefresh(f.deps), 1);
  assert.equal(f.signals[0].aborted, true);
  f.invalidate(); f.close.resolve(f.previous);
  await running; await settle();
  assert.equal(f.calls.cli, 1);
  assert.equal(f.applied.length, 0);
  await refreshWorkingStatus(f.deps, { reason: "windowFocusedReconcile", forceGit: true });
  assert.equal(f.signals.length, 2);
  assert.deepEqual(f.applied, [f.current]);
});

test("another API consumer keeps the shared Git read and its latest generation after Changes pauses", async t => {
  const f = fixture(t);
  const running = refreshWorkingStatus(f.deps, { reason: "viewReady" });
  await settle();
  const external = f.shared.read();
  void external.catch(() => undefined);
  pauseWorkingStatusRefresh(f.deps);
  assert.equal(f.signals[0].aborted, false);
  f.invalidate(); f.close.resolve(f.previous);
  await running;
  assert.deepEqual(await external, f.current);
  assert.equal(f.signals.length, 2);
  assert.equal(f.calls.cli, 1);
  assert.equal(f.applied.length, 0);
});

test("focus pause cancels deferred CLI fallback and stats without clearing the displayed snapshot", async t => {
  const f = fixture(t); f.provider(f.previous);
  await refreshWorkingStatus(f.deps, { reason: "documentSaved" });
  assert.deepEqual(f.applied, [f.previous]);
  pauseWorkingStatusRefresh(f.deps);
  t.mock.timers.tick(1000); await settle();
  assert.deepEqual(f.calls, { cli: 0, stats: 0 });
  assert.deepEqual(f.applied, [f.previous]);
});

test("late stats completion after focus pause cannot overwrite the cached display", async t => {
  const f = fixture(t); f.provider(f.previous);
  await refreshWorkingStatus(f.deps, { reason: "vscodeGit:state" });
  t.mock.timers.tick(300); await settle();
  assert.equal(f.statsSignals.length, 1);
  pauseWorkingStatusRefresh(f.deps);
  assert.equal(f.statsSignals[0].aborted, true);
  f.stats.resolve({ staged: [{ status: "M", path: "previous.txt", additions: 9 }], unstaged: [] });
  await settle();
  assert.deepEqual(f.applied, [f.previous]);
});

test("a provider snapshot resolving after pause cannot start a fallback Git read", async t => {
  const f = fixture(t), provider = gate<StatusGroups>();
  f.providerRead(() => provider.promise);
  const running = refreshWorkingStatus(f.deps, { reason: "viewReady" });
  pauseWorkingStatusRefresh(f.deps);
  provider.resolve(f.previous);
  await running;
  assert.equal(f.calls.cli, 0);
  assert.equal(f.applied.length, 0);
});

test("a rapid focus return waits for the cancelled owned close and applies one current request", async t => {
  const f = fixture(t);
  const old = refreshWorkingStatus(f.deps, { reason: "viewReady" });
  await settle();
  pauseWorkingStatusRefresh(f.deps); f.invalidate();
  const current = refreshWorkingStatus(f.deps, { reason: "windowFocusedReconcile" });
  await settle();
  assert.equal(f.signals.length, 1);
  f.close.resolve(f.previous);
  await Promise.all([old, current]);
  assert.equal(f.signals.length, 2);
  assert.deepEqual(f.applied, [f.current]);
});

// 이미 Changes drain에 쌓인 자동 pass도 비활성화 뒤에는 새로운 소비자를 만들면 안 된다.
test("queued automatic display reads defer until focus returns", async t => {
  const f = fixture(t); f.focused(false);
  await refreshWorkingStatus(f.deps, { reason: "viewReady", focusScoped: true });
  assert.equal(f.calls.cli, 0);
  assert.equal(f.applied.length, 0);
  assert.equal(pauseWorkingStatusRefresh(f.deps), 0);
  f.focused(true); f.close.resolve(f.current);
  await refreshWorkingStatus(f.deps, { reason: "windowFocusedReconcile", focusScoped: true });
  assert.equal(f.calls.cli, 1);
  assert.deepEqual(f.applied, [f.current]);
});

// 표시용 자동 pass만 지연하며 사용자가 직접 기다리는 명령/API 호출은 계속 허용한다.
test("an explicitly awaited status request can still run while the window is unfocused", async t => {
  const f = fixture(t); f.focused(false); f.close.resolve(f.current);
  await refreshWorkingStatus(f.deps, { forceGit: true, reason: "command" });
  assert.equal(f.calls.cli, 1);
  assert.deepEqual(f.applied, [f.current]);
});
