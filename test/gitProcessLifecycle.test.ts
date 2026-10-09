import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GitError, runGit, runGitBuffer, runGitStream, runGitStreamWithInput, runGitWithInput, type RunGitOptions } from "../src/git/gitExec";
import { gitProcesses } from "../src/git/gitProcessRegistry";

/** 실제로 SIGTERM을 무시하는 부모·자식을 만들며 실패한 테스트에서도 해당 PID만 회수한다. */
async function stubbornGit(t: TestContext, leaderExits = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-owned-read-"));
  const executable = path.join(root, "git-fixture");
  const ready = path.join(root, "ready.json");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const {spawn} = require('node:child_process');
if (process.env.GSC_CHILD === '1' || process.env.GSC_LEADER_EXITS !== '1') process.on('SIGTERM', () => {});
if (process.env.GSC_CHILD === '1') {
  setInterval(() => {}, 1000);
} else {
  const child = spawn(process.execPath, [__filename], {env: {...process.env, GSC_CHILD:'1'}, stdio:process.env.GSC_LEADER_EXITS === '1' ? 'ignore' : 'inherit'});
  setTimeout(() => { fs.writeFileSync(process.env.GSC_READY, JSON.stringify([process.pid,child.pid])); process.stdout.write('ready'); }, 100);
  setInterval(() => {}, 1000);
}
`, { mode: 0o755 });
  t.after(async () => {
    try { for (const pid of JSON.parse(await readFile(ready, "utf8"))) {
      try { process.kill(pid, "SIGKILL"); } catch { /* 이미 회수한 자식이다. */ }
    } } catch { /* spawn 실패 때는 준비 파일이 없다. */ }
    await rm(root, { recursive: true, force: true });
  });
  return { root, ready, executable, env: { GSC_READY: ready, GSC_LEADER_EXITS: leaderExits ? '1' : '0' } };
}

/**
 * 신호 처리기 등록 뒤 작성한 준비 파일을 기다려 OS 실행 지연과 종료 시간을 분리한다.
 * - 시작에는 최대 10초를 허용하지만, 취소 뒤 종료 상한은 bounded의 5초를 유지한다.
 * @param file 실제 fixture가 부모·자식 PID를 게시할 파일
 * @returns 두 프로세스가 신호를 받을 준비를 끝냈을 때의 PID 배열
 */
async function waitForReady(file: string): Promise<number[]> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(file, "utf8")); } catch { await new Promise(r => setTimeout(r, 20)); }
  }
  throw new Error("Fixture did not start.");
}

/** 시작 대기 중의 실패도 즉시 관찰해 준비 실패 뒤 unhandled rejection을 남기지 않는다. */
function observedFailure(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(() => undefined, error => error);
}

/** 실제 Git 오류를 검증한다. 기본 close 상한은 5초이고 deadline 검사는 남은 대기 시간을 더한다. */
async function expectGitFailure(observed: Promise<unknown>, code?: string, timeoutMs = 5000): Promise<void> {
  const error = await bounded(observed, timeoutMs);
  assert.ok(error instanceof GitError);
  if (code) assert.equal(error.code, code);
}

/** 제한 시간 내 close가 발생하지 않으면 무한히 대기하지 않고 실제 수명 정책의 실패를 보고한다. */
async function bounded<T>(pending: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([pending, new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Owned Git did not close after termination.")), timeoutMs);
  })]); } finally { clearTimeout(timer!); }
}

test("leader close preserves cleanup of a resistant child with independent stdio", { skip: process.platform === "win32" }, async t => {
  const fixture = await stubbornGit(t, true), controller = new AbortController();
  t.after(() => controller.abort());
  const pending = runGit(["status"], fixture.root, { ...fixture, signal: controller.signal });
  const observed = observedFailure(pending);
  const pids = await waitForReady(fixture.ready);
  controller.abort(); await expectGitFailure(observed, "ABORT_ERR");
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

for (const kind of ["text", "buffer", "stream", "stdin", "stdinStream"] as const) {
  test(`${kind} cancellation closes a SIGTERM-resistant Git process and its child`, { skip: process.platform === "win32" }, async t => {
    const fixture = await stubbornGit(t);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const options = { ...fixture, signal: controller.signal };
    const pending = kind === "text" ? runGit(["status"], fixture.root, options)
      : kind === "buffer" ? runGitBuffer(["show"], fixture.root, options)
      : kind === "stdin" ? runGitWithInput(["cat-file", "--batch"], fixture.root, "input", options)
      : kind === "stdinStream" ? runGitStreamWithInput(["cat-file", "--batch-check"], fixture.root, "input", () => undefined, options)
      : runGitStream(["show"], fixture.root, () => undefined, options);
    const observed = observedFailure(pending);
    const pids = await waitForReady(fixture.ready);
    controller.abort();
    await expectGitFailure(observed, "ABORT_ERR");
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

test("read deadline closes stubborn children and reports ETIMEDOUT", { skip: process.platform === "win32" }, async t => {
  const fixture = await stubbornGit(t);
  // OS 시작 대기(최대 10초) 전에 deadline이 fixture를 죽이지 않도록 충분히 뒤에 둔다.
  // 전체 대기는 deadline 15초 + 기존 종료 상한 5초에 고정하며 시작 시간만큼 다시 늘리지 않는다.
  const readTimeoutMs = 15000, started = Date.now();
  const options = { ...fixture, readTimeoutMs } as RunGitOptions;
  const pending = runGit(["-c", "credential.helper=", "--literal-pathspecs", "status"], fixture.root, options);
  const observed = observedFailure(pending);
  const pids = await waitForReady(fixture.ready);
  await expectGitFailure(observed, "ETIMEDOUT", Math.max(1, started + readTimeoutMs + 5000 - Date.now()));
  assert.ok(Date.now() - started >= readTimeoutMs, "the configured deadline must not fire early");
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("read deadline does not interrupt a write or hook-capable command", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-write-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "write-git");
  await writeFile(executable, `#!${process.execPath}\nsetTimeout(() => process.stdout.write('done'), 150);\n`, { mode: 0o755 });
  for (const args of [["commit"], ["fetch"], ["push"], ["config", "core.fsmonitor", "false"], ["branch", "new-branch"]]) {
    assert.equal(await runGit(args, root, { executable, readTimeoutMs: 20 } as RunGitOptions), "done");
  }
});

test("repeated extension sessions leave no owned foreground Git monitors after awaited dispose", { skip: process.platform === "win32" }, async t => {
  for (let session = 0; session < 3; session++) {
    const fixture = await stubbornGit(t);
    const pending = runGit(["fsmonitor--daemon", "run", "--no-detach"], fixture.root, fixture);
    const observed = observedFailure(pending);
    const pids = await waitForReady(fixture.ready), pid = pids[0];
    assert.equal(gitProcesses.ownsMonitor(pid, fixture.root), true);
    await gitProcesses.dispose(); await expectGitFailure(observed);
    for (const child of pids) assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  }
});
