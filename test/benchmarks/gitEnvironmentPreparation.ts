// 실제 공개 준비 API만 반복해 Native 실행·파일시스템 안전 경계와 환경 처리 비용을 구분한다.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../src/git/gitExec";
import { ensureOwnedFsmonitor, forgetPreparedFsmonitor, setOwnedFsmonitorPolicy } from "../../src/git/ownedFsmonitor";
import { resolveGitStatePath, withGitStatePathScope } from "../../src/git/gitStatePathScope";
import { setGitExecutionObserver } from "../../src/git/gitExecutionDiagnostics";
import { gitProcesses } from "../../src/git/gitProcessRegistry";

/** 구간 안의 Node CPU·시간과 실제 Git 수를 기록하고 비교용 Native 준비는 구간 밖에 둔다. */
async function sample(iterations:number, action:()=>Promise<void>) {
  let gitCalls=0;const stop=setGitExecutionObserver(()=>gitCalls++),cpu=process.cpuUsage(),start=performance.now();
  try {for(let index=0;index<iterations;index++)await action();}
  finally {stop();}
  const elapsedMs=performance.now()-start,used=process.cpuUsage(cpu);
  assert.equal(gitCalls,0,"Prepared microphase must not include an expired cache's Native query");
  return {iterations,elapsedMs,nodeCpuMs:(used.user+used.system)/1000,gitCalls};
}

/** 실제 파일·config를 소유한 작은 저장소를 만들고 모든 후속 명령을 이 루트에 한정한다. */
async function fixture(directory:string) {
  const root=join(directory,"repo");await mkdir(root);
  await runGit(["-c","init.templateDir=","init","-q","-b","main"],root);
  await runGit(["config","core.fsmonitor","false"],root);
  return root;
}

/** 동일한 현재 환경과 fresh metadata fencing을 가진 public API를 warmup 1회·5회 측정한다. */
async function main() {
  assert.equal(process.platform,"darwin","Monitor policy benchmark requires the macOS product path");
  const source=JSON.parse(process.env.GSC_BENCH_SOURCE!);
  // source 선택/기록은 측정 입력이 아니다. 두 source가 같은 환경 키 수로 준비 API를 실행하게 한다.
  delete process.env.GSC_BENCH_SOURCE_REF;delete process.env.GSC_BENCH_SOURCE;
  const directory=await mkdtemp(join(tmpdir(),"gsc-environment-preparation-"));let stopMonitor:(()=>void)|undefined;
  try {
    const root=await fixture(directory);stopMonitor=setOwnedFsmonitorPolicy(()=>{});
    const results:Record<string,unknown>={};
    for(const slots of [0,8]) {
      const environment:Record<string,string>={GIT_CONFIG_COUNT:String(slots)};
      for(let index=0;index<slots;index++){environment[`GIT_CONFIG_KEY_${index}`]=`gsc.preparation${index}`;environment[`GIT_CONFIG_VALUE_${index}`]=String(index);}
      const samples=[];
      for(let round=-1;round<5;round++){
        forgetPreparedFsmonitor(root);assert.equal(await ensureOwnedFsmonitor(root,{env:environment}),false);
        const value=await sample(1000,async()=>{assert.equal(await ensureOwnedFsmonitor(root,{env:environment}),false);});
        if(round>=0)samples.push(value);
      }
      results[`monitorWith${slots}ConfigSlots`]=samples;
    }
    await withGitStatePathScope(root,async()=>{
      const relative="gitsimplecompare/deferred-commit-rebase-state.json",expected=await resolveGitStatePath(root,relative),samples=[];
      for(let round=-1;round<5;round++){
        const value=await sample(100,async()=>{assert.equal(await resolveGitStatePath(root,relative),expected);});
        if(round>=0)samples.push(value);
      }
      results.freshScopedPathReads=samples;
    });
    const report={source,environmentKeys:Object.keys(process.env).length,
      gitEnvironmentKeys:Object.keys(process.env).filter(name=>name.startsWith("GIT_")).length,results,
      scope:"Public cached monitor preparation and freshly fenced private path APIs; one warmup/five correlated samples per process. Native warmup excluded; zero Git calls inside phases. Node CPU only, not full operations, aggregate memory or whole Graph."};
    await writeFile(process.argv[2],JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));
  } finally {stopMonitor?.();await gitProcesses.dispose();await rm(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
