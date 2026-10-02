import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitError, RunGitOptions } from "../src/git/gitExec";
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

test("readonly status preserves execution options and disables optional locks on fsmonitor retry", async () => {
  const calls: RunGitOptions[] = [];
  const controller = new AbortController();
  const options: RunGitOptions = {
    executable: "/custom/git",
    signal: controller.signal,
    maxBuffer: 4_096,
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "1" },
  };
  const guard = new GitStatusFsMonitorGuard(async (_args, _cwd, actual) => {
    calls.push(actual!);
    if (calls.length === 1) throw new GitError("status failed", "fsmonitor daemon is unavailable");
    return { stdout: "clean", stderr: "" };
  }, () => undefined);
  assert.equal(await guard.run(["status", "--porcelain"], "/repo", options), "clean");
  assert.equal(calls.length, 2);
  for (const actual of calls) {
    assert.deepEqual(actual.env, { GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" });
    assert.equal(actual.executable, options.executable);
    assert.equal(actual.signal, controller.signal);
    assert.equal(actual.maxBuffer, options.maxBuffer);
  }
  assert.equal(options.env?.GIT_OPTIONAL_LOCKS, "1", "호출자의 환경 객체는 변경하지 않는다");
});

test("readonly status reports untracked files without rewriting the real Git index", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-readonly-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repoRoot = path.join(directory, "repo");
  const globalConfig = path.join(directory, "empty.gitconfig");
  await mkdir(repoRoot);
  await writeFile(globalConfig, "");
  const env = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig };
  const git = (args: string[], optionalLocks = "1") => execFileSync("git", args, {
    cwd: repoRoot,
    env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: optionalLocks },
    encoding: "utf8",
  });
  git(["-c", "init.templateDir=", "init", "--initial-branch=main"]);
  git(["config", "core.fsmonitor", "false"]);
  git(["config", "core.hooksPath", directory]);
  git(["config", "user.name", "Status Test"]);
  git(["config", "user.email", "status-test@example.invalid"]);
  git(["config", "commit.gpgSign", "false"]);
  const tracked = path.join(repoRoot, "tracked.txt");
  await writeFile(tracked, "unchanged content\n");
  git(["add", "tracked.txt"]);
  git(["commit", "--quiet", "-m", "fixture"]);
  // 내용은 같고 stat 정보만 바꿔 일반 status가 index를 다시 쓰는 조건을 실제 Git으로 재현한다.
  const modifiedTime = new Date(Date.now() + 60_000);
  await utimes(tracked, modifiedTime, modifiedTime);
  await writeFile(path.join(repoRoot, "untracked.txt"), "new file\n");
  const indexPath = path.join(repoRoot, ".git", "index");
  const before = await readFile(indexPath);
  const status = await new GitStatusFsMonitorGuard().run(
    ["status", "--porcelain", "-z", "--untracked-files=all"], repoRoot, { env }
  );
  assert.equal(status, "?? untracked.txt\0");
  assert.deepEqual(await readFile(indexPath), before, "조회 전용 status는 index의 stat 캐시까지 그대로 유지한다");
  assert.equal(git(["status", "--porcelain", "-z", "--untracked-files=all"]), status);
  assert.notDeepEqual(await readFile(indexPath), before, "일반 status가 index를 갱신하므로 fixture가 차이를 실제로 검증한다");
});
