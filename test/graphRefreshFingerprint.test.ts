import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createGraphRefreshFingerprint, readGraphRefreshFingerprint, readGraphRefreshSnapshot, type GraphFingerprintRunner,
} from "../src/git/graphRefreshFingerprint";
import { createGraphWorktreeBranchStatus } from "../src/webview/graphWorktrees";
import { runGit } from "../src/git/gitExec";
import { parseRemoteBranchTips } from "../src/git/graphBranchCatalog";

const head = "a".repeat(40);

/** 각 테스트의 runner가 받은 인자를 기록하고 지정한 porcelain과 refs를 반환한다. */
function fixtureRunner(worktrees: string, calls: string[][]): GraphFingerprintRunner {
  return async (args) => {
    calls.push(args);
    if (args[0] === "worktree") return worktrees;
    if (args[0] === "for-each-ref") return `refs/heads/main ${head}\n`;
    if (args[0] === "rev-parse") return head + "\n";
    if (args[0] === "symbolic-ref") return "refs/heads/main\n";
    throw new Error("Unexpected fingerprint command");
  };
}

test("fingerprint reads linked worktree HEAD and branch with only two Git processes", async () => {
  const root = path.resolve("/fixture/linked");
  const other = "b".repeat(40);
  const worktrees = `worktree /fixture/main\nHEAD ${other}\nbranch refs/heads/other\n\nworktree ${root}\nHEAD ${head}\nbranch refs/heads/main\n\n`;
  const calls: string[][] = [];
  const actual = await readGraphRefreshFingerprint(root, fixtureRunner(worktrees, calls));
  assert.equal(actual, createGraphRefreshFingerprint({
    head, symbolicHead: "refs/heads/main", refs: [`refs/heads/main ${head}`], worktrees: worktrees.split("\n\n"),
  }));
  assert.deepEqual(calls.map((args) => args[0]), ["for-each-ref", "worktree"]);
});

test("first Graph worktree badges reuse the fingerprint snapshot without another Git process", async () => {
  const root = path.resolve("/fixture/main"), linked = path.resolve("/fixture/linked");
  const raw = `worktree ${root}\nHEAD ${head}\nbranch refs/heads/main\n\nworktree ${linked}\nHEAD ${head}\nbranch refs/heads/linked\nlocked fixture\n\n`;
  const calls: string[][] = [];
  const snapshot = await readGraphRefreshSnapshot(root, fixtureRunner(raw, calls));
  const badges = createGraphWorktreeBranchStatus(snapshot.worktrees);
  assert.deepEqual(badges.map(row => [row.branch, row.path, row.isMain, row.locked]), [
    ["linked", linked, false, "fixture"], ["main", root, true, undefined],
  ]);
  assert.equal(snapshot.worktrees.length, 2);
  assert.equal(calls.length, 2);
});

test("remote snapshot preserves Git short names and symbolic HEAD fingerprint without another query", async () => {
  const root = path.resolve("/fixture/main"), fs = "\x1f";
  const refs = [
    ["refs/heads/main", head, "main"],
    ["refs/remotes/origin/main", head, "remotes/origin/main"],
    ["refs/remotes/origin/HEAD", head, "origin/HEAD"],
    ["refs/tags/v1", head, "v1"],
  ];
  const worktrees = `worktree ${root}\nHEAD ${head}\nbranch refs/heads/main\n\n`;
  const calls: string[][] = [];
  const snapshot = await readGraphRefreshSnapshot(root, async args => {
    calls.push(args);
    return args[0] === "for-each-ref" ? refs.map(row => row.join(fs)).join("\n") : worktrees;
  });
  assert.deepEqual(snapshot.remoteTips, [{ hash: head, name: "remotes/origin/main", fullRef: "refs/remotes/origin/main", kind: "remote" }]);
  assert.equal(snapshot.fingerprint, createGraphRefreshFingerprint({
    head, symbolicHead: "refs/heads/main", refs: refs.map(([ref, hash]) => `${ref} ${hash}`), worktrees: worktrees.split("\n\n"),
  }));
  assert.equal(calls.length, 2);
});

test("empty ref snapshot is complete while legacy rows keep the catalog fallback", async () => {
  const root = path.resolve("/fixture/main");
  const worktrees = `worktree ${root}\nHEAD ${head}\nbranch refs/heads/main\n\n`;
  const empty = await readGraphRefreshSnapshot(root, async args => args[0] === "worktree" ? worktrees : "");
  assert.deepEqual(empty.remoteTips, []);
  const legacy = await readGraphRefreshSnapshot(root, fixtureRunner(worktrees, []));
  assert.equal(legacy.remoteTips, undefined);
});

test("fingerprint cancellation reaches both Git commands and prevents later fallback launches", async () => {
  const controller = new AbortController();
  const signals: Array<AbortSignal | undefined> = [];
  const actual = readGraphRefreshSnapshot("/fixture/repo", async (_args, _cwd, options) => {
    signals.push(options?.signal);
    return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }));
  }, controller.signal);
  assert.deepEqual(signals, [controller.signal, controller.signal]);
  controller.abort();
  await assert.rejects(actual, error => error === controller.signal.reason);
  let calls = 0;
  await assert.rejects(readGraphRefreshSnapshot("/fixture/repo", async () => { calls++; return ""; }, controller.signal));
  assert.equal(calls, 0);
});

