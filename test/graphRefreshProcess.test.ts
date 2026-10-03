import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readGraphRefreshSnapshot } from "../src/git/graphRefreshFingerprint";
import { runGit } from "../src/git/gitExec";
import { GraphRefreshLifecycleCoordinator } from "../src/webview/graphRefreshCoordinator";

const execute = promisify(execFile);

/** 테스트가 직접 만든 Git 자식 PID만 읽어 다른 작업의 프로세스에 닿지 않게 한다. */
async function gitChildren(): Promise<number[]> {
  const { stdout } = await execute("ps", ["-Ao", "pid=,ppid=,comm="], { encoding: "utf8" });
  return stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match && Number(match[2]) === process.pid && /(?:^|\/|\()git\)?$/.test(match[3]) ? [Number(match[1])] : [];
  });
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

test("폐기한 Graph의 지문 조회는 stdin을 기다리는 실제 Git 자식 두 개를 종료한다", { skip: process.platform === "win32" }, async t => {
  const failures: string[] = [];
  const coordinator = new GraphRefreshLifecycleCoordinator({
    readFingerprint: (root, signal) => readGraphRefreshSnapshot(root, (_args, cwd, options) =>
      // -w 없이 stdin의 해시만 계산하므로 저장소·index·작업트리를 수정하지 않는다.
      runGit(["hash-object", "--stdin"], cwd, { signal: options?.signal }), signal),
    reloadGraph: async () => { throw new Error("Cancelled read must not reload"); },
    publishAfterReload: async () => undefined, invalidateReload: () => undefined,
    info: () => undefined, error: event => { failures.push(event); },
  });
  t.after(async () => {
    coordinator.dispose();
    for (const pid of await gitChildren()) process.kill(pid, "SIGTERM");
  });
  const ready = coordinator.runDirect({ repoRoot: process.cwd(), cause: "ready" });
  const children = await waitForChildren(2);
  coordinator.dispose();
  assert.equal(await ready, false);
  await waitForChildren(0);
  assert.deepEqual(failures, []);
  for (const pid of children) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
