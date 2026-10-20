import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "../src/git/gitExec";
import { gitProcesses } from "../src/git/gitProcessRegistry";
import { GitTagService, type GitTagRunner } from "../src/git/gitTagService";

/** 실제 Git 실행기에서 취소/close를 시험할 소유 자식만 생성한다. 사용자 저장소나 다른 PID를 사용하지 않는다. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-tag-process-")), executable = path.join(root, "git-fixture");
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');
process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100));
fs.writeFileSync(path.join(process.cwd(),process.argv[2]+'.pid'),String(process.pid));setInterval(()=>{},1000);\n`, { mode: 0o755 });
  const controller = new AbortController();
  t.after(async () => { controller.abort(); await gitProcesses.dispose(); await rm(root, { recursive: true, force: true }); });
  const runner: GitTagRunner = (args, cwd, options) => args[0] === "remote" ? Promise.resolve("origin\n") :
    runGit(args, cwd, { ...options, executable });
  return { root, controller, service: new GitTagService(root, runner) };
}

/** 시작 파일은 signal handler 등록 뒤 작성한다. OS 시작 속도와 실제 취소 시간을 구분한다. */
async function ready(root: string, command: string): Promise<number> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { return Number(await readFile(path.join(root, `${command}.pid`), "utf8")); }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  throw new Error(`Tag fixture did not start ${command}`);
}

test("cancelled tag status waits for local and network child process close", { skip: process.platform === "win32", timeout: 15000 }, async t => {
  const f = await fixture(t), pending = f.service.getTagStatuses({ signal: f.controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  const pids = await Promise.all([ready(f.root, "for-each-ref"), ready(f.root, "ls-remote")]);
  f.controller.abort(); await rejected;
  assert.equal(gitProcesses.isBusy(f.root), false);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  t.diagnostic(JSON.stringify({ startedChildren: pids.length, ownedChildrenAfterCancel: 0 }));
});

test("cancelling one of two real network consumers keeps the other child alive until its last owner leaves", { skip: process.platform === "win32", timeout: 15000 }, async t => {
  const f = await fixture(t), other = new AbortController(); t.after(() => other.abort());
  const first = f.service.getRemoteTagRefs({ signal: f.controller.signal }), second = f.service.getRemoteTagRefs({ signal: other.signal });
  const rejectedFirst = assert.rejects(first, { name: "AbortError" }), rejectedSecond = assert.rejects(second, { name: "AbortError" });
  const pid = await ready(f.root, "ls-remote");
  f.controller.abort(); await rejectedFirst; assert.doesNotThrow(() => process.kill(pid, 0));
  other.abort(); await rejectedSecond;
  assert.equal(gitProcesses.isBusy(f.root), false); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
