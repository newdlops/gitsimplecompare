import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test, { type TestContext } from "node:test";
import { PrivateStatusIndex } from "../src/git/privateStatusIndex";
import { runGit, setGitExecutableResolver, withGitConfigOverrides } from "../src/git/gitExec";
import { gitProcesses } from "../src/git/gitProcessRegistry";
import { parseWorkingTreeV2, workingTreeSnapshot } from "../src/git/workingTreeStatusFormat";
import { registerStatusIndex } from "../src/git/statusIndexOwnership";
import { readColdStatus } from "../src/git/coldStatusScan";
import { StatusIndexWarmCache } from "../src/git/statusIndexWarmCache";
import { StatusIndexWarmup } from "../src/git/statusIndexWarmup";
import { setGitReadTimeoutResolver } from "../src/git/gitProcessRunner";

/** 실제 큰 index와 단계별 rename·미추적 경로를 만들어 첫 전체 결과를 Git 원본과 비교한다. */
async function repository(t: TestContext, count = 5001) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-cold-status-test-")), root = path.join(directory, "repo");
  await mkdir(root);
  t.after(async () => { await gitProcesses.dispose(); await rm(directory, { recursive: true, force: true }); });
  await runGit(["init", "-q"], root);
  await runGit(["config", "user.name", "Fixture"], root);
  await runGit(["config", "user.email", "fixture@example.invalid"], root);
  await runGit(["config", "core.fsmonitor", "false"], root);
  await runGit(["config", "core.untrackedCache", "false"], root);
  const folders = count >= 5000 ? 512 : 16;
  await Promise.all(Array.from({ length: folders }, (_, folder) => mkdir(path.join(root, "src", String(folder)), { recursive: true })));
  let next = 0;
  await Promise.all(Array.from({ length: 24 }, async () => {
    while (next < count) { const value = next++; await writeFile(path.join(root, "src", String(value % folders), `${value}.txt`), "base\n"); }
  }));
  await writeFile(path.join(root, ".gitignore"), "ignored/\n*.ignored\n");
  await writeFile(path.join(root, "rename.txt"), "original\n");
  await runGit(["add", "."], root); await runGit(["commit", "-qm", "initial"], root);
  await rename(path.join(root, "rename.txt"), path.join(root, "renamed name.txt"));
  await runGit(["add", "-A"], root);
  await writeFile(path.join(root, "src/0/0.txt"), "edit\n");
  const names = ["new/deep/file.txt", "[glob]/file.txt", "line\nbreak.txt", " leading.txt", ":(glob)file.txt", "ignored/file.txt", "src/1/hidden.ignored"];
  for (const name of names.filter(value => process.platform !== "win32" || (!value.includes("\n") && !value.includes(":")))) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), "new\n");
  }
  const index = await readFile(path.join(root, ".git/index"));
  const expected = workingTreeSnapshot(root, parseWorkingTreeV2(await runGit(["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=all"], root)));
  return { directory, root, index, expected };
}

/** 파일 생성으로 실제 Git 단계 시작을 관찰하고 테스트 종료 때 무한 대기하지 않도록 상한을 둔다. */
async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    try { if ((await readFile(file)).length) return; } catch { /* 아직 단계 표식이 없다. */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Expected Git phase did not start.");
}

