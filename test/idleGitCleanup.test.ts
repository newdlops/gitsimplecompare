import assert from "node:assert/strict";
import test from "node:test";
import { IdleGitCleanup, type GitMonitorProcess, type GitMonitorSnapshot } from "../src/git/idleGitCleanup";

/** OS 경계만 가짜 시계·프로세스 목록으로 대체하며 후보 판정·재검증은 제품 서비스를 실행한다. */
function setup(owned = true, beforeStop?: (canStop: () => boolean) => Promise<void>) {
  let now = 0, busy = false, lastUsed: number | undefined;
  let snapshot: GitMonitorSnapshot = { complete: true, monitors: [{
    identity: { pid: 1234, ppid: 1, pgid: 1234, uid: 501, started: "Sun Oct 4 10:00:00 2026", executable: "/git" },
    repoRoot: "/unused-repo", socket: "/unused-repo/.git/fsmonitor--daemon.ipc", socketIdentity: "disk:42", owned,
  }] };
  const stopped: GitMonitorProcess[] = [];
  const service = new IdleGitCleanup({ inspect: async () => structuredClone(snapshot), stop: async (candidate, canStop) => {
    await beforeStop?.(canStop);
    if (!canStop()) throw new DOMException("activity resumed", "AbortError");
    stopped.push(candidate);
  },
    busy: () => busy, lastUsed: () => lastUsed, now: () => now, log: () => undefined });
  return { service, stopped, setNow: (value: number) => { now = value; }, setBusy: (value: boolean) => { busy = value; },
    setLastUsed: (value: number) => { lastUsed = value; }, snapshot };
}

test("opt-in automatic cleanup recovers detached monitors left by a previous VS Code session", async () => {
  const fixture = setup(false);
  assert.deepEqual(await fixture.service.candidates(5), []);
  fixture.setNow(300001);
  assert.equal((await fixture.service.candidates(5)).length, 1);
  assert.equal((await fixture.service.candidates(5, true)).length, 1);
  assert.equal(fixture.stopped.length, 0);
});

test("an unowned foreground monitor remains protected from automatic cleanup", async () => {
  const fixture = setup(false); fixture.snapshot.monitors[0].identity.ppid = 99;
  await fixture.service.candidates(1); fixture.setNow(61000);
  assert.equal((await fixture.service.candidates(1)).length, 1);
  assert.deepEqual(await fixture.service.candidates(1, true), []);
});

test("a write starting during OS revalidation preserves the selected monitor", async () => {
  const fixture = setup(true, async canStop => { await Promise.resolve(); fixture.setBusy(true); assert.equal(canStop(), false); });
  await fixture.service.candidates(1); fixture.setNow(61000);
  const selected = await fixture.service.candidates(1);
  assert.deepEqual(await fixture.service.cleanup(selected, 1), { stopped: 0, kept: 1, failed: 0 });
  assert.equal(fixture.stopped.length, 0);
});

test("active work resets the idle interval even when the daemon has zero CPU", async () => {
  const fixture = setup();
  await fixture.service.candidates(1);
  fixture.setNow(61000); fixture.setBusy(true);
  assert.deepEqual(await fixture.service.candidates(1), []);
  fixture.setBusy(false); fixture.setNow(80000);
  assert.deepEqual(await fixture.service.candidates(1), []);
  fixture.setNow(141000);
  assert.equal((await fixture.service.candidates(1)).length, 1);
});

test("PID reuse, socket replacement and a newly active repository are protected after selection", async () => {
  for (const change of ["pid", "socket", "busy", "last-used", "other-window", "incomplete"] as const) {
    const fixture = setup();
    await fixture.service.candidates(1); fixture.setNow(61000);
    const selected = await fixture.service.candidates(1);
    assert.equal(selected.length, 1);
    if (change === "pid") fixture.snapshot.monitors[0].identity.started = "new process";
    if (change === "socket") fixture.snapshot.monitors[0].socketIdentity = "disk:99";
    if (change === "busy") fixture.setBusy(true);
    if (change === "last-used") fixture.setLastUsed(61000);
    if (change === "other-window") fixture.snapshot.monitors[0].protectedReason = "another-window";
    if (change === "incomplete") fixture.snapshot.complete = false;
    assert.deepEqual(await fixture.service.cleanup(selected, 1), { stopped: 0, kept: 1, failed: 0 });
    assert.equal(fixture.stopped.length, 0, change);
  }
});

test("only selected and revalidated candidates reach official stop; cancelled selection stops nothing", async () => {
  const fixture = setup();
  await fixture.service.candidates(1); fixture.setNow(61000);
  const selected = await fixture.service.candidates(1);
  assert.deepEqual(await fixture.service.cleanup([], 1), { stopped: 0, kept: 0, failed: 0 });
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await fixture.service.cleanup(selected, 1, false, controller.signal), { stopped: 0, kept: 1, failed: 0 });
  assert.equal(fixture.stopped.length, 0);
  assert.deepEqual(await fixture.service.cleanup(selected, 1, true), { stopped: 1, kept: 0, failed: 0 });
  assert.equal(fixture.stopped.length, 1);
});
