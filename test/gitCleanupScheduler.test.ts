import assert from "node:assert/strict";
import test from "node:test";
import { GitCleanupScheduler } from "../src/git/gitCleanupScheduler";

test("disabled cleanup schedules nothing; disabling or dispose aborts pending work and prevents rescheduling", async () => {
  const timers = new Map<number, () => void>(); let id = 0;
  const signals: AbortSignal[] = [];
  let complete: (() => void) | undefined;
  const scheduler = new GitCleanupScheduler(async signal => { signals.push(signal); await new Promise<void>(resolve => { complete = resolve; }); },
    { schedule: callback => { timers.set(++id, callback); return id; }, clear: value => { timers.delete(value as number); } });
  scheduler.configure(false); assert.equal(timers.size, 0);
  scheduler.configure(true); assert.equal(timers.size, 1);
  const scheduledId = id;
  scheduler.configure(true); assert.equal(id, scheduledId, "unchanged settings preserve the polling deadline");
  const callback = [...timers.values()][0]; timers.clear(); callback();
  assert.equal(signals.length, 1); assert.equal(timers.size, 0);
  scheduler.configure(false); assert.equal(signals[0].aborted, true);
  complete!(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 0);
  scheduler.configure(true); scheduler.dispose();
  assert.equal(timers.size, 0);
  scheduler.configure(true); callback();
  assert.equal(timers.size, 0); assert.equal(signals.length, 1);
});