test("detached SHA-256 worktree keeps the same HEAD identity without extra processes", async () => {
  const root = path.resolve("/fixture/detached");
  const sha256 = "c".repeat(64);
  const worktrees = `worktree ${root}\nHEAD ${sha256}\ndetached\n\n`;
  const calls: string[][] = [];
  const actual = await readGraphRefreshFingerprint(root, fixtureRunner(worktrees, calls));
  assert.ok(actual.startsWith(sha256 + "\nDETACHED\n"));
  assert.equal(calls.length, 2);
});

test("missing, bare or incomplete worktree identity falls back to the original HEAD queries", async () => {
  const root = path.resolve("/fixture/main");
  for (const fields of ["bare", `HEAD ${head}`, `HEAD ${"0".repeat(40)}\nbranch refs/heads/main`, `HEAD broken\nbranch refs/heads/main`]) {
    const calls: string[][] = [];
    const actual = await readGraphRefreshFingerprint(root, fixtureRunner(`worktree ${root}\n${fields}\n\n`, calls));
    assert.ok(actual.startsWith(head + "\nrefs/heads/main\n"));
    assert.deepEqual(calls.map((args) => args[0]), ["for-each-ref", "worktree", "rev-parse", "symbolic-ref"]);
  }
  const calls: string[][] = [];
  await readGraphRefreshFingerprint(root, fixtureRunner("worktree /fixture/other\nbare\n\n", calls));
  assert.equal(calls.length, 4);
});

test("fallback preserves unborn HEAD failures and detached symbolic-ref failures", async () => {
  const root = path.resolve("/fixture/missing");
  const failure = new Error("HEAD does not exist");
  await assert.rejects(readGraphRefreshFingerprint(root, async (args) => {
    if (args[0] === "rev-parse") throw failure;
    return "";
  }), (error) => error === failure);
  const actual = await readGraphRefreshFingerprint(root, async (args) => {
    if (args[0] === "rev-parse") return head;
    if (args[0] === "symbolic-ref") throw new Error("detached");
    return "";
  });
  assert.ok(actual.startsWith(head + "\nDETACHED\n"));
});

test("real repository fingerprints match the previous queries across branch, linked, detached and symlink roots", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-fingerprint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = path.join(directory, "main repo");
  const linked = path.join(directory, "linked repo");
  const alias = path.join(directory, "symlink repo");
  const config = path.join(directory, "empty.gitconfig");
  await mkdir(repo);
  await writeFile(config, "");
  const env = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config };
  const git = (args: string[], cwd = repo) => execFileSync("git", args, {
    cwd, encoding: "utf8", env: { ...process.env, ...env },
  });
  git(["-c", "init.templateDir=", "init", "--initial-branch=main"]);
  git(["config", "core.hooksPath", directory]);
  git(["config", "user.name", "Fingerprint Test"]);
  git(["config", "user.email", "fingerprint@example.invalid"]);
  git(["config", "commit.gpgSign", "false"]);
  await writeFile(path.join(repo, "file.txt"), "base\n");
  git(["add", "file.txt"]);
  git(["commit", "--quiet", "-m", "fixture"]);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  git(["branch", "origin/main"]);
  git(["worktree", "add", "-b", "linked", linked]);
  await symlink(repo, alias, process.platform === "win32" ? "junction" : "dir");

  /** 실제 Git의 기존 fingerprint·원격 catalog와 새 두 조회의 재사용 결과가 같은지 비교한다. */
  async function check(root: string): Promise<void> {
    const calls: string[][] = [];
    const snapshot = await readGraphRefreshSnapshot(root, async (args, cwd) => {
      calls.push(args);
      return runGit(args, cwd, { env });
    });
    const [oldHead, symbolicHead, refs, worktrees] = await Promise.all([
      runGit(["rev-parse", "HEAD"], root, { env }),
      runGit(["symbolic-ref", "-q", "HEAD"], root, { env }).catch(() => "DETACHED"),
      runGit(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes", "refs/tags"], root, { env }),
      runGit(["worktree", "list", "--porcelain"], root, { env }),
    ]);
    assert.equal(snapshot.fingerprint, createGraphRefreshFingerprint({ head: oldHead, symbolicHead, refs: refs.split("\n"), worktrees: worktrees.split("\n\n") }));
    const remoteOutput = await runGit(["for-each-ref", "--format=%(objectname)\x1f%(refname:short)\x1f%(refname)", "refs/remotes"], root, { env });
    assert.deepEqual(snapshot.remoteTips, parseRemoteBranchTips(remoteOutput));
    assert.ok(snapshot.remoteTips?.some(tip => tip.fullRef === "refs/remotes/origin/main"));
    assert.equal(calls.length, 2, "일반 경로·linked·symlink 모두 두 프로세스로 기존 결과를 유지한다");
  }
  await check(repo);
  await check(linked);
  await check(alias);
  git(["checkout", "--quiet", "--detach"]);
  await check(repo);
});
