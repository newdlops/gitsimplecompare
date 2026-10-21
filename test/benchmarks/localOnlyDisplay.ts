// Native DAG의 큰 membership 결과에서 실제 표시 서비스가 소비하는 비용만 분리해 측정한다.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GitLogService } from "../../src/git/gitLogService";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { localOnlyFixture, nativeLocalOnlyOracle } from "../helpers/localOnlyFixture";

/** 같은 입력의 반복 표본을 정렬 복사해 원본 순서를 보존하는 중앙값이다. */
function median(values:number[]):number { const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)]; }

/** fixture와 oracle 계산은 시간 구간 밖에 두고 cold와 warm 표시 경로를 모두 Native와 대조한다. */
async function main():Promise<void>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"gsc-local-only-display-"));
  try{
    const f=await localOnlyFixture(directory,32,1,1000,30000),expected=await nativeLocalOnlyOracle(f);
    const service=new GitLogService(f.root);service.seedGraphBranchTips(f.branches,f.remoteTips);
    const commits=await service.getCommitPage(300,0,[f.branches[0].hash],false),cache=(service as any).localOnlyBranchCache;
    const samples:any[]=[];
    /** completed map을 외부에서 변경하지 않고, 표시 commit의 모든 membership과 독립 oracle을 대조한다. */
    const verify=()=>{
      assert.deepEqual(cache.peek(),expected);
      for(const commit of commits)assert.deepEqual(commit.localOnlyBranches,expected.get(commit.hash));
    };
    for(const phase of ["cold","warm"]){
      for(let repetition=0;repetition<(phase==="cold"?1:5);repetition++){
        (globalThis as any).gc?.();const before=process.memoryUsage(),timings:GitExecutionTiming[]=[];
        const stop=setGitExecutionObserver(row=>timings.push(row)),cpu=process.cpuUsage(),at=performance.now();
        try{for(let call=0;call<(phase==="cold"?1:10);call++)await service.attachLocalOnlyBranches(commits);}
        finally{stop();}
        const elapsedMs=performance.now()-at,used=process.cpuUsage(cpu),after=process.memoryUsage();
        samples.push({phase,repetition,calls:phase==="cold"?1:10,elapsedMs,nodeCpuMs:(used.user+used.system)/1000,gitCalls:timings.length,
          heapAfterAwaitDelta:after.heapUsed-before.heapUsed,arrayBufferAfterAwaitDelta:after.arrayBuffers-before.arrayBuffers,rssAfterAwaitDelta:after.rss-before.rss});
        verify();assert.equal(gitProcesses.isBusy(f.root),false);
        if(phase==="warm")assert.equal(timings.length,0,"Warm display must not read another Native DAG");
      }
    }
    const isolated=await cache.getMap();isolated.get(commits[0].hash)?.push("external mutation");isolated.clear();verify();
    commits[0].localOnlyBranches!.push("display mutation");assert.deepEqual(cache.peek(),expected);
    await service.attachLocalOnlyBranches(commits);verify();
    const warm=samples.filter(sample=>sample.phase==="warm");
    const result={source:JSON.parse(process.env.GSC_BENCH_SOURCE||"null"),fixture:{branches:32,localDepth:30000,oldDepth:1000,loadedCommits:commits.length,mapEntries:expected.size},samples,
      warmMedian:Object.fromEntries(["elapsedMs","nodeCpuMs","heapAfterAwaitDelta","arrayBufferAfterAwaitDelta","rssAfterAwaitDelta"].map(key=>[key,median(warm.map(sample=>sample[key]))])),
      nativeExact:true,mutableIsolation:true,scope:"Actual attachLocalOnlyBranches; Native fixture/oracle and post-checks excluded from phase time and Node CPU. Memory is after-await delta, not peak or total OS/Git/browser usage. GC before each phase is outside timing."};
    await writeFile(process.argv[2],JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));
  }finally{await gitProcesses.dispose();await rm(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
