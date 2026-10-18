import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runGitWithInput } from "../src/git/gitExec";
import { GitLogService } from "../src/git/gitLogService";
import { readGraphLocalBranchSnapshot } from "../src/git/graphLocalBranches";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/**
 * 실제 upstream 이력을 공유하는 다수 브랜치를 fast-import로 준비한다.
 * @param t 저장소 정리 수명 @param branches 로컬 추적 브랜치 수 @param history 원격 기준점까지의 커밋 수
 * @returns 사용자 저장소와 분리된 루트·기준 커밋·브랜치 이름 목록
 */
async function fixture(t: TestContext, branches = 1000, history = 3000) {
  const f = await safetyFixture(t, "graph-branch-tracking"), input: string[] = [], config: string[] = [];
  await git(f.root, "remote", "add", "origin", "unused-local-tracking");
  for (let index = 1; index <= history; index++) {
    const text = `history ${index}\n`;
    input.push(`commit refs/heads/history\nmark :${index}\ncommitter Tracking <tracking@example.test> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(text)}\n${text}from ${index === 1 ? f.head : `:${index - 1}`}\nM 100644 inline history.txt\ndata ${Buffer.byteLength(text)}\n${text}\n`);
  }
  input.push(`reset refs/remotes/origin/main\nfrom :${history}\n\n`);
  const names = Array.from({ length: branches }, (_, index) => `bench-${String(index).padStart(4, "0")}`);
  for (const [index, name] of names.entries()) {
    input.push(`reset refs/heads/${name}\nfrom :${index + 1}\n\n`);
    config.push(`[branch "${name}"]\n remote = origin\n merge = refs/heads/main\n`);
  }
  await runGitWithInput(["fast-import", "--quiet"], f.root, input.join("") + "done\n");
  const file = join(f.root, ".git", "config");
  await writeFile(file, await readFile(file, "utf8") + config.join(""));
  await git(f.root, "pack-refs", "--all");
  return { ...f, names };
}

/** 실제 실행을 유지하며 명령별 포맷을 기록한다. @param t 원래 spawn을 복구할 수명 @returns 복사 가능한 argv 목록 */
function observe(t: TestContext): string[][] {
  const calls: string[][] = [], spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push([...args[1]]);
    return (spawn as Function)(...args);
  });
  return calls;
}

test("checkout refresh batches a thousand tracking counts without revisiting each branch history", async t => {
  const f = await fixture(t), service = new GitLogService(f.root);
  await service.getLocalBranchSnapshot();
  await git(f.root, "switch", f.names[0]);
  const calls = observe(t), started = performance.now();
  const actual = await service.getLocalBranchSnapshot(), elapsedMs = performance.now() - started;
  const measured = calls.map(args => [...args]);
  assert.deepEqual(actual, await readGraphLocalBranchSnapshot(f.root));
  assert.equal(actual.branches.find(branch => branch.name === f.names[0])?.current, true);
  assert.equal(actual.branches.find(branch => branch.name === f.names[0])?.behind, 2999);
  t.diagnostic(JSON.stringify({ branches: f.names.length, elapsedMs: +elapsedMs.toFixed(1), gitProcesses: measured.length }));
  assert.equal(measured.some(args => args.some(arg => arg.includes("%(upstream:track)"))), false,
    "checkout reread each branch history instead of batching shared tracking bases");
  assert.ok(measured.length <= 3, `tracking refresh used ${measured.length} Git processes`);
});

test("small branch lists retain their one-process snapshot read", async t => {
  const f = await safetyFixture(t, "small-graph-tracking"), service = new GitLogService(f.root);
  await service.getLocalBranchSnapshot();
  const calls = observe(t);
  assert.equal((await service.getLocalBranchSnapshot()).branches[0].name, "main");
  assert.equal(calls.length, 1);
});

test("warm tracking reads observe checkout, moved or gone upstreams, config edits and ambiguous short names", async t => {
  const f = await fixture(t, 160, 240), service = new GitLogService(f.root);
  await service.getLocalBranchSnapshot();
  /** 변경 직후 같은 서비스가 반환한 전체 행을 캐시 없는 기존 Git 조회와 대조한다. */
  const check = async () => assert.deepEqual(await service.getLocalBranchSnapshot(), await readGraphLocalBranchSnapshot(f.root));
  await git(f.root, "switch", f.names[5]); await check();
  await git(f.root, "update-ref", "refs/remotes/origin/other", f.head);
  await git(f.root, "config", `branch.${f.names[1]}.merge`, "refs/heads/other"); await check();
  await git(f.root, "config", `branch.${f.names[2]}.remote`, ".");
  await git(f.root, "config", `branch.${f.names[2]}.merge`, "refs/heads/main"); await check();
  await git(f.root, "update-ref", "refs/remotes/origin/main", f.head); await check();
  await git(f.root, "update-ref", "-d", "refs/remotes/origin/main"); await check();
  await git(f.root, "update-ref", "refs/remotes/origin/main", "refs/heads/history"); await check();
  await git(f.root, "branch", "-m", f.names[3], "renamed/tracking"); await check();
  await git(f.root, "tag", f.names[4], f.head); await check();
});
