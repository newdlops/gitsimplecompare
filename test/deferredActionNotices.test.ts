import assert from "node:assert/strict";
import test from "node:test";
import { DeferredActionNotices, presentActionNotice } from "../src/ui/deferredActionNotices";

/** 알림 응답과 작업 완료를 테스트가 직접 제어하며 대기 시간을 흉내 내지 않는다. */
function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
/** 응답 콜백과 후속 finally가 끝날 때까지 현재 event loop만 진행한다. */
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("an immediate Undo selection waits for original completion before starting its own action", async () => {
  const ready = gate(), events: string[] = [];
  const owner = new DeferredActionNotices(error => { throw error; });
  const scope = owner.scope(ready.promise, () => true, async action => { events.push("run"); await action(async () => {}); });
  await presentActionNotice(scope, () => Promise.resolve("Undo"), async () => scope.run(async () => { events.push("undo"); }));
  await turn(); assert.deepEqual([...events], []);
  ready.resolve(); await turn(); assert.deepEqual(events, ["run", "undo"]); owner.cancel();
});

for (const boundary of ["cancel", "repository"] as const) test(`a late notification cannot execute after ${boundary}`, async () => {
  const notice = gate<string>(), owner = new DeferredActionNotices(error => { throw error; });
  let current = true, calls = 0;
  const scope = owner.scope(Promise.resolve(), () => current, async action => action(async () => {}));
  scope.present(() => notice.promise, () => { calls++; });
  if (boundary === "cancel") owner.cancel(); else current = false;
  notice.resolve("Undo"); await turn(); assert.equal(calls, 0); owner.cancel();
});

test("unanswered notices retain only a bounded set of actionable callbacks", async () => {
  const owner = new DeferredActionNotices(error => { throw error; }), notices = Array.from({ length: 40 }, () => gate<number>());
  const scope = owner.scope(Promise.resolve(), () => true, async action => action(async () => {})), received: number[] = [];
  for (const [index, notice] of notices.entries()) scope.present(() => notice.promise, () => { received.push(index); });
  notices.forEach((notice, index) => notice.resolve(index)); await turn();
  assert.deepEqual(received, Array.from({ length: 16 }, (_, index) => index + 24)); owner.cancel();
});

test("notification and late action failures are reported without an unhandled rejection", async () => {
  const errors: unknown[] = [], owner = new DeferredActionNotices(error => { errors.push(error); });
  const scope = owner.scope(Promise.resolve(), () => true, async action => action(async () => {}));
  const rejected = gate<string>(); scope.present(() => rejected.promise, () => assert.fail("Rejected notice has no selection"));
  rejected.reject(new Error("notice failed"));
  scope.present(() => Promise.resolve("Undo"), async () => { throw new Error("undo failed"); });
  await turn(); assert.deepEqual(errors.map(error => (error as Error).message), ["notice failed", "undo failed"]); owner.cancel();
});

test("automatic diagnostics wait for completion, coalesce, and receive lifecycle cancellation", async () => {
  const ready = gate(), owner = new DeferredActionNotices(error => { throw error; }), signals: AbortSignal[] = [];
  const done = gate(), scope = owner.scope(ready.promise, () => true, async action => action(async () => {}));
  scope.background(async () => assert.fail("Superseded read must not start"));
  scope.background(async signal => { signals.push(signal); await done.promise; });
  await turn(); assert.equal(signals.length, 0); ready.resolve(); await turn(); assert.equal(signals.length, 1);
  owner.cancel(); assert.equal(signals[0].aborted, true); done.resolve(); await turn();
});
