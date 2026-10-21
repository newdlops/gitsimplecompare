import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GitError, runGit, runGitBuffer, runGitWithInput, withGitConfigOverrides } from "../src/git/gitExec";
import { setGitProcessPreparation } from "../src/git/gitProcessRunner";
import { gitProcesses } from "../src/git/gitProcessRegistry";
import { PRIVATE_STATUS_INDEX_UPDATE_ARGS, registerStatusIndex } from "../src/git/statusIndexOwnership";
import { planStatusIndexTransition, statusIndexStagingIdentity, statusIndexStagingInfo, StatusIndexSource } from "../src/git/statusIndexStagingIdentity";
import { transitionStatusIndex } from "../src/git/statusIndexTransition";
import { PrivateStatusIndex } from "../src/git/privateStatusIndex";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { parseWorkingTreeV2, workingTreeSnapshot, type WorkingTreeSnapshot } from "../src/git/workingTreeStatusFormat";

/** Native가 만든 index와 별도 cache 경로만 사용한다. 큰 fixture도 단일 fast-import로 만든다. */
async function fixture(t: TestContext, algorithm = "sha1", version = 2, count = 4, flat = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-status-transition-")), root = path.join(directory, "repo");
  await mkdir(root); t.after(() => rm(directory, { recursive: true, force: true }));
  await runGit(["-c", "init.templateDir=", "init", "-q", `--object-format=${algorithm}`, "--initial-branch=main"], root);
  for (const [key, value] of Object.entries({ "core.fsmonitor":"false", "core.untrackedCache":"false", "user.name":"Fixture", "user.email":"fixture@example.invalid" }))
    await runGit(["config", key, value], root);
  const rows = ["blob", "mark :1", "data 5", "base\n", "commit refs/heads/main", "committer Fixture <fixture@example.invalid> 1700000000 +0000", "data 4", "base",
    ...Array.from({length:count}, (_, i) => `M 100644 :1 ${flat?"":`dir-${String(Math.floor(i / 10)).padStart(4,"0")}/`}file-${i}.txt`), ""];
  await runGitWithInput(["fast-import", "--quiet"], root, rows.join("\n") + "\n");
  await runGit(["reset", "--hard", "HEAD"], root); await runGit(["update-index", `--index-version=${version}`], root);
  return {directory,root,source:path.join(root,".git/index"),privateIndex:path.join(directory,"private-index"),file:flat?"file-0.txt":"dir-0000/file-0.txt"};
}

/** 사용자 index의 바이트와 metadata를 함께 고정해 Native read가 원본을 쓰지 않는지 검사한다. */
async function identity(file: string) {
  const info = await stat(file); return {bytes:await readFile(file),ino:info.ino,mtime:info.mtimeMs,ctime:info.ctimeMs};
}

/** Native의 UNTR extension을 전용 index에만 준비하고 소유 registry에 등록한다. */
async function warm(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(f.privateIndex, await readFile(f.source), {mode:0o600});
  const unregister = registerStatusIndex(f.privateIndex); t.after(unregister);
  const env = withGitConfigOverrides({GIT_INDEX_FILE:f.privateIndex}, {"core.untrackedCache":"true","core.fsmonitor":"false","core.splitIndex":"false"});
  for (let pass=0;pass<2;pass++) await runGit(["status","--porcelain=v2","-z","--untracked-files=normal"],f.root,{env,allowPrivateIndexWrites:true});
  const bytes=await readFile(f.privateIndex); assert.equal(statusIndexStagingInfo(bytes)?.hasUntrackedCache,true);
  return {bytes,env,previous:statusIndexStagingIdentity(bytes)!};
}

/** 같은 index 의미를 Native의 전체 파일 출력으로 비교한다. 원본은 optional-lock 쓰기를 하지 않는다. */
async function nativeStatus(root: string, env?: Record<string,string>) {
  return runGitBuffer(["-c","core.fsmonitor=false","status","--porcelain=v2","-z","--untracked-files=all"],root,{env});
}

