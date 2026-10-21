import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitService } from "../../src/git/gitService";
import { runGit } from "../../src/git/gitExec";
import { gitCommandIndex } from "../../src/git/gitCommandPolicy";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { createGitOperationFixture } from "../helpers/gitOperationFixture";

/** fixture 경로 목록을 받아 최대 16개 파일만 동시에 생성하여 준비 단계의 IO 폭주를 막는다. */
async function putFiles(root: string, files: string[]) {
  let next = 0;
  await Promise.all(Array.from({length:Math.min(16,files.length)}, async () => {
    while(next<files.length) await fs.writeFile(path.join(root,files[next++]),"");
  }));
}

/** 실제 discard만 계측하고 선택하지 않은 파일, index, HEAD의 보존 여부를 별도로 검증한다. */
async function main() {
  const directory = await fs.mkdtemp(path.join(tmpdir(),"gsc-discard-benchmark-"));
  const results: any[] = [];
  try {
    const f = await createGitOperationFixture(directory), service = new GitService(f.root);
    await fs.mkdir(path.join(f.root,"unrelated")); await fs.mkdir(path.join(f.root,"selected-untracked"));
    const unrelated = Array.from({length:20000},(_,i)=>`unrelated/file-${i}.txt`);
    await putFiles(f.root,unrelated);
    const beforeIndex = await runGit(["ls-files","--stage","-z"],f.root);
    const spawn = childProcess.spawn, unlink = fs.unlink, remove = fs.rm;
    let active = false, outstanding = 0, maximumDeletes = 0;
    let calls: {command:string;pathLimited:boolean;stdoutBytes:number}[] = [];
    childProcess.spawn = ((...args: any[]) => {
      const child = (spawn as Function)(...args);
      if(active && args[0]==="git") {
        const row = {command:args[1][gitCommandIndex(args[1])],pathLimited:args[1].includes("--"),stdoutBytes:0}; calls.push(row);
        child.stdout.on("data",(chunk:Buffer)=>{row.stdoutBytes+=chunk.length;});
      }
      return child;
    }) as typeof spawn;
    /** 원래 삭제 함수를 그대로 호출하고 계측 중인 삭제의 최대 동시 실행 수를 기록한다. */
    const trackedDelete = (original: Function) => async (...args: any[]) => {
      const measured = active;
      if(measured) {outstanding++;maximumDeletes=Math.max(maximumDeletes,outstanding);}
      try{return await original(...args);}finally{if(measured)outstanding--;}
    };
    fs.unlink = trackedDelete(unlink) as typeof unlink; fs.rm = trackedDelete(remove) as typeof remove;
    try {
      for(const mode of ["one-tracked-among-untracked","five-hundred-untracked"]) {
        const selected = mode.startsWith("one") ? ["tracked-0.txt"] : Array.from({length:500},(_,i)=>`selected-untracked/${i}.txt`);
        if(mode.startsWith("one")) await fs.writeFile(path.join(f.root,selected[0]),"discard local edit\n"); else await putFiles(f.root,selected);
        calls=[];maximumDeletes=0; const cpu=process.cpuUsage(),start=performance.now();active=true;
        try{await service.discard(selected);}finally{active=false;}
        const used=process.cpuUsage(cpu),elapsedMs=Math.round(performance.now()-start);
        if(mode.startsWith("one")) assert.equal(await fs.readFile(path.join(f.root,selected[0]),"utf8"),"fixture data\n");
        else assert.deepEqual(await fs.readdir(path.join(f.root,"selected-untracked")),[]);
        assert.equal((await fs.readdir(path.join(f.root,"unrelated"))).length,20000);
        assert.equal(await runGit(["ls-files","--stage","-z"],f.root),beforeIndex);
        assert.equal((await runGit(["rev-parse","HEAD"],f.root)).trim(),f.main);
        assert.equal(gitProcesses.isBusy(f.root),false);
        results.push({mode,elapsedMs,nodeCpuMs:Math.round((used.user+used.system)/1000),gitCalls:calls.length,
          classificationBytes:calls.filter(row=>row.command==="ls-files").reduce((sum,row)=>sum+row.stdoutBytes,0),
          maximumDeletes,calls,exactIndexAndHead:true,unselectedFilesPreserved:20000});
      }
    } finally {childProcess.spawn=spawn;fs.unlink=unlink;fs.rm=remove;}
    const report={source:JSON.parse(process.env.GSC_BENCH_SOURCE!),fixture:{files:f.files,unrelatedUntracked:20000,bulkSelection:500},results,
      scope:"Native GitService discard; fixture setup and exact verification excluded from timing; Node CPU excludes Git/OS"};
    await fs.writeFile(process.argv[2],JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));
  }finally{await gitProcesses.dispose();await fs.rm(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
