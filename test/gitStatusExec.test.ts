import assert from "node:assert/strict";
import test from "node:test";
import { GitError } from "../src/git/gitExec";
import { GitStatusFsMonitorGuard, hasFsMonitorFailure } from "../src/git/gitStatusExec";

test("successful fsmonitor warning activates command-scope fallback without repeating first status", async () => {
  let now = 1_000;
  const calls: string[][] = [];
  const warnings: Array<Record<string, unknown>> = [];
  const guard = new GitStatusFsMonitorGuard(
    async (args) => {
      calls.push(args);
      return calls.length === 1
        ? { stdout: " M file.ts\n", stderr: "error: fsmonitor_ipc__send_query: unspecified error\n" }
        : { stdout: " M file.ts\n", stderr: "" };
    },
    (_event, fields) => warnings.push(fields),
    () => now,
    5_000
  );

  assert.equal(await guard.run(["status", "--porcelain=v1"], "/repo"), " M file.ts\n");
  assert.equal(calls.length, 1);
  await guard.run(["status", "--porcelain=v1"], "/repo");
  assert.deepEqual(calls[1].slice(0, 3), ["-c", "core.fsmonitor=false", "status"]);
  assert.equal(warnings.length, 1);

  now += 5_001;
  await guard.run(["status", "--porcelain=v1"], "/repo");
  assert.equal(calls[2][0], "status", "cooldown 뒤에는 복구된 전역 설정을 다시 시험한다");
});

test("failed fsmonitor status retries once with fallback while unrelated errors propagate", async () => {
  const calls: string[][] = [];
  const guard = new GitStatusFsMonitorGuard(async (args) => {
    calls.push(args);
    if (calls.length === 1) {
      throw new GitError("git status failed", "fsmonitor daemon is unavailable");
    }
    return { stdout: "clean", stderr: "" };
  }, () => undefined);
  assert.equal(await guard.run(["status", "--porcelain"], "/repo"), "clean");
  assert.deepEqual(calls[1].slice(0, 3), ["-c", "core.fsmonitor=false", "status"]);

  const fatal = new GitStatusFsMonitorGuard(async () => {
    throw new GitError("not a repository", "fatal: not a git repository");
  }, () => undefined);
  await assert.rejects(() => fatal.run(["status"], "/other"), /not a repository/);
});

test("fsmonitor diagnostic matcher ignores unrelated status warnings", () => {
  assert.equal(hasFsMonitorFailure("error: fsmonitor_ipc__send_query: unspecified error"), true);
  assert.equal(hasFsMonitorFailure("warning: untracked cache is disabled"), false);
});