test("the first large snapshot is complete before an optional directory-cache build finishes", { timeout: 60000, skip: process.platform === "win32" }, async t => {
  const f = await repository(t), executable = path.join(f.directory, "git-fixture"), warming = path.join(f.directory, "warming.pid");
  const native = (await runGit(["--exec-path"], f.root)).trim();
  // 같은 Git 설치의 실행 파일로 전달하되 normal cache 생성만 의도적으로 멈춘다.
  const git = path.resolve(native, "git");
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2);
if(args.includes('--untracked-files=normal')){
  fs.writeFileSync(${JSON.stringify(warming)},String(process.pid));setInterval(()=>{},1000);
}else{
  const child=cp.spawn(${JSON.stringify(git)},args,{stdio:'inherit'});
  child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));
}
`, { mode: 0o755 });
  const reset = setGitExecutableResolver(() => executable);
  const index = new PrivateStatusIndex(f.root, () => undefined), controller = new AbortController();
  let complete = false;
  const pending = index.read(controller.signal).then(value => { complete = true; return value; });
  void pending.catch(() => undefined);
  try {
    await Promise.race([pending, waitForFile(warming)]);
    assert.equal(complete, true, "building the optional directory cache cannot block the first complete snapshot");
    const actual = await pending;
    const sorted = (groups: typeof actual.groups) => ({ staged: [...groups.staged].sort((a,b)=>a.path.localeCompare(b.path)), unstaged: [...groups.unstaged].sort((a,b)=>a.path.localeCompare(b.path)) });
    assert.deepEqual(sorted(actual.groups), sorted(f.expected.groups));
    assert.deepEqual(await readFile(path.join(f.root, ".git/index")), f.index);
    await waitForFile(warming);
    const pid = Number(await readFile(warming, "utf8"));
    await index.dispose();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { controller.abort(); await pending.catch(() => undefined); await index.dispose(); reset(); }
});

/** 원본 racy-clean 경계를 유지한 소유 index를 만들고 테스트 종료 때 등록을 해제한다. */
async function privateEnvironment(t: TestContext, f: Awaited<ReturnType<typeof repository>>) {
  const index = path.join(f.directory, "private-index"), info = await stat(path.join(f.root, ".git/index"));
  await writeFile(index, f.index); await utimes(index, info.mtimeMs / 1000, Math.floor(info.mtimeMs / 1000));
  t.after(registerStatusIndex(index));
  return withGitConfigOverrides({ GIT_INDEX_FILE: index }, { "core.fsmonitor": "false", "core.splitIndex": "false" });
}

/** 실제 전체 Git 상태를 매번 읽어 병렬 출력의 순서와 무관하게 변경 내용을 비교한다. */
async function expectedGroups(root: string) {
  return workingTreeSnapshot(root, parseWorkingTreeV2(await runGit(["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=all"], root))).groups;
}

/** 표시 순서만 제외하고 stage·rename 원본·경로를 포함한 모든 변경의 의미를 비교한다. */
function sortedGroups(groups: Awaited<ReturnType<typeof expectedGroups>>) {
  return { staged: [...groups.staged].sort((a,b)=>a.path.localeCompare(b.path)), unstaged: [...groups.unstaged].sort((a,b)=>a.path.localeCompare(b.path)) };
}

test("cold scopes preserve native ignore rules, nested repositories, symlinks and literal filenames", { timeout: 60000 }, async t => {
  const f = await repository(t, 640);
  await writeFile(path.join(f.root, ".gitignore"), "ignored/\n*.ignored\nignored-again/*\n!ignored-again/keep.txt\n");
  await mkdir(path.join(f.root, "ignored-again"));
  await writeFile(path.join(f.root, "ignored-again/keep.txt"), "keep\n");
  await writeFile(path.join(f.root, "ignored-again/skip.txt"), "skip\n");
  await writeFile(path.join(f.directory, "global-ignore"), "*.global-ignore\n");
  await runGit(["config", "core.excludesFile", path.join(f.directory, "global-ignore")], f.root);
  await writeFile(path.join(f.root, "hidden.global-ignore"), "ignored\n");
  await mkdir(path.join(f.root, "nested")); await runGit(["init", "-q"], path.join(f.root, "nested"));
  await writeFile(path.join(f.root, "nested/file.txt"), "inside nested repository\n");
  await runGit(["init", "-q"], path.join(f.root, "src"));
  if (process.platform !== "win32") await symlink("ignored", path.join(f.root, "linked"));
  const env = await privateEnvironment(t, f);
  const parsed = await readColdStatus(f.root, env, new AbortController().signal, () => undefined);
  assert.ok(parsed);
  assert.deepEqual(sortedGroups(workingTreeSnapshot(f.root, parsed).groups), sortedGroups(await expectedGroups(f.root)));
  assert.deepEqual(await readFile(path.join(f.root, ".git/index")), f.index);
});

test("a new path outside planned scopes discards the scan before it can be published", { timeout: 60000, skip: process.platform === "win32" }, async t => {
  const f = await repository(t, 32), env = await privateEnvironment(t, f);
  const executable = path.join(f.directory, "git-fixture"), started = path.join(f.directory, "others.pid"), release = path.join(f.directory, "release");
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2);
const run=()=>{const child=cp.spawn('git',args,{stdio:'inherit'});child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));};
if(args.includes('--others')){
 fs.appendFileSync(${JSON.stringify(started)},String(process.pid)+'\\n');
 const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);run();}},10);
}else run();
`, { mode: 0o755 });
  const reset = setGitExecutableResolver(() => executable), controller = new AbortController();
  const pending = readColdStatus(f.root, env, controller.signal, () => undefined); void pending.catch(()=>undefined);
  try {
    await waitForFile(started);
    await writeFile(path.join(f.root, "appeared.txt"), "new root path\n");
    await writeFile(release, "go");
    assert.equal(await pending, undefined);
    assert.ok((await expectedGroups(f.root)).unstaged.some(change => change.path === "appeared.txt"));
    assert.deepEqual(await readFile(path.join(f.root, ".git/index")), f.index);
  } finally { controller.abort(); await pending.catch(()=>undefined); reset(); }
});

