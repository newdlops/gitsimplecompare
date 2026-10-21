// 같은 큰 Native 작업트리에서 작은 stage 변경 뒤의 상태 갱신을 실제 public service로 비교한다.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrivateStatusIndex } from "../../src/git/privateStatusIndex";
import { runGit } from "../../src/git/gitExec";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { workingTreeSnapshot, parseWorkingTreeV2, type WorkingTreeSnapshot } from "../../src/git/workingTreeStatusFormat";
import { createGitOperationFixture } from "../helpers/gitOperationFixture";

/** metadata와 바이트 모두 비교해 상태 읽기가 사용자 index를 바꾸지 않는지 증명한다. */
async function indexIdentity(file:string) {
  const info=await stat(file);return{bytes:await readFile(file),ino:info.ino,mtime:info.mtimeMs,ctime:info.ctimeMs};
}

/** 정렬만 정규화하고 rename·원본 경로·상태 등 Native status의 의미 필드는 보존한다. */
function sorted(value:WorkingTreeSnapshot) {
  return{staged:[...value.groups.staged].sort((a,b)=>a.path.localeCompare(b.path)),unstaged:[...value.groups.unstaged].sort((a,b)=>a.path.localeCompare(b.path))};
}

/** 선택적인 warmup은 실제로 예약된 작업만 기다린다. 별도의 getter나 Native 조회로 예열하지 않는다. */
async function settled(index:PrivateStatusIndex) {
  await (index as any).warmup.task?.completion;
}

/** 큰 원본 object를 읽기만 하는 소유 fixture에서 새 추적 경로 5회를 측정하고 모든 원시 표본을 남긴다. */
async function main():Promise<void>{
  const metadata=process.env.GSC_BENCH_BORROWED_FIXTURE;assert.ok(metadata,"An explicit readonly borrowed fixture snapshot is required");
  const directory=await mkdtemp(path.join(os.tmpdir(),"gsc-status-transition-benchmark-"));
  let index:PrivateStatusIndex|undefined;
  try{
    const f=await createGitOperationFixture(directory,metadata),source=path.join(f.root,".git/index"),events:string[]=[];
    const prefix="gsc-status-transition-fixture";assert.equal((await runGit(["ls-tree","--name-only","HEAD","--",prefix],f.root)).trim(),"");
    await mkdir(path.join(f.root,prefix));
    index=new PrivateStatusIndex(f.root,event=>events.push(event));await index.read(AbortSignal.timeout(60000));await settled(index);
    const head=(await runGit(["rev-parse","HEAD"],f.root)).trim(),samples=[];
    for(let repetition=0;repetition<5;repetition++){
      const file=`${prefix}/added-${repetition}.txt`;await writeFile(path.join(f.root,file),`change ${repetition}\n`);await runGit(["add","--",file],f.root);
      const beforeIndex=await indexIdentity(source);(globalThis as any).gc?.();events.length=0;
      const before=process.memoryUsage(),cpu=process.cpuUsage(),timings:GitExecutionTiming[]=[],stop=setGitExecutionObserver(row=>timings.push(row));
      const at=performance.now();let actual:WorkingTreeSnapshot,foreground:any;
      try{
        actual=await index.read(AbortSignal.timeout(60000));const after=process.memoryUsage(),used=process.cpuUsage(cpu);
        foreground={elapsedMs:performance.now()-at,nodeCpuMs:(used.user+used.system)/1000,gitCalls:timings.length,
          heapAfterAwaitDelta:after.heapUsed-before.heapUsed,rssAfterAwaitDelta:after.rss-before.rss};
        await settled(index);
      }finally{stop();}
      const used=process.cpuUsage(cpu),elapsedMs=performance.now()-at;
      assert.deepEqual(await indexIdentity(source),beforeIndex);assert.equal(gitProcesses.isBusy(f.root),false);
      const raw=await runGit(["status","--porcelain=v2","--branch","--no-ahead-behind","-z","--untracked-files=all"],f.root);
      assert.deepEqual(sorted(actual!),sorted(workingTreeSnapshot(f.root,parseWorkingTreeV2(raw))));
      assert.deepEqual(await indexIdentity(source),beforeIndex);
      samples.push({repetition,foreground,settled:{elapsedMs,nodeCpuMs:(used.user+used.system)/1000,gitCalls:timings.length},
        commands:timings.map(row=>row.command),events:[...events],nativeExact:true,indexPreserved:true});
    }
    assert.equal((await runGit(["rev-parse","HEAD"],f.root)).trim(),head);
    const result={source:JSON.parse(process.env.GSC_BENCH_SOURCE||"null"),fixture:{files:f.files,commits:f.depth,branches:f.branches},samples,
      scope:"Five successive single-path additions on an owned borrowed Native worktree. Foreground is actual PrivateStatusIndex.read; settled includes its already scheduled optional warmup. Fixture, mutations, pre-sample GC and independent full Native oracle are outside phase time/Node CPU. Memory is after-await delta, not peak/retained or whole-process resource usage."};
    await writeFile(process.argv[2],JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));
  }finally{await index?.dispose();await gitProcesses.dispose();await rm(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
