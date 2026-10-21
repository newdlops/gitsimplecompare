// 실제 Native rename 상태에서 boolean 조회의 비용과 index 보존을 같은 소스로 비교한다.
import assert from "node:assert/strict";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { hasWorkingTreeChanges } from "../../src/git/workingTreeChanges";
import { runGitWithInput } from "../../src/git/gitExec";
import { setGitExecutionObserver, type GitExecutionTiming } from "../../src/git/gitExecutionDiagnostics";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { git, safetyFixture } from "../helpers/gitSafetyFixture";

/** 공통 본문을 조금 수정한 이동을 만들어 exact rename의 사전 조회만으로 끝나지 않는 Native 상태를 재현한다. */
async function main(): Promise<void> {
  const cleanups: (()=>unknown)[] = [];
  const f = await safetyFixture({after:(fn:()=>unknown)=>cleanups.push(fn)} as any,"boolean-native-benchmark");
  try {
    const count=300, body=Array.from({length:80},(_,i)=>`Stable line ${i}: the original contents remain comparable across this file.\n`).join("");
    const input:string[]=[];
    for(let i=0;i<count;i++){const content=body+`Unique original ${i}\n`;input.push("blob",`mark :${i+1}`,`data ${Buffer.byteLength(content)}`,content);}
    input.push("commit refs/heads/main","committer Fixture <fixture@example.test> 1700000100 +0000","data 12","rename base\n",`from ${f.head}`,
      ...Array.from({length:count},(_,i)=>`M 100644 :${i+1} old/file-${String(i).padStart(4,"0")}.txt`),"");
    await runGitWithInput(["fast-import","--quiet"],f.root,input.join("\n")+"\n"); await git(f.root,"reset","--hard","HEAD");
    await git(f.root,"config","status.renames","true"); await git(f.root,"config","diff.renameLimit","1000");
    const rows:unknown[]=[];
    for(const state of ["edited-renames","clean"]){
      if(state==="edited-renames"){
        await mkdir(path.join(f.root,"new"));
        for(let start=0;start<count;start+=25)await Promise.all(Array.from({length:Math.min(25,count-start)},async(_,offset)=>{
          const i=start+offset,name=`file-${String(i).padStart(4,"0")}.txt`,file=path.join(f.root,"new",name);
          await rename(path.join(f.root,"old",name),file); await writeFile(file,body.replace("Stable line 40:","Edited line 40:")+`Unique original ${i}\n`);
        })); await git(f.root,"add","-A");
      }else await git(f.root,"reset","--hard","HEAD");
      const index=path.join(f.root,".git/index"),before=await readFile(index),metadata=await stat(index);
      const native=await git(f.root,"-c","core.fsmonitor=false","status","--porcelain=v1","-z","--untracked-files=normal");
      assert.equal(native.length>0,state!=="clean");
      if(state!=="clean")assert.equal((native.match(/R\s /g)||[]).length,count,"The fixture must contain actual edited rename pairs");
      for(let repetition=0;repetition<3;repetition++){
        const timings:GitExecutionTiming[]=[],stop=setGitExecutionObserver(row=>timings.push(row));
        const at=performance.now(),cpu=process.cpuUsage();
        try{for(let check=0;check<2;check++)assert.equal(await hasWorkingTreeChanges(f.root,true),state!=="clean");}
        finally{stop();}
        const used=process.cpuUsage(cpu);
        rows.push({state,repetition,elapsedMs:performance.now()-at,nodeCpuMs:(used.user+used.system)/1000,calls:timings.length,gitMs:timings.reduce((sum,row)=>sum+row.elapsedMs,0)});
      }
      assert.deepEqual(await readFile(index),before);const after=await stat(index);assert.deepEqual([after.ino,after.mtimeMs,after.ctimeMs],[metadata.ino,metadata.mtimeMs,metadata.ctimeMs]);
    }
    assert.equal(gitProcesses.isBusy(f.root),false);
    const result={source:JSON.parse(process.env.GSC_BENCH_SOURCE||"null"),files:count+1,queriesPerSample:2,rows,nativeBooleanExact:true,indexBytesAndMetadataUnchanged:true,
      scope:"Native boolean status only; fixture setup outside elapsed samples; Node CPU excludes Git and OS; clean and dirty samples retained."};
    await writeFile(process.argv[2],JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));
  }finally{await gitProcesses.dispose();for(const cleanup of cleanups.reverse())await cleanup();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