for (const algorithm of ["sha1","sha256"]) for (const version of [2,3,4]) {
  test(`Native ${algorithm} v${version} transition preserves add/remove, mode and raw path semantics`,async t=>{
    const f=await fixture(t,algorithm,version); await writeFile(path.join(f.root,"untracked.txt"),"new\n");
    const cached=await warm(t,f);
    await runGit(["rm","--cached","--",f.file],f.root);
    await runGit(["update-index","--chmod=+x","--","dir-0000/file-1.txt"],f.root);
    await writeFile(path.join(f.root," leading\t한글\n.txt"),"unicode\n");
    await runGit(["add","--all"],f.root);
    // add --all이 다시 넣는 삭제 경로는 마지막에 index에서만 제거한다. 디렉터리 mtime은 바뀌지 않는다.
    await runGit(["rm","--cached","--",f.file],f.root);
    await runGit(["update-index","--chmod=+x","--","dir-0000/file-1.txt"],f.root);
    // macOS는 비 UTF-8 작업 파일을 만들 수 없다. Git이 보관할 수 있는 raw index 경로로 재현한다.
    const oid=(await runGit(["rev-parse",`HEAD:${f.file}`],f.root)).trim();
    const raw=Buffer.concat([Buffer.from(`100644 ${oid} 0\traw-`),Buffer.from([0xff]),Buffer.from("\tline\n.txt\0")]);
    await runGitWithInput(["update-index","-z","--index-info"],f.root,raw);
    const before=await identity(f.source),events:string[]=[],mutations:string[]=[];
    const inspection=StatusIndexSource.inspect(before.bytes);assert.ok(inspection);
    const plan=planStatusIndexTransition(cached.bytes,before.bytes,cached.previous);assert.ok(plan);
    assert.deepEqual(inspection.planTransition(cached.bytes,cached.previous),plan);
    assert.deepEqual(inspection.planTransition(cached.bytes,cached.previous),plan,"Repeated plans need fresh entry iterators");
    const stop=gitProcesses.onDidFinishWrite(root=>mutations.push(root));
    let restored:Buffer|undefined;
    try { restored=await transitionStatusIndex(f.root,f.privateIndex,before.bytes,cached.previous,new AbortController().signal,event=>events.push(event),undefined,inspection); }
    finally {stop();}
    assert.ok(restored); assert.equal(statusIndexStagingIdentity(restored),statusIndexStagingIdentity(before.bytes));
    assert.equal(statusIndexStagingInfo(restored)?.hasUntrackedCache,true); assert.deepEqual(mutations,[]);
    assert.ok(events.includes("private status index transitioned")); assert.deepEqual(await identity(f.source),before);
    await writeFile(f.privateIndex,restored); await utimes(f.privateIndex,before.mtime/1000,Math.floor(before.mtime/1000));
    assert.deepEqual(await nativeStatus(f.root,cached.env),await nativeStatus(f.root));
    assert.deepEqual(await identity(f.source),before);
  });
}

test("unsupported flags, stages, stale identity and large changes reject transition without a Native write",async t=>{
  const f=await fixture(t),cached=await warm(t,f);
  assert.equal(planStatusIndexTransition(cached.bytes,await readFile(f.source),"wrong"),undefined);
  for(const args of [["update-index","--assume-unchanged","--",f.file],["update-index","--skip-worktree","--",f.file]]){
    await runGit(args,f.root); assert.equal(planStatusIndexTransition(cached.bytes,await readFile(f.source),cached.previous),undefined);
    await runGit(["reset","--hard","HEAD"],f.root);
  }
  await writeFile(path.join(f.root,"intent"),""); await runGit(["add","-N","intent"],f.root);
  assert.equal(planStatusIndexTransition(cached.bytes,await readFile(f.source),cached.previous),undefined);
  await runGit(["reset","--hard","HEAD"],f.root);
  const oid=(await runGit(["rev-parse",`HEAD:${f.file}`],f.root)).trim();
  await runGitWithInput(["update-index","--index-info"],f.root,`100644 ${oid} 2\tconflict\n`);
  assert.equal(planStatusIndexTransition(cached.bytes,await readFile(f.source),cached.previous),undefined);
  await runGit(["reset","--hard","HEAD"],f.root);
  await runGitWithInput(["update-index","--index-info"],f.root,Array.from({length:129},(_,i)=>`100644 ${oid}\tadded-${i}\n`).join(""));
  const source=await readFile(f.source); assert.equal(planStatusIndexTransition(cached.bytes,source,cached.previous),undefined);
  const privateBefore=await identity(f.privateIndex),events:string[]=[];
  assert.equal(await transitionStatusIndex(f.root,f.privateIndex,source,cached.previous,new AbortController().signal,event=>events.push(event)),undefined);
  assert.deepEqual(await identity(f.privateIndex),privateBefore); assert.deepEqual(events,[]);
});

