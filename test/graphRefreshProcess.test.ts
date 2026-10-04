import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readGraphRefreshSnapshot } from "../src/git/graphRefreshFingerprint";
import { runGit } from "../src/git/gitExec";
import { GraphRefreshLifecycleCoordinator } from "../src/webview/graphRefreshCoordinator";
import { GraphReadLifecycleCoordinator, readGraphPageData } from "../src/webview/graphPageLoading";
import { GitLogService } from "../src/git/gitLogService";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { loadCommitWindowAroundWithRange, loadDirectCommitWindow } from "../src/git/gitLogWindow";

const execute = promisify(execFile);

/** 테스트가 직접 만든 Git 자식 PID만 읽어 다른 작업의 프로세스에 닿지 않게 한다. */
async function gitChildren(): Promise<number[]> {
  const { stdout } = await execute("ps", ["-Ao", "pid=,ppid=,comm="], { encoding: "utf8" });
  return stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match && Number(match[2]) === process.pid && (/(?:^|\/|\()git\)?$/.test(match[3]) || path.basename(match[3]) === path.basename(process.execPath)) ? [Number(match[1])] : [];
  });
}

/** stdin의 기본 EOF 정책과 무관하게 대기하는 조회 fixture로 실제 spawn·취소·close를 검증한다. */
async function suspendedGit(t: TestContext): Promise<{ root: string; executable: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-graph-reader-")), executable = path.join(root, "git-reader");
  await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, executable };
}

/** 실제 자식 프로세스의 시작·종료를 짧은 상한 안에서 기다리며 timeout을 숨기지 않는다. */
async function waitForChildren(expected: number): Promise<number[]> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const children = await gitChildren();
    if (children.length === expected) return children;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${expected} owned Git children`);
}

test("폐기한 Graph의 지문 조회는 Git 실행기에 속한 실제 자식 두 개를 종료한다", { skip: process.platform === "win32" }, async t => {
  const fixture = await suspendedGit(t);
  const failures: string[] = [];
  const coordinator = new GraphRefreshLifecycleCoordinator({
    readFingerprint: (root, signal) => readGraphRefreshSnapshot(root, (_args, cwd, options) =>
      runGit(["status"], cwd, { signal: options?.signal, executable: fixture.executable }), signal),
    reloadGraph: async () => { throw new Error("Cancelled read must not reload"); },
    publishAfterReload: async () => undefined, invalidateReload: () => undefined,
    info: () => undefined, error: event => { failures.push(event); },
  });
  t.after(async () => {
    coordinator.dispose();
    for (const pid of await gitChildren()) process.kill(pid, "SIGTERM");
  });
  const ready = coordinator.runDirect({ repoRoot: fixture.root, cause: "ready" });
  const children = await waitForChildren(2);
  coordinator.dispose();
  assert.equal(await ready, false);
  await waitForChildren(0);
  assert.deepEqual(failures, []);
  for (const pid of children) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("숨긴 Graph 본문 조회도 log와 status를 담당하는 실제 자식 두 개를 종료한다", { skip: process.platform === "win32" }, async t => {
  const fixture = await suspendedGit(t);
  const coordinator = new GraphReadLifecycleCoordinator();
  const root = fixture.root;
  const service = {
    getCommitPage: async (_limit: number, _skip: number, _refs: string[], _local: boolean, signal?: AbortSignal) => {
      await runGit(["log"], root, { signal, executable: fixture.executable }); return [];
    },
    getVirtualCommits: async (signal?: AbortSignal) => {
      await runGit(["status"], root, { signal, executable: fixture.executable }); return [];
    },
  };
  t.after(async () => {
    coordinator.cancel("test-cleanup");
    for (const pid of await gitChildren()) process.kill(pid, "SIGTERM");
  });
  const page = coordinator.run(root, "page", signal => readGraphPageData(service, {
    skip: 0, readLimit: 301, refs: [], readVirtualCommits: true, signal,
  }));
  const children = await waitForChildren(2);
  coordinator.cancel("hidden");
  assert.equal(await page, undefined);
  await waitForChildren(0);
  for (const pid of children) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("취소된 서비스·ref 입력·점프 조회는 Git 프로세스나 손상 ref fallback을 시작하지 않는다", async t => {
  const rows: unknown[] = [];
  const dispose = setGitExecutionObserver(row => rows.push(row));
  t.after(dispose);
  const controller = new AbortController(); controller.abort();
  const signal = controller.signal, service = new GitLogService(process.cwd());
  await assert.rejects(service.getCommitPage(10, 0, [], false, signal));
  await assert.rejects(service.getCommitPage(10, 0, ["HEAD"], false, signal));
  await assert.rejects(service.getVirtualCommits(signal));
  await assert.rejects(service.getLocalBranchSnapshot(signal));
  await assert.rejects(loadCommitWindowAroundWithRange(process.cwd(), "HEAD", { before: 0, after: 10, signal }));
  await assert.rejects(loadDirectCommitWindow(process.cwd(), "HEAD", 10, signal));
  assert.deepEqual(rows, []);
});

test("새 Graph 조회의 controller는 이전 작업의 늦은 finally에 의해 취소되지 않는다", async () => {
  const coordinator = new GraphReadLifecycleCoordinator();
  let oldSignal!: AbortSignal, currentSignal!: AbortSignal, finish!: () => void;
  const old = coordinator.run("/old", "page", signal => {
    oldSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const current = coordinator.run("/new", "commitWindow", async signal => {
    currentSignal = signal;
    await new Promise<void>(resolve => { finish = resolve; });
    return "new result";
  });
  assert.equal(await old, undefined);
  assert.equal(oldSignal.aborted, true);
  assert.equal(currentSignal.aborted, false);
  finish();
  assert.equal(await current, "new result");
});

test("본문 조회의 실제 오류는 전파하되 아직 남아 있는 병렬 조회는 함께 종료한다", async () => {
  const coordinator = new GraphReadLifecycleCoordinator(), failure = new Error("log failed");
  let statusSignal!: AbortSignal;
  const service = {
    getCommitPage: async () => { throw failure; },
    getVirtualCommits: (signal?: AbortSignal): Promise<never[]> => {
      assert.ok(signal); statusSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  };
  await assert.rejects(coordinator.run("/repo", "page", signal => readGraphPageData(service, {
    skip: 0, readLimit: 301, refs: [], readVirtualCommits: true, signal,
  })), error => error === failure);
  assert.equal(statusSignal.aborted, true);
});