test("cancelling a cold scan closes all started jobs and prevents queued jobs from starting", { timeout: 60000, skip: process.platform === "win32" }, async t => {
  const f = await repository(t, 32), env = await privateEnvironment(t, f);
  const executable = path.join(f.directory, "git-fixture"), started = path.join(f.directory, "others.pid");
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2);
if(args.includes('--others')){fs.appendFileSync(${JSON.stringify(started)},String(process.pid)+'\\n');setInterval(()=>{},1000);}
else{const child=cp.spawn('git',args,{stdio:'inherit'});child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));}
`, { mode: 0o755 });
  const reset = setGitExecutableResolver(() => executable), controller = new AbortController();
  const pending = readColdStatus(f.root, env, controller.signal, () => undefined); void pending.catch(()=>undefined);
  try {
    await waitForFile(started); controller.abort();
    await assert.rejects(pending, error => (error as { code?: string }).code === "ABORT_ERR" || (error as Error).name === "AbortError");
    const pids = (await readFile(started, "utf8")).trim().split("\n").map(Number);
    assert.ok(pids.length <= 4);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.deepEqual(await readFile(path.join(f.root, ".git/index")), f.index);
  } finally { controller.abort(); await pending.catch(()=>undefined); reset(); }
});

test("background warming is adopted for repeat reads and survives a new host without stale files", { timeout: 60000 }, async t => {
  const f = await repository(t), events: string[] = [];
  let warmed!: () => void, failed!: (error: Error) => void;
  const completion = new Promise<void>((resolve,reject)=>{warmed=resolve;failed=reject;});
  void completion.catch(()=>undefined);
  const log = (event: string) => {
    events.push(event);
    if (event === "private status index warmup completed") warmed();
    if (event === "private status index warmup failed") failed(new Error("Native cache warmup failed."));
  };
  const cache = new StatusIndexWarmCache(path.join(f.directory, "cache"), log);
  const first = new PrivateStatusIndex(f.root, log, cache), second = new PrivateStatusIndex(f.root, log, cache);
  const sourceCached = new PrivateStatusIndex(f.root, log);
  try {
    const initial = await first.read(new AbortController().signal);
    assert.deepEqual(sortedGroups(initial.groups), sortedGroups(f.expected.groups));
    await completion;
    await writeFile(path.join(f.root, "src/1/1.txt"), "late\n");
    await writeFile(path.join(f.root, ".gitignore"), "ignored/\n*.ignored\nnew/\n");
    const expected = sortedGroups(await expectedGroups(f.root));
    assert.deepEqual(sortedGroups((await first.read(new AbortController().signal)).groups), expected);
    assert.ok(events.includes("private status index warmup applied"));
    const coldReads = events.filter(event=>event === "private status cold scan completed").length;
    assert.deepEqual(sortedGroups((await second.read(new AbortController().signal)).groups), expected);
    assert.equal(events.filter(event=>event === "private status cold scan completed").length, coldReads);
    assert.ok(events.includes("private status index cache restored"));
    assert.deepEqual(await readFile(path.join(f.root, ".git/index")), f.index);
    await runGit(["-c", "core.untrackedCache=true", "update-index", "--force-untracked-cache"], f.root);
    const sourceIndex = await readFile(path.join(f.root, ".git/index"));
    assert.deepEqual(sortedGroups((await sourceCached.read(new AbortController().signal)).groups), expected);
    assert.equal(events.filter(event=>event === "private status cold scan completed").length, coldReads);
    assert.deepEqual(await readFile(path.join(f.root, ".git/index")), sourceIndex);
  } finally { await first.dispose(); await second.dispose(); await sourceCached.dispose(); }
});

test("an oversized optional warmup falls back without retaining or reading its payload", { timeout: 60000, skip: process.platform === "win32" }, async t => {
  const f = await repository(t, 32), executable = path.join(f.directory, "git-fixture");
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs');fs.truncateSync(process.env.GIT_INDEX_FILE,33*1024*1024);
`, { mode: 0o755 });
  const reset = setGitExecutableResolver(()=>executable);
  let discarded!: () => void;
  const done = new Promise<void>(resolve=>{discarded=resolve;});
  const warmup = new StatusIndexWarmup(f.root, (event,fields)=>{if(event === "private status index warmup discarded" && fields.reason === "index-too-large") discarded();});
  try {
    warmup.schedule({key:"stage",bytes:f.index,mtimeMs:(await stat(path.join(f.root, ".git/index"))).mtimeMs,isCurrent:async()=>true});
    await done;
    assert.deepEqual(await warmup.take("stage"),{});
    assert.deepEqual(await readFile(path.join(f.root, ".git/index")),f.index);
  } finally { await warmup.dispose(); reset(); }
});

