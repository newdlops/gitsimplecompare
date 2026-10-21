import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GitError, runGit, runGitReadPipeline, runGitWithInput } from "../src/git/gitExec";
import { setGitProcessPreparation } from "../src/git/gitProcessRunner";
import { gitProcesses } from "../src/git/gitProcessRegistry";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 임시 Native 저장소의 객체 ID·크기 목록을 기존 Git 경로로 읽어 비교 기준을 만든다. */
async function expectedSizes(root: string) {
  const objects = await runGit(["rev-list", "--objects", "--no-object-names", "HEAD"], root);
  return (await runGitWithInput(["cat-file", "--batch-check=%(objectsize)"], root, objects)).trim().split("\n").map(Number);
}

test("native object metadata preserves every row and sum with streamed stdout beyond maxBuffer", async t => {
  const f = await safetyFixture(t, "read-pipeline-native"), expected = await expectedSizes(f.root), received: number[] = [];
  const index = await readFile(path.join(f.root, ".git/index"));
  let pending = "";
  await runGitReadPipeline(["rev-list", "--objects", "--no-object-names", "HEAD"], ["cat-file", "--batch-check=%(objectsize)"], f.root, chunk => {
    const lines = (pending + chunk.toString()).split("\n"); pending = lines.pop()!; received.push(...lines.map(Number));
  }, { maxBuffer: 1 });
  assert.equal(pending, ""); assert.deepEqual(received, expected);
  assert.deepEqual(await readFile(path.join(f.root, ".git/index")), index);
  assert.equal(gitProcesses.isBusy(f.root), false);
});

test("an empty object range finishes both reads without inventing metadata", async t => {
  const f = await safetyFixture(t, "read-pipeline-empty");
  let bytes = 0;
  await runGitReadPipeline(["rev-list", "--objects", "HEAD", "^HEAD"], ["cat-file", "--batch-check=%(objectsize)"], f.root, chunk => { bytes += chunk.length; });
  assert.equal(bytes, 0); assert.equal(gitProcesses.isBusy(f.root), false);
});

for (const role of ["source", "target"] as const) {
  test(`a native ${role} failure keeps the real Git error and closes its sibling`, async t => {
    const f = await safetyFixture(t, "read-pipeline-failure");
    const source = role === "source" ? ["rev-list", "not-a-revision"] : ["rev-list", "--objects", "--no-object-names", "HEAD"];
    const target = role === "target" ? ["cat-file", "--not-a-real-option"] : ["cat-file", "--batch-check=%(objectsize)"];
    await assert.rejects(runGitReadPipeline(source, target, f.root, () => {}), error => {
      assert.ok(error instanceof GitError);
      assert.match(error.message, role === "source" ? /not-a-revision|unknown revision/ : /not-a-real-option|unknown option/); return true;
    });
    assert.equal(gitProcesses.isBusy(f.root), false);
    assert.equal(await git(f.root, "status", "--porcelain=v1"), "");
  });
}

test("a metadata parser error is preserved after both native queries close", async t => {
  const f = await safetyFixture(t, "read-pipeline-parser"), failure = new Error("invalid metadata value");
  await assert.rejects(runGitReadPipeline(["rev-list", "--objects", "--no-object-names", "HEAD"],
    ["cat-file", "--batch-check=%(objectsize)"], f.root, () => { throw failure; }), error => error === failure);
  assert.equal(gitProcesses.isBusy(f.root), false);
});

test("pipeline rejects writes before spawning and revalidates commands after preparation", async t => {
  const f = await safetyFixture(t, "read-pipeline-policy"), spawn = childProcess.spawn, calls: string[][] = [];
  t.mock.method(childProcess, "spawn", (...args: any[]) => { if (args[0] === "git") calls.push([...args[1]]); return (spawn as Function)(...args); });
  for (const [source, target] of [[["push"], ["cat-file"]], [["rev-list", "HEAD"], ["config", "unsafe.key", "value"]]]) {
    await assert.rejects(runGitReadPipeline(source, target, f.root, () => {}), /only accept read-only/);
  }
  assert.equal(calls.length, 0);
  const restore = setGitProcessPreparation(async (args, _root, options) => ({ options, args: args[0] === "rev-list" ? ["config", "unsafe.key", "value"] : [...args] }));
  try { await assert.rejects(runGitReadPipeline(["rev-list", "HEAD"], ["cat-file", "--batch-check"], f.root, () => {}), /produced a write command/); }
  finally { restore(); }
  assert.equal(calls.some(args => args[0] === "config"), false);
  await assert.rejects(git(f.root, "config", "--get", "unsafe.key"));
  assert.equal(gitProcesses.isBusy(f.root), false);
});

