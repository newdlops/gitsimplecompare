// 조건부 Native ref 출력의 경과 시간과 종료된 자식 CPU를 분리하는 소유 fixture 진단이다.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const reportPath = process.argv[2] || join(tmpdir(), 'gsc-ref-conditional-cpu-report.json');
const temporary = await mkdtemp(join(tmpdir(), 'gsc-ref-cpu-build-'));
const entry = `
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit, runGitWithInput } from '${root}/src/git/gitExec';
import { gitProcesses } from '${root}/src/git/gitProcessRegistry';
import { loadChildResourceProbe } from '${root}/test/helpers/childResourceProbe';
const FS='\\x1f';
const formats={
 original:['%(refname)','%(objectname)','%(refname:short)'].join(FS),
 conditional:['%(refname)','%(objectname)','%(if:equals=refs/remotes)%(refname:rstrip=-2)%(then)%(refname:short)%(else)%(refname)%(end)'].join(FS),
 raw:['%(refname)','%(objectname)','%(refname)'].join(FS),
};
const orders=[['original','conditional','raw'],['conditional','raw','original'],['raw','original','conditional'],
 ['raw','conditional','original'],['conditional','original','raw'],['original','raw','conditional']];
const samples=[];
const env={GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'};
/** 소유 fixture를 공통 runner로 읽는다. stdout 원문은 결과 파일에 내보내지 않는다. */
async function read(root,key){return runGit(['for-each-ref','--format='+formats[key]],root,{env});}
/** 전체 ref identity와 실제 소비하는 원격 short name이 Native baseline과 같은지 확인한다. */
function validate(original,candidate,key){
 const a=original.trim().split('\\n').map(r=>r.split(FS)),b=candidate.trim().split('\\n').map(r=>r.split(FS));
 assert.equal(a.length,b.length);
 for(let i=0;i<a.length;i++){
  assert.deepEqual(a[i].slice(0,2),b[i].slice(0,2));
  if(key==='conditional'&&a[i][0].startsWith('refs/remotes/'))assert.equal(a[i][2],b[i][2]);
 }
}
/** 계측 모듈 빌드·fixture 구성·검증을 제외한 단일 Native 조회의 대기/CPU를 따로 측정한다. */
async function main(){
 const counterDirectory=await mkdtemp(join(tmpdir(),'gsc-ref-cpu-counter-'));
 try{
  const capture=await loadChildResourceProbe(counterDirectory);
  for(let life=0;life<3;life++){
   const parent=await mkdtemp(join(tmpdir(),'gsc-ref-cpu-owned-')),root=join(parent,'repo');
   try{
    await mkdir(root);await runGit(['-c','init.templateDir=','init','-q','-b','main'],root,{env});
    await runGit(['-c','user.name=Owned Probe','-c','user.email=probe@example.invalid','-c','commit.gpgSign=false','-c','core.hooksPath=/dev/null','commit','-q','--allow-empty','-m','owned fixture'],root,{env});
    const oid=(await runGit(['rev-parse','HEAD'],root,{env})).trim(),commands=[];
    for(let i=0;i<2000;i++)commands.push('update refs/tags/v'+String(i).padStart(4,'0')+' '+oid);
    for(let i=0;i<100;i++)commands.push('update refs/remotes/origin/b'+String(i).padStart(3,'0')+' '+oid);
    for(let i=0;i<20;i++)commands.push('update refs/heads/b'+String(i).padStart(3,'0')+' '+oid);
    commands.push('update refs/heads/origin/b000 '+oid);
    commands.push('update refs/gitsimplecompare/snapshot/owned '+oid);
    await runGitWithInput(['-c','core.fsync=none','update-ref','--stdin'],root,commands.join('\\n')+'\\n',{env});
    await runGit(['pack-refs','--all','--prune'],root,{env});
    const before=await read(root,'raw'),original=await read(root,'original');
    for(const key of ['conditional','raw'])validate(original,await read(root,key),key);
    for(let round=0;round<orders.length;round++){
     const order=orders[(round+life)%orders.length];
     for(const key of order){
      const childBefore=capture(),nodeBefore=process.cpuUsage(),start=performance.now();
      const out=await read(root,key),elapsedMs=performance.now()-start,nodeUsed=process.cpuUsage(nodeBefore),childAfter=capture();
      const childCpuMs=childAfter.userCpuMs-childBefore.userCpuMs+childAfter.systemCpuMs-childBefore.systemCpuMs;
      assert.ok(childCpuMs>0);
      samples.push({life,round,order,key,elapsedMs,nodeCpuMs:(nodeUsed.user+nodeUsed.system)/1000,childCpuMs,childBefore,childAfter,rows:out.split('\\n').filter(Boolean).length});
     }
    }
    assert.equal(await read(root,'raw'),before);
    console.log(JSON.stringify({completedLife:life+1}));
   }finally{await rm(parent,{recursive:true,force:true});}
  }
  const report={recordedAt:new Date().toISOString(),node:process.version,gitVersion:(await runGit(['--version'],process.cwd(),{env})).trim(),scope:'Owned packed-ref fixtures only; Node self CPU and OS-accounted waited Native child CPU measured separately. The single Git read is the only child in each sample. Build, setup, verification and cleanup excluded. No actual VS Code latency or whole-app CPU claim.',fixtures:3,tagRefs:2000,remoteRefs:100,localRefs:22,otherRefs:1,allIdentityAndRemoteShortNameChecksPassed:true,allRefsUnchanged:true,formats,samples};
  await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\\n');
  console.log(JSON.stringify({report:process.argv[2],samples:samples.length}));
 }finally{await rm(counterDirectory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>gitProcesses.dispose());
`;
try {
 const outfile=join(temporary,'probe.cjs');
 await build({stdin:{contents:entry,resolveDir:root,loader:'ts'},outfile,bundle:true,platform:'node',format:'cjs',target:'node18',logLevel:'silent',alias:{vscode:join(root,'test/helpers/vscodeMock.ts')}});
 const code=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[outfile,reportPath],{cwd:root,stdio:'inherit',env:{...process.env,DYLD_INSERT_LIBRARIES:'',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
  child.once('error',reject);child.once('close',code=>resolve(code??1));
 });
 if(code)process.exitCode=code;
}finally{await rm(temporary,{recursive:true,force:true});}