test("a cold scan shares the configured overall deadline and honors an unlimited setting", { timeout: 60000, skip: process.platform === "win32" }, async t => {
  const f = await repository(t, 32), env = await privateEnvironment(t, f);
  await Promise.all(Array.from({length:32},(_,index)=>mkdir(path.join(f.root,`empty-${index}`))));
  const executable = path.join(f.directory,"git-fixture"), pids = path.join(f.directory,"jobs.pid");
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(pids)},String(process.pid)+'\\n');
setTimeout(()=>{const child=cp.spawn('git',args,{stdio:'inherit'});child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));},200);
`,{mode:0o755});
  let timeout=1000;
  const resetGit=setGitExecutableResolver(()=>executable),resetTimeout=setGitReadTimeoutResolver(()=>timeout),events:string[]=[];
  try {
    await assert.rejects(readColdStatus(f.root,env,new AbortController().signal,event=>events.push(event)),error=>(error as {code?:string}).code==='ETIMEDOUT');
    assert.ok(events.includes('private status cold scan timed out'));
    for(const pid of (await readFile(pids,'utf8')).trim().split('\n').map(Number)) assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    timeout=0;
    const parsed=await readColdStatus(f.root,env,new AbortController().signal,event=>events.push(event));
    assert.ok(parsed);
    assert.deepEqual(sortedGroups(workingTreeSnapshot(f.root,parsed).groups),sortedGroups(f.expected.groups));
    assert.equal(events.filter(event=>event==='private status cold scan timed out').length,1);
    assert.deepEqual(await readFile(path.join(f.root,'.git/index')),f.index);
  } finally {resetGit();resetTimeout();}
});

test("disposing optional warming cancels a pending source-identity read", {timeout:60000},async t=>{
  const f=await repository(t,32);
  let checking!:()=>void;
  const started=new Promise<void>(resolve=>{checking=resolve;});
  const warmup=new StatusIndexWarmup(f.root,()=>undefined);
  try {
    warmup.schedule({key:'stage',bytes:f.index,mtimeMs:(await stat(path.join(f.root,'.git/index'))).mtimeMs,
      isCurrent:async()=>{checking();return new Promise<boolean>(()=>undefined);}});
    await started;
    await warmup.dispose();
    assert.equal(await warmup.take('stage'),undefined);
    assert.deepEqual(await readFile(path.join(f.root,'.git/index')),f.index);
  } finally {await warmup.dispose();}
});

test("a background result cannot be adopted when its source stage identity changed", { timeout: 60000 }, async t => {
  const f = await repository(t, 32);
  let discarded!: () => void;
  const done = new Promise<void>(resolve=>{discarded=resolve;});
  const warmup = new StatusIndexWarmup(f.root, event=>{if(event === "private status index warmup discarded") discarded();});
  try {
    warmup.schedule({key:"original-stage",bytes:f.index,mtimeMs:(await stat(path.join(f.root, ".git/index"))).mtimeMs,isCurrent:async()=>false});
    await done;
    assert.equal(await warmup.take("original-stage"),undefined);
    assert.deepEqual(await readFile(path.join(f.root, ".git/index")),f.index);
  } finally { await warmup.dispose(); }
});
