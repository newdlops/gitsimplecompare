import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GitError, runGit, runGitBuffer, runGitStream, runGitWithInput, type RunGitOptions } from "../src/git/gitExec";

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

/** 준비 파일은 자식이 신호 처리기를 등록한 뒤 작성되므로 시작 경쟁 없이 취소를 시험한다. */
async function waitForReady(file: string): Promise<number[]> {
  for (let i = 0; i < 100; i++) {
    try { return JSON.parse(await readFile(file, "utf8")); } catch { await new Promise(r => setTimeout(r, 20)); }
  }
  throw new Error("Fixture did not start.");
}

/** 제한 시간 내 close가 발생하지 않으면 무한히 대기하지 않고 실제 수명 정책의 실패를 보고한다. */
async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([pending, new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Owned Git did not close after termination.")), 5000);
  })]); } finally { clearTimeout(timer!); }
}

test("leader close preserves cleanup of a resistant child with independent stdio", { skip: process.platform === "win32" }, async t => {
  const fixture = await stubbornGit(t, true), controller = new AbortController();
  const pending = runGit(["status"], fixture.root, { ...fixture, signal: controller.signal });
  const rejected = assert.rejects(bounded(pending), error => error instanceof GitError && error.code === "ABORT_ERR");
  const pids = await waitForReady(fixture.ready);
  controller.abort(); await rejected;
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

for (const kind of ["text", "buffer", "stream", "stdin"] as const) {
  test(`${kind} cancellation closes a SIGTERM-resistant Git process and its child`, { skip: process.platform === "win32" }, async t => {
    const fixture = await stubbornGit(t);
    const controller = new AbortController();
    const options = { ...fixture, signal: controller.signal };
    const pending = kind === "text" ? runGit(["status"], fixture.root, options)
      : kind === "buffer" ? runGitBuffer(["show"], fixture.root, options)
      : kind === "stdin" ? runGitWithInput(["cat-file", "--batch"], fixture.root, "input", options)
      : runGitStream(["show"], fixture.root, () => undefined, options);
    const rejected = assert.rejects(bounded(pending), error => error instanceof GitError && error.code === "ABORT_ERR");
    const pids = await waitForReady(fixture.ready);
    controller.abort();
    await rejected;
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

test("read deadline closes stubborn children and reports ETIMEDOUT", { skip: process.platform === "win32" }, async t => {
  const fixture = await stubbornGit(t);
  const options = { ...fixture, readTimeoutMs: 1000 } as RunGitOptions;
  const pending = runGit(["-c", "credential.helper=", "--literal-pathspecs", "status"], fixture.root, options);
  const rejected = assert.rejects(bounded(pending), error => error instanceof GitError && error.code === "ETIMEDOUT");
  const pids = await waitForReady(fixture.ready);
  await rejected;
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
