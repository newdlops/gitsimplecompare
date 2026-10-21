import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GitError, runGit, runGitWithInput, runGitStreamWithInput, runGitReadPipeline, type RunGitOptions } from "../src/git/gitExec";
import { gitProcesses } from "../src/git/gitProcessRegistry";
import { gitCommandIndex } from "../src/git/gitCommandPolicy";
import { pushBranchCommits, SequentialPushError, type PushGitRunner, type PushProgress } from "../src/git/sequentialPush";
import { createPromisorPushFixture, missingPromisorBlobs, promisorGit as git, promisorPackState, promisorSourceSnapshot } from "./helpers/promisorPushFixture";

process.env.GIT_CONFIG_NOSYSTEM="1";process.env.GIT_CONFIG_GLOBAL="/dev/null";

/** 실제 Git의 모든 transport를 유지하며 Native trace와 호출 경계만 관찰한다. */
function tracedRunner(trace: string) {
  const calls: string[][]=[];
  const inject=(options?:RunGitOptions)=>({...options,env:{...options?.env,GIT_TRACE2_EVENT:trace}});
  const runner:PushGitRunner={
    run:(args,root,options)=>{calls.push(args);return runGit(args,root,inject(options));},
    input:(args,root,input,options)=>{calls.push(args);return runGitWithInput(args,root,input,inject(options));},
    inputStream:(args,root,input,onData,options)=>{calls.push(args);return runGitStreamWithInput(args,root,input,onData,inject(options));},
    pipe:(from,to,root,onData,options)=>{calls.push(from,to);return runGitReadPipeline(from,to,root,onData,inject(options));},
  };
  return {runner,calls};
}

/** 각 테스트에 private clone/receiver만 배정하고 모든 소유 프로세스가 끝난 뒤 지운다. */
async function fixture(t:TestContext,options:Parameters<typeof createPromisorPushFixture>[1]={}) {
  const directory=await mkdtemp(path.join(tmpdir(),"gsc-push-promisor-planning-"));
  t.after(async()=>{await gitProcesses.dispose();await rm(directory,{recursive:true,force:true});});
  const f=await createPromisorPushFixture(directory,options), trace=path.join(directory,"trace.jsonl");
  return {...f,directory,trace,...tracedRunner(trace),target:{branch:"topic",head:f.head,remote:"publish",targetRef:"refs/heads/topic"}};
}

/** actual push가 새로 만드는 tracking ref 이외의 기존 ref와 모든 사용자 파일이 그대로인지 확인한다. */
async function assertPreserved(f:Awaited<ReturnType<typeof fixture>>,before:Awaited<ReturnType<typeof promisorSourceSnapshot>>) {
  const after=await promisorSourceSnapshot(f.root);assert.equal(after.head,before.head);assert.deepEqual(after.files,before.files);
  const original=before.refs.split("\n"),current=after.refs.split("\n");for(const row of original)assert.ok(current.includes(row),row);
  assert.equal(await git(f.receiver,"rev-parse","refs/heads/topic"),f.head);
  assert.equal(gitProcesses.isBusy(f.root),false);
}