test("already-cancelled and failed-spawn pipelines settle without owned processes", async t => {
  const f = await safetyFixture(t, "read-pipeline-no-child"), source = ["rev-list", "HEAD"], target = ["cat-file", "--batch-check"];
  await assert.rejects(runGitReadPipeline(source, target, f.root, () => {}, { signal: AbortSignal.abort() }), error => error instanceof GitError && error.code === "ABORT_ERR");
  await assert.rejects(runGitReadPipeline(source, target, f.root, () => {}, { executable: path.join(f.root, "missing-executable") }), error => error instanceof GitError && error.code === "ENOENT");
  assert.equal(gitProcesses.isBusy(f.root), false);
});

/** gate를 열기 전에는 consumer가 읽지 않고 producer는 stdout drain만 기다리게 한다. */
async function blockedFixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-pipeline-backpressure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "transport-git");
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path'), {once}=require('node:events');
(async()=>{
 const role=process.argv[2]==='rev-list'?'source':'target', root=process.env.GSC_PIPE_ROOT;
 fs.writeFileSync(path.join(root,role+'.pid'),String(process.pid));
 if(role==='target' && process.env.GSC_EARLY_EXIT==='1') return;
 if(role==='source' && process.env.GSC_PRODUCER_EXIT==='1') { process.stdout.write(Buffer.alloc(16*1024*1024,97)); setTimeout(()=>process.exit(0),150); return; }
 if(role==='source') { for(let i=0;i<256;i++) { if(!process.stdout.write(Buffer.alloc(65536,97))) await once(process.stdout,'drain'); }
  fs.writeFileSync(path.join(root,'source.done'),'done');
 } else { while(!fs.existsSync(path.join(root,'release'))) await new Promise(r=>setTimeout(r,10));
  let bytes=0; for await(const chunk of process.stdin) bytes+=chunk.length; process.stdout.write(String(bytes)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
`, { mode: 0o755 });
  return { root, executable, env: { GSC_PIPE_ROOT: root }, readTimeoutMs: 0 };
}

/** 준비 파일이 실제 생성될 때까지만 기다리고 무한 대기하지 않는다. */
async function waitFile(file: string): Promise<string> {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    try { return await readFile(file, "utf8"); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  throw new Error("Pipeline fixture did not start.");
}

test("backpressure prevents the producer completing while the consumer is gated", { skip: process.platform === "win32" }, async t => {
  const f = await blockedFixture(t), controller = new AbortController(); t.after(() => controller.abort());
  let output = "";
  const pending = runGitReadPipeline(["rev-list"], ["cat-file"], f.root, chunk => { output += chunk; }, { ...f, signal: controller.signal });
  const observed = pending.then(() => undefined, error => error);
  await Promise.all([waitFile(path.join(f.root, "source.pid")), waitFile(path.join(f.root, "target.pid"))]);
  await assert.rejects(readFile(path.join(f.root, "source.done")), { code: "ENOENT" });
  await writeFile(path.join(f.root, "release"), "release");
  assert.equal(await observed, undefined); assert.equal(Number(output), 256 * 65536);
  assert.equal(gitProcesses.isBusy(f.root), false);
});

test("cancellation and timeout close both blocked read processes before rejecting", { skip: process.platform === "win32" }, async t => {
  for (const timeout of [false, true]) {
    const f = await blockedFixture(t), controller = new AbortController(); t.after(() => controller.abort());
    const pending = runGitReadPipeline(["rev-list"], ["cat-file"], f.root, () => {},
      { ...f, signal: controller.signal, readTimeoutMs: timeout ? 3000 : 0 });
    const observed = pending.then(() => undefined, error => error);
    const pids = await Promise.all([waitFile(path.join(f.root, "source.pid")), waitFile(path.join(f.root, "target.pid"))]);
    if (!timeout) controller.abort();
    const error = await observed;
    assert.ok(error instanceof GitError); assert.equal(error.code, timeout ? "ETIMEDOUT" : "ABORT_ERR");
    for (const pid of pids) assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" });
    assert.equal(gitProcesses.isBusy(f.root), false);
  }
});

test("an early successful consumer cannot silently accept an unfinished producer", { skip: process.platform === "win32" }, async t => {
  const f = await blockedFixture(t), spawn = childProcess.spawn, pids: number[] = [];
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const child = (spawn as Function)(...args); if (args[0] === f.executable && child.pid) pids.push(child.pid); return child;
  });
  await assert.rejects(runGitReadPipeline(["rev-list"], ["cat-file"], f.root, () => {},
    { ...f, env: { ...f.env, GSC_EARLY_EXIT: "1" } }), error => error instanceof GitError && error.code === "GIT_INPUT_CLOSED");
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(gitProcesses.isBusy(f.root), false);
});

test("cancellation drains an already-exited producer whose stdout is blocked by its consumer", { skip: process.platform === "win32", timeout: 10000 }, async t => {
  const f = await blockedFixture(t), controller = new AbortController(), spawn = childProcess.spawn;
  const children: childProcess.ChildProcess[] = [];
  let sourceExited!: () => void;
  const sourceExit = new Promise<void>(resolve => { sourceExited = resolve; });
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const child = (spawn as Function)(...args);
    if (args[0] === f.executable) {
      children.push(child);
      if (args[1][0] === "rev-list") child.once("exit", sourceExited);
    }
    return child;
  });
  t.after(() => {
    controller.abort();
    for (const child of children) { child.stdout?.unpipe(); child.stdout?.resume(); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });
  const observed = runGitReadPipeline(["rev-list"], ["cat-file"], f.root, () => {},
    { ...f, signal: controller.signal, env: { ...f.env, GSC_PRODUCER_EXIT: "1" } }).then(() => undefined, error => error);
  await Promise.all([waitFile(path.join(f.root, "source.pid")), waitFile(path.join(f.root, "target.pid")), sourceExit]);
  assert.equal(gitProcesses.isBusy(f.root), true);
  controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const error = await Promise.race([observed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Exited producer retained unread stdout.")), 3000); })]);
    assert.ok(error instanceof GitError); assert.equal(error.code, "ABORT_ERR");
  } finally { clearTimeout(timer); }
  assert.equal(gitProcesses.isBusy(f.root), false);
});

test("pipeline cancellation also reaps both SIGTERM-resistant process groups and their children", { skip: process.platform === "win32", timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-pipeline-resistant-")), executable = path.join(root, "git-fixture");
  const controller = new AbortController();
  const started = Date.now(), diagnostic = process.env.GSC_PIPELINE_TERMINATION_DIAGNOSTICS === "1";
  /** 종료 소유권 문제가 있을 때만 실제 단계와 소요 시간을 출력하고 기존 10초 예산은 유지한다. */
  const phase = (name: string, fields: unknown = {}) => { if (diagnostic) console.log(JSON.stringify({ phase: name, elapsedMs: Date.now() - started, fields })); };
  const stopLog = diagnostic ? gitProcesses.setLogger((event, fields) => phase(event, fields)) : () => {};
  t.after(stopLog);
  t.after(async () => {
    controller.abort();
    for (const name of ["rev-list.ready", "cat-file.ready"]) {
      try { for (const pid of JSON.parse(await readFile(path.join(root, name), "utf8"))) {
        try { process.kill(pid, "SIGKILL"); } catch { /* 이 테스트가 만든 프로세스의 실패 시 정리다. */ }
      } } catch { /* 준비 전에 실패한 역할은 PID 파일이 없다. */ }
    }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
process.on('SIGTERM',()=>{});
if(process.env.GSC_CHILD==='1') setInterval(()=>{},1000);
else { const child=spawn(process.execPath,[__filename],{env:{...process.env,GSC_CHILD:'1'},stdio:'inherit'});
 setTimeout(()=>fs.writeFileSync(path.join(process.env.GSC_PIPE_ROOT,process.argv[2]+'.ready'),JSON.stringify([process.pid,child.pid])),100);
 setInterval(()=>{},1000); }
`, { mode: 0o755 });
  phase("fixtureWritten");
  const observed = runGitReadPipeline(["rev-list"], ["cat-file"], root, () => {},
    { executable, signal: controller.signal, readTimeoutMs: 0, env: { GSC_PIPE_ROOT: root } }).then(() => undefined, error => error);
  t.after(async () => { controller.abort(); await observed; });
  const groups = await Promise.all([waitFile(path.join(root, "rev-list.ready")).then(value => { phase("sourceReady", value); return value; }),
    waitFile(path.join(root, "cat-file.ready")).then(value => { phase("targetReady", value); return value; })]);
  phase("abortRequested");
  controller.abort();
  const error = await observed; phase("closeConfirmed"); assert.ok(error instanceof GitError); assert.equal(error.code, "ABORT_ERR");
  for (const pid of groups.flatMap(value => JSON.parse(value))) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(gitProcesses.isBusy(root), false);
});

test("backpressure preserves the former two-read deadline budget for slow producers and consumers", { skip: process.platform === "win32", timeout: 25000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-pipeline-budget-")), executable = path.join(root, "git-fixture");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(executable, `#!${process.execPath}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 if(process.argv[2]==='rev-list') { await wait(3200); process.stdout.write(Buffer.alloc(4*1024*1024,97)); }
 else { let bytes=0,first=true; for await(const chunk of process.stdin) { bytes+=chunk.length;
  if(first) { first=false; await wait(3200); } } process.stdout.write(String(bytes)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
`, { mode: 0o755 });
  const options = { executable, readTimeoutMs: 6000 };
  const input = await runGit(["rev-list"], root, options);
  assert.equal(Number(await runGitWithInput(["cat-file"], root, input, options)), 4 * 1024 * 1024);
  let output = "";
  await runGitReadPipeline(["rev-list"], ["cat-file"], root, chunk => { output += chunk; }, options);
  assert.equal(Number(output), 4 * 1024 * 1024);
  assert.equal(gitProcesses.isBusy(root), false);
});
