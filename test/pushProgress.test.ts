import assert from "node:assert/strict";
import test from "node:test";
import { isPushCancelled, pushFailureText, withPushProgress } from "../src/ui/pushProgress";
import { SequentialPushError } from "../src/git/sequentialPush";
import { window, __executedCommands, __informationMessages, __outputLines, __resetWindowMessages, __resetOutputLines } from "./helpers/vscodeMock";

test("sequential notification counts confirmed commits and refreshes views after completion", async t => {
  __resetWindowMessages(); __resetOutputLines();
  const reports: Array<{ message?: string; increment?: number }> = [];
  let options: any;
  t.mock.method(window, "withProgress", async (value: unknown, task: any) => {
    options = value;
    return task({ report: (event: any) => reports.push(event) }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  });
  const result = await withPushProgress("/test/repo", async execution => {
    execution.onProgress!({ phase: "planning", strategy: "single", completed: 0, total: 0 });
    execution.onProgress!({ phase: "ready", strategy: "sequential", completed: 0, total: 2 });
    execution.onProgress!({ phase: "pushing", strategy: "sequential", completed: 0, total: 2, commit: "abcdef0123456789" });
    execution.onProgress!({ phase: "pushed", strategy: "sequential", completed: 1, total: 2 });
    execution.onProgress!({ phase: "pushing", strategy: "sequential", completed: 1, total: 2, commit: "234567890abcdef" });
    execution.onProgress!({ phase: "pushed", strategy: "sequential", completed: 2, total: 2 });
    return "done";
  });
  assert.equal(result, "done");
  assert.equal(options.cancellable, true);
  assert.deepEqual(reports.filter(report => report.increment).map(report => report.increment), [50, 50]);
  assert.match(JSON.stringify(reports), /Pushing commit 1\/2 \(abcdef0\)/);
  assert.match(JSON.stringify(reports), /Pushing commit 2\/2 \(2345678\)/);
  assert.equal(__executedCommands.filter(command => command.id === "gitSimpleCompare.refreshChanges").length, 1);
  assert.match(__outputLines.join("\n"), /push transfer pushed.*"completed":2/);
});

test("native cancellation aborts the Git task, preserves partial counts and disposes its listener", async t => {
  __resetWindowMessages();
  let cancel = () => {}, disposed = false;
  t.mock.method(window, "withProgress", async (_options: unknown, task: any) => task({ report() {} }, {
    isCancellationRequested: false, onCancellationRequested: (listener: () => void) => { cancel = listener; return { dispose() { disposed = true; } }; },
  }));
  await assert.rejects(withPushProgress("/test/repo", async options => {
    options.onProgress!({ phase: "pushed", strategy: "sequential", completed: 1, total: 4 });
    cancel();
    assert.equal(options.signal?.aborted, true);
    throw new SequentialPushError(new Error("cancelled"), { strategy: "sequential", completed: 1, total: 4 }, true);
  }), isPushCancelled);
  assert.equal(disposed, true);
  assert.match(__informationMessages.join("\n"), /1\/4.*Check the remote before retrying/);
  assert.ok(__executedCommands.some(command => command.id === "gitSimpleCompare.refreshChanges"));
});

test("partial failure explains retained remote commits without claiming the entire push failed", async t => {
  __resetWindowMessages();
  const error = new SequentialPushError(new Error("remote hook rejected"), { strategy: "sequential", completed: 2, total: 5 });
  await assert.rejects(withPushProgress("/test/repo", async () => { throw error; }), value => value === error);
  assert.match(pushFailureText(error), /2\/5.*remain on the remote.*Retry to continue/);
  assert.match(pushFailureText(error), /remote hook rejected/);
  assert.equal(isPushCancelled(error), false);
  assert.ok(__executedCommands.some(command => command.id === "gitSimpleCompare.refreshChanges"));
});
