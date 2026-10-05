import assert from "node:assert/strict";
import test from "node:test";
import { beginGitExecution, GitExecutionTiming, setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { registerStatusIndex } from "../src/git/statusIndexOwnership";

test("execution timing separates synchronous spawn from completion without logging argument values", (t) => {
  const timings: GitExecutionTiming[] = [];
  t.after(setGitExecutionObserver(timing => timings.push(timing)));
  let now = 100;
  const probe = beginGitExecution(["-c", "token=secret", "-C", "/secret-path", "--literal-pathspecs", "status"], "/repo", "/git", () => now)!;
  now += 250;
  probe.spawnReturned();
  now += 20;
  probe.finish("success");
  assert.deepEqual(timings, [{ repoRoot: "/repo", executable: "/git", command: "status", syncSpawnMs: 250, elapsedMs: 270, outcome: "success" }]);
  assert.equal(JSON.stringify(timings).includes("secret"), false);
});

test("disposing an observer suppresses its in-flight results and preserves a newer registration", () => {
  const first: GitExecutionTiming[] = [];
  const second: GitExecutionTiming[] = [];
  const resetFirst = setGitExecutionObserver(timing => first.push(timing));
  const oldProbe = beginGitExecution(["status"], "/repo", "/git")!;
  const resetSecond = setGitExecutionObserver(timing => second.push(timing));
  resetFirst();
  oldProbe.finish("success");
  const currentProbe = beginGitExecution(["log"], "/repo", "/git")!;
  currentProbe.spawnReturned();
  currentProbe.finish("error");
  resetSecond();
  assert.equal(first.length, 0);
  assert.equal(second.length, 1);
  assert.equal(second[0]?.outcome, "error");
  assert.equal(beginGitExecution(["status"], "/repo", "/git"), undefined);
});

test("observer failures cannot turn a successful Git command into an error or publish twice", (t) => {
  let calls = 0;
  t.after(setGitExecutionObserver(() => { calls++; throw new Error("disposed output"); }));
  const probe = beginGitExecution(["commit", "-m", "private message"], "/repo", "/git")!;
  probe.spawnReturned();
  assert.doesNotThrow(() => probe.finish("success"));
  assert.doesNotThrow(() => probe.finish("error"));
  assert.equal(calls, 1);
});

test("fast spawn failures keep their error code so retry delays can be diagnosed", (t) => {
  const timings: GitExecutionTiming[] = [];
  t.after(setGitExecutionObserver(timing => timings.push(timing)));
  const probe = beginGitExecution(["status"], "/repo", "/git", () => 1_000)!;
  probe.spawnReturned();
  probe.finish("error", "EMFILE");
  assert.equal(timings[0]?.code, "EMFILE");
  assert.equal(timings[0]?.elapsedMs, 0);
  assert.equal(timings[0]?.outcome, "error");
});

test("status diagnostics classify private ownership and mode without leaking index paths or environment values", t => {
  const timings: GitExecutionTiming[] = [];
  t.after(setGitExecutionObserver(timing => timings.push(timing)));
  const index = "/private/secret-index", environment = { GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "1", TOKEN: "secret-token" };
  const unregister = registerStatusIndex(index); t.after(unregister);
  const probe = beginGitExecution(["-c", "password=secret", "status", "--untracked-files=normal", "--", "--untracked-files=all"], "/repo", "/git", () => 10, environment)!;
  environment.GIT_OPTIONAL_LOCKS = "0"; unregister(); probe.finish("success");
  assert.equal(timings[0].statusIndex, "private");
  assert.equal(timings[0].statusUntracked, "normal");
  assert.equal(timings[0].optionalLocks, "1");
  assert.equal(JSON.stringify(timings).includes("secret"), false);
});

test("status diagnostics distinguish configured, complete and skipped untracked scans with bounded fields", t => {
  const timings: GitExecutionTiming[] = [];
  t.after(setGitExecutionObserver(timing => timings.push(timing)));
  const cases = [
    { args: ["status"], env: {}, index: "repository", mode: "configured", locks: "unset" },
    { args: ["status", "-uall"], env: { GIT_OPTIONAL_LOCKS: "0" }, index: "repository", mode: "all", locks: "0" },
    { args: ["status", "-uno"], env: { GIT_INDEX_FILE: "/caller", GIT_OPTIONAL_LOCKS: "garbage" }, index: "caller", mode: "none", locks: "unset" },
  ];
  for (const expected of cases) {
    beginGitExecution(expected.args, "/repo", "/git", () => 10, expected.env)!.finish("success");
    const actual = timings.at(-1)!;
    assert.equal(actual.statusIndex, expected.index); assert.equal(actual.statusUntracked, expected.mode); assert.equal(actual.optionalLocks, expected.locks);
  }
  beginGitExecution(["commit", "-m", "secret"], "/repo", "/git", () => 10, { GIT_OPTIONAL_LOCKS: "1" })!.finish("success");
  assert.equal(timings.at(-1)?.statusIndex, undefined);
});