/** snapshot 정렬만 정규화하고 status·rename·원래 경로 필드는 모두 비교한다. */
function sorted(value:WorkingTreeSnapshot) {
  return {staged:[...value.groups.staged].sort((a,b)=>a.path.localeCompare(b.path)),unstaged:[...value.groups.unstaged].sort((a,b)=>a.path.localeCompare(b.path))};
}

test("a completed warmup avoids repeat scans while source races and same-size racy edits stay fresh",async t=>{
  const f=await fixture(t,"sha1",4,5000),events:string[]=[];let completed!:()=>void;
  const ready=new Promise<void>(resolve=>{completed=resolve;});
  await writeFile(path.join(f.root,"capture.txt"),"previously untracked\n");
  const index=new PrivateStatusIndex(f.root,event=>{events.push(event);if(event==="private status index warmup completed")completed();});
  try{
    await index.read(AbortSignal.timeout(30000));
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([ready,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Native warmup did not complete")),30000);})]);}finally{clearTimeout(timer);}
    assert.ok(events.includes("private status cold scan completed"));
    await runGit(["rm","--cached","--",f.file],f.root); await runGit(["add","--","capture.txt"],f.root);
    await writeFile(path.join(f.root,"dir-0001/file-10.txt"),"edited\n"); await runGit(["add","--","dir-0001/file-10.txt"],f.root);
    const before=await identity(f.source),calls:string[]=[],mutations:string[]=[];events.length=0;
    const stop=setGitExecutionObserver(row=>calls.push(row.command)),stopWrites=gitProcesses.onDidFinishWrite(root=>mutations.push(root));
    let actual:WorkingTreeSnapshot;
    try{actual=await index.read(AbortSignal.timeout(30000));}finally{stop();stopWrites();}
    assert.ok(events.includes("private status index transitioned"));assert.equal(events.includes("private status cold scan completed"),false);
    assert.equal(calls.filter(command=>command==="update-index").length,1);assert.equal(calls.filter(command=>command==="status").length,1);
    assert.equal(calls.includes("ls-files"),false);assert.deepEqual(mutations,[]);assert.deepEqual(await identity(f.source),before);
    const raw=(await nativeStatus(f.root)).toString("utf8");
    assert.deepEqual(sorted(actual!),sorted(workingTreeSnapshot(f.root,parseWorkingTreeV2(raw))));
    assert.ok(actual!.groups.unstaged.some(row=>row.path===f.file));
    assert.equal(gitProcesses.isBusy(f.root),false);
    const again=await index.read(AbortSignal.timeout(30000));assert.deepEqual(sorted(again),sorted(actual!));
    assert.deepEqual(await identity(f.source),before);
    await writeFile(path.join(f.root,"dir-0002/file-20.txt"),"first stage\n");await runGit(["add","--","dir-0002/file-20.txt"],f.root);
    let injected=false;
    const restore=setGitProcessPreparation(async(_args,_root,options)=>{
      if(options.privateIndexOnly&&!injected){
        injected=true;await writeFile(path.join(f.root,"dir-0002/file-21.txt"),"concurrent stage\n");
        await runGit(["add","--","dir-0002/file-21.txt"],f.root);
      }
      return{options};
    });
    let raced:WorkingTreeSnapshot;
    try{raced=await index.read(AbortSignal.timeout(30000));}finally{restore();}
    assert.equal(injected,true);assert.ok(events.includes("private status index invalidated"));
    const fresh=(await nativeStatus(f.root)).toString("utf8");assert.deepEqual(sorted(raced!),sorted(workingTreeSnapshot(f.root,parseWorkingTreeV2(fresh))));
    assert.ok(raced!.groups.staged.some(row=>row.path==="dir-0002/file-21.txt"));
    await runGit(["config","core.trustctime","false"],f.root);
    await (index as any).warmup.task?.completion;await index.read(AbortSignal.timeout(30000));
    const at=Math.floor(Date.now()/1000),racyFile=path.join(f.root,"dir-0003/file-30.txt");
    await utimes(racyFile,at,at);await runGit(["update-index","--refresh"],f.root);
    await writeFile(path.join(f.root,"dir-0003/file-31.txt"),"stage change\n");await runGit(["add","--","dir-0003/file-31.txt"],f.root);
    await utimes(f.source,at,at);await writeFile(racyFile,"edit\n");await utimes(racyFile,at,at);
    const racyBefore=await identity(f.source);events.length=0;
    const racy=await index.read(AbortSignal.timeout(30000));
    assert.ok(events.includes("private status index transitioned"));assert.ok(racy.groups.unstaged.some(row=>row.path==="dir-0003/file-30.txt"));
    assert.deepEqual(sorted(racy),sorted(workingTreeSnapshot(f.root,parseWorkingTreeV2((await nativeStatus(f.root)).toString("utf8")))));
    assert.deepEqual(await identity(f.source),racyBefore);
  }finally{await index.dispose();}
});

test("a rejected private update remains a cache miss and a pre-cancelled update never starts",async t=>{
  const f=await fixture(t),cached=await warm(t,f),events:string[]=[];
  await writeFile(path.join(f.root,f.file),"changed\n");await runGit(["add","--",f.file],f.root);
  const source=await identity(f.source),privateBefore=await identity(f.privateIndex);
  const restore=setGitProcessPreparation(async(_args,_root,options)=>({args:["status"],options}));
  try{assert.equal(await transitionStatusIndex(f.root,f.privateIndex,source.bytes,cached.previous,new AbortController().signal,event=>events.push(event)),undefined);}finally{restore();}
  assert.ok(events.includes("private status index transition bypassed"));assert.deepEqual(await identity(f.source),source);assert.deepEqual(await identity(f.privateIndex),privateBefore);
  const controller=new AbortController();controller.abort();
  await assert.rejects(transitionStatusIndex(f.root,f.privateIndex,source.bytes,cached.previous,controller.signal,()=>{throw new Error("logger closed");}));
  assert.equal(gitProcesses.isBusy(f.root),false);
});

test("a foreign source inspection cannot write and mutation during Native update cannot authorize restoration",async t=>{
  const f=await fixture(t),cached=await warm(t,f);
  await writeFile(path.join(f.root,f.file),"changed\n");await runGit(["add","--",f.file],f.root);
  const source=await identity(f.source),inspection=StatusIndexSource.inspect(source.bytes);assert.ok(inspection);
  const protectedBytes=Buffer.from(source.bytes);
  const foreign=StatusIndexSource.inspect(Buffer.from(source.bytes));assert.ok(foreign);
  const before=await identity(f.privateIndex),events:string[]=[];
  assert.equal(await transitionStatusIndex(f.root,f.privateIndex,source.bytes,cached.previous,new AbortController().signal,
    event=>events.push(event),undefined,foreign),undefined);
  assert.deepEqual(await identity(f.privateIndex),before);assert.deepEqual(events,[]);
  let mutated=false;
  const restore=setGitProcessPreparation(async(_args,_root,options)=>{
    if(options.privateIndexOnly&&!mutated){
      mutated=true;source.bytes[12]^=1;
      createHash("sha1").update(source.bytes.subarray(0,-20)).digest().copy(source.bytes,source.bytes.length-20);
    }
    return{options};
  });
  try{
    assert.equal(await transitionStatusIndex(f.root,f.privateIndex,source.bytes,cached.previous,new AbortController().signal,
      event=>events.push(event),undefined,inspection),undefined);
  }finally{restore();}
  assert.equal(mutated,true);assert.ok(events.includes("private status index transition bypassed"));
  const actual=await identity(f.source);assert.deepEqual(actual.bytes,protectedBytes);
  assert.equal(actual.ino,source.ino);assert.equal(actual.mtime,source.mtime);assert.equal(actual.ctime,source.ctime);
  assert.equal(gitProcesses.isBusy(f.root),false);
});

for(const layout of ["flat","already-cached"] as const) test(`${layout} source keeps the original single-query status path`,async t=>{
  const f=await fixture(t,"sha1",4,5000,layout==="flat");
  if(layout==="already-cached"){
    await runGit(["config","core.untrackedCache","true"],f.root);
    await runGit(["update-index","--force-untracked-cache"],f.root);
  }
  const index=new PrivateStatusIndex(f.root,()=>undefined);
  try{
    await index.read(AbortSignal.timeout(30000));
    await writeFile(path.join(f.root,f.file),"changed\n");await runGit(["add","--",f.file],f.root);
    if(layout==="already-cached")assert.equal(statusIndexStagingInfo(await readFile(f.source))?.hasUntrackedCache,true);
    const before=await identity(f.source),calls:string[]=[],stop=setGitExecutionObserver(row=>calls.push(row.command));
    let actual:WorkingTreeSnapshot;
    try{actual=await index.read(AbortSignal.timeout(30000));}finally{stop();}
    assert.equal(calls.filter(command=>command==="status").length,1);assert.equal(calls.includes("update-index"),false);
    assert.deepEqual(sorted(actual!),sorted(workingTreeSnapshot(f.root,parseWorkingTreeV2((await nativeStatus(f.root)).toString("utf8")))));
    assert.deepEqual(await identity(f.source),before);
  }finally{await index.dispose();}
});

test("the final private update guard rejects user indexes, changed preparation and cleared ownership",async t=>{
  const f=await fixture(t),cached=await warm(t,f),before=await identity(f.source);
  const options={privateIndexOnly:true,retryOnLock:false,env:{GIT_INDEX_FILE:f.source}};
  const rejected=(error:unknown)=>error instanceof GitError&&error.code==="GIT_PRIVATE_INDEX_UNSAFE";
  await assert.rejects(runGitWithInput([...PRIVATE_STATUS_INDEX_UPDATE_ARGS],f.root,Buffer.alloc(0),options),rejected);
  await assert.rejects(runGitWithInput([...PRIVATE_STATUS_INDEX_UPDATE_ARGS],f.root,Buffer.alloc(0),{...options,env:cached.env,clearEnv:["GIT_INDEX_FILE"]}),rejected);
  const restore=setGitProcessPreparation(async(_args,_root,prepared)=>({args:["reset","--hard"],options:prepared}));
  try{await assert.rejects(runGitWithInput([...PRIVATE_STATUS_INDEX_UPDATE_ARGS],f.root,Buffer.alloc(0),{...options,env:cached.env}),rejected);}finally{restore();}
  assert.deepEqual(await identity(f.source),before);assert.equal(gitProcesses.isBusy(f.root),false);
});

for(const kind of ["cancel","deadline"] as const) test(`owned private index ${kind} closes the actual child without a repository mutation`,async t=>{
  const f=await fixture(t),cached=await warm(t,f),executable=path.join(f.directory,"slow-git"),ready=path.join(f.directory,"ready");
  await writeFile(executable,`#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.GSC_READY,'ready');process.stdin.resume();setInterval(()=>{},1000);\n`,{mode:0o755});
  const controller=new AbortController(),mutations:string[]=[],stop=gitProcesses.onDidFinishWrite(root=>mutations.push(root));
  const started=Date.now(),pending=runGitWithInput([...PRIVATE_STATUS_INDEX_UPDATE_ARGS],f.root,Buffer.alloc(0),{
    executable,env:{...cached.env,GSC_READY:ready},signal:controller.signal,privateIndexOnly:true,retryOnLock:false,readTimeoutMs:kind==="deadline"?100:10000,
  });
  const observed=pending.then(()=>undefined,error=>error);
  try{
    if(kind==="cancel"){
      while(Date.now()-started<10000){if(await stat(ready).then(()=>true,()=>false))break;await new Promise(resolve=>setTimeout(resolve,10));}
      assert.ok(await stat(ready).then(()=>true,()=>false));controller.abort();
    }
    const failure=await observed;assert.ok(failure instanceof GitError);assert.equal(failure.code,kind==="cancel"?"ABORT_ERR":"ETIMEDOUT");
    if(kind==="deadline")assert.ok(Date.now()-started>=100);
    assert.equal(gitProcesses.isBusy(f.root),false);assert.deepEqual(mutations,[]);
  }finally{controller.abort();await observed;stop();}
});