for(const tag of [false,true])test(`partial push planning avoids blob hydration with ${tag?"a shared tag":"an unknown advanced branch tip"}`,async t=>{
  const f=await fixture(t,{tag}),before=await promisorSourceSnapshot(f.root),packs=await promisorPackState(f.root);let ready=false,checked=false;
  const result=await pushBranchCommits(f.root,f.target,{onProgress:event=>{if(event.phase==="ready")ready=true;},beforePush:async()=>{
    if(ready&&!checked){checked=true;assert.deepEqual(await promisorPackState(f.root),packs,"Planning must not download promisor objects");assert.deepEqual(await promisorSourceSnapshot(f.root),before);}
  }},f.runner);
  assert.equal(checked,true);assert.equal(result.strategy,"single");assert.ok(result.estimatedBytes!<2048);
  const events=(await readFile(f.trace,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  assert.equal(events.filter(event=>event.event==="child_start"&&event.argv?.includes("fetch")&&!event.argv.includes("--negotiate-only")).length,0);
  assert.equal(await missingPromisorBlobs(f.root,f.blobs),f.blobs.length);assert.deepEqual(await promisorPackState(f.root),packs);
  assert.equal(f.calls.filter(args=>args.includes("--negotiate-only")).length,1);await assertPreserved(f,before);
});

test("negotiated history never becomes the empty destination lease for a genuinely large push",async t=>{
  const f=await fixture(t,{largeNew:true}),before=await promisorSourceSnapshot(f.root),packs=await promisorPackState(f.root);let ready=false,changed=false;
  await assert.rejects(pushBranchCommits(f.root,f.target,{sequentialThresholdBytes:2048,onProgress:event=>{if(event.phase==="ready"){ready=true;assert.equal(event.total,2);}},beforePush:async()=>{
    if(ready&&!changed){changed=true;await git(f.receiver,"update-ref",f.target.targetRef,f.base);}
  }},f.runner),error=>{assert.ok(error instanceof SequentialPushError);assert.equal(error.result.completed,0);assert.equal(error.result.total,2);assert.match(error.message,/stale info|rejected/);return true;});
  const push=f.calls.find(args=>args[gitCommandIndex(args)]==="push")!;assert.ok(push.includes("--force-with-lease=refs/heads/topic:"));
  assert.equal(await git(f.receiver,"rev-parse",f.target.targetRef),f.base);assert.deepEqual(await promisorSourceSnapshot(f.root),before);assert.deepEqual(await promisorPackState(f.root),packs);
});

test("a successful negotiated large push preserves each fresh destination lease and source state",async t=>{
  const f=await fixture(t,{largeNew:true}),before=await promisorSourceSnapshot(f.root),packs=await promisorPackState(f.root);
  const result=await pushBranchCommits(f.root,f.target,{sequentialThresholdBytes:2048},f.runner);
  assert.equal(result.strategy,"sequential");assert.equal(result.completed,2);assert.equal(result.total,2);
  const pushes=f.calls.filter(args=>args[gitCommandIndex(args)]==="push");
  assert.deepEqual(pushes.map(args=>args.find(arg=>arg.startsWith("--force-with-lease="))),["--force-with-lease=refs/heads/topic:",`--force-with-lease=refs/heads/topic:${f.commits[0]}`]);
  assert.deepEqual(await promisorPackState(f.root),packs);assert.equal(await missingPromisorBlobs(f.root,f.blobs),f.blobs.length);await assertPreserved(f,before);
});

test("tree-less clones preserve Native success and source state when the boundary tree is missing",async t=>{
  const f=await fixture(t,{filter:"tree:0"}),before=await promisorSourceSnapshot(f.root);
  const result=await pushBranchCommits(f.root,f.target,{},f.runner);assert.equal(result.completed,result.total);await assertPreserved(f,before);
  assert.ok(f.calls.filter(args=>args.includes("--negotiate-only")).length<=1,"One bounded recovery attempt only");
});

test("an unrelated push server falls back to complete sizing and still sends the exact history",async t=>{
  const f=await fixture(t),other=path.join(f.directory,"unrelated.git");await git(f.directory,"init","--bare","-q",other);
  await git(f.root,"remote","set-url","publish",other);f.receiver=other;
  const before=await promisorSourceSnapshot(f.root),result=await pushBranchCommits(f.root,f.target,{},f.runner);
  assert.ok(result.estimatedBytes!>=4*1024);assert.equal(result.completed,result.total);await assertPreserved(f,before);
});

test("cancellation during shared-base recovery does not hydrate objects or start a push",async t=>{
  const f=await fixture(t),before=await promisorSourceSnapshot(f.root),packs=await promisorPackState(f.root),controller=new AbortController(),original=f.runner.run;
  f.runner.run=async(args,root,options)=>{const output=await original(args,root,options);if(args[0]==="config"&&args.includes("^remote\\..*\\.promisor$"))controller.abort();return output;};
  await assert.rejects(pushBranchCommits(f.root,f.target,{signal:controller.signal},f.runner),error=>error instanceof GitError&&String(error.code)==="ABORT_ERR"||error instanceof Error&&error.name==="AbortError");
  assert.equal(f.calls.some(args=>args[gitCommandIndex(args)]==="push"),false);assert.deepEqual(await promisorSourceSnapshot(f.root),before);assert.deepEqual(await promisorPackState(f.root),packs);
  assert.equal(gitProcesses.isBusy(f.root),false);
});

test("a source switch after negotiation still fails the original fresh pre-push validation",async t=>{
  const f=await fixture(t),before=await promisorSourceSnapshot(f.root),packs=await promisorPackState(f.root),original=f.runner.run;let changed=false;
  f.runner.run=async(args,root,options)=>{const output=await original(args,root,options);if(args.includes("--negotiate-only")){changed=true;await git(f.root,"update-ref","refs/heads/topic",f.base);}return output;};
  await assert.rejects(pushBranchCommits(f.root,f.target,{},f.runner),/changed after confirmation/);
  assert.equal(changed,true);assert.equal(f.calls.some(args=>args[gitCommandIndex(args)]==="push"),false);
  const after=await promisorSourceSnapshot(f.root);assert.equal(after.head,f.base);assert.deepEqual(after.files,before.files);assert.deepEqual(await promisorPackState(f.root),packs);
  await assert.rejects(runGit(["rev-parse","--verify",f.target.targetRef],f.receiver));
});

test("a server without negotiation support retains the original successful sizing path",async t=>{
  const f=await fixture(t);await git(f.root,"config","protocol.version","0");
  const before=await promisorSourceSnapshot(f.root),result=await pushBranchCommits(f.root,f.target,{},f.runner);
  assert.ok(result.estimatedBytes!>=4*1024);await assertPreserved(f,before);
  assert.equal(f.calls.filter(args=>args.includes("--negotiate-only")).length,1);
});

test("malformed negotiation output never starts fallback hydration or a push",async t=>{
  const f=await fixture(t),before=await promisorSourceSnapshot(f.root),packs=await promisorPackState(f.root),original=f.runner.run;
  f.runner.run=(args,root,options)=>args.includes("--negotiate-only")?Promise.resolve("not-a-commit\n"):original(args,root,options);
  await assert.rejects(pushBranchCommits(f.root,f.target,{},f.runner),/Could not verify negotiated Git history/);
  assert.equal(f.calls.some(args=>args[gitCommandIndex(args)]==="push"),false);assert.deepEqual(await promisorSourceSnapshot(f.root),before);assert.deepEqual(await promisorPackState(f.root),packs);
});

test("a negotiation deadline is propagated without an uncancellable legacy retry",async t=>{
  const f=await fixture(t),before=await promisorSourceSnapshot(f.root),packs=await promisorPackState(f.root),original=f.runner.run;
  const timeout=new GitError("negotiation timed out","","",Object.assign(new Error("timeout"),{code:"ETIMEDOUT"}));
  f.runner.run=(args,root,options)=>args.includes("--negotiate-only")?Promise.reject(timeout):original(args,root,options);
  await assert.rejects(pushBranchCommits(f.root,f.target,{},f.runner),error=>error===timeout);
  assert.equal(f.calls.some(args=>args[gitCommandIndex(args)]==="push"),false);assert.deepEqual(await promisorSourceSnapshot(f.root),before);assert.deepEqual(await promisorPackState(f.root),packs);
});

test("Native boolean normalization preserves a numeric true promisor setting",async t=>{
  const f=await fixture(t);await git(f.root,"config","remote.origin.promisor","2");
  const before=await promisorSourceSnapshot(f.root),packs=await promisorPackState(f.root);
  const result=await pushBranchCommits(f.root,f.target,{},f.runner);assert.equal(result.completed,1);
  assert.equal(await missingPromisorBlobs(f.root,f.blobs),f.blobs.length);assert.deepEqual(await promisorPackState(f.root),packs);await assertPreserved(f,before);
});
