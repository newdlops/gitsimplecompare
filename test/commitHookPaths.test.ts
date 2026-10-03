import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { GitError } from "../src/git/gitExec";
import { readCommitHookGitDirectories, readHooksPathConfig } from "../src/git/commitHookPaths";

/** Git 실행 경계와 같은 종료 코드를 가진 실패를 만들어 fallback 정책을 검증한다. */
function failure(code: number, stderr = ""): GitError {
  return new GitError("fixture", stderr, "", Object.assign(new Error("fixture"), { code }));
}

test("없는 hooksPath는 Git의 첫 종료 코드만으로 판정해 같은 설정을 재조회하지 않는다", async () => {
  const calls: string[][] = [];
  const config = await readHooksPathConfig("/repo", async args => { calls.push(args); throw failure(1); });
  assert.deepEqual(config, {});
  assert.equal(calls.length, 1);
});

test("구형 Git의 scope 옵션 실패와 진단이 있는 실패는 기존 값 조회로 복원한다", async () => {
  for (const error of [failure(129, "unknown option"), failure(1, "unsupported scope")]) {
    const calls: string[][] = [];
    const config = await readHooksPathConfig("/repo", async args => {
      calls.push(args);
      if (calls.length === 1) throw error;
      return "custom hooks\n";
    });
    assert.deepEqual(config, { value: "custom hooks" });
    assert.equal(calls.length, 2);
  }
});

test("명시적인 빈 hooksPath와 설정 출처는 추가 Git 실행 없이 보존한다", async () => {
  let calls = 0;
  const config = await readHooksPathConfig("/repo", async () => { calls++; return "worktree\tfile:.git/config.worktree\t\n"; });
  assert.deepEqual(config, { scope: "worktree", origin: "file:.git/config.worktree", value: "" });
  assert.equal(calls, 1);
});

test("hooks와 common-dir의 절대 경로 두 개를 한 Git 프로세스에서 읽는다", async () => {
  const calls: string[][] = [];
  const hooks = path.resolve("/fixture/custom hooks"), common = path.resolve("/fixture/main/.git");
  const directories = await readCommitHookGitDirectories("/repo", async args => {
    calls.push(args); return `${hooks}\n${common}\n`;
  });
  assert.deepEqual(directories, { effectiveDirectory: hooks, commonDirectory: common });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["rev-parse", "--git-path", "hooks", "--git-common-dir"]);
});

test("구형 Git과 줄바꿈 경로처럼 모호한 batch 출력은 개별 조회로 돌아간다", async () => {
  for (const batch of ["--path-format=absolute\n.git/hooks\n.git\n", "/fixture/hooks\nwith newline\n/fixture/.git\n", undefined]) {
    const calls: string[][] = [];
    const directories = await readCommitHookGitDirectories(path.resolve("/fixture/repo"), async args => {
      calls.push(args);
      if (args.includes("--git-path") && args.includes("--git-common-dir")) {
        if (batch === undefined) throw failure(129);
        return batch;
      }
      return args.includes("--git-path") ? ".git/hooks\n" : ".git\n";
    });
    assert.deepEqual(directories, {
      effectiveDirectory: path.resolve("/fixture/repo/.git/hooks"), commonDirectory: path.resolve("/fixture/repo/.git"),
    });
    assert.equal(calls.length, 3);
  }
});
