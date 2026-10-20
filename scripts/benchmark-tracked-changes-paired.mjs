// 같은 프로세스·fixture에서 두 source를 교대 실행해 실행 순서와 GC 영향을 분리한다.
// GSC_BENCH_SOURCE_REF, 홀수 GSC_BENCH_SAMPLES(기본 5), 선택적 GSC_BENCH_MODES를 지원한다.
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import os from 'node:os';
const workspace=process.cwd(),require=createRequire(path.join(workspace,'package.json')),{build}=require('esbuild');
// 측정 프로세스에 상속된 다른 저장소·index·object 경계를 제거해 새 fixture만 사용한다.
for(const key of Object.keys(process.env))if(key.startsWith('GIT_'))delete process.env[key];
process.env.GIT_CONFIG_NOSYSTEM='1';process.env.GIT_CONFIG_GLOBAL=process.platform==='win32'?'NUL':'/dev/null';
const reference=execFileSync('git',['rev-parse','--verify','--end-of-options',(process.env.GSC_BENCH_SOURCE_REF||'HEAD')+'^{commit}'],{cwd:workspace}).toString().trim();
const samplesRequested=Number(process.env.GSC_BENCH_SAMPLES||5),allowedModes=['staged','unstaged','clean','cancelling','branch-squash'];
const modes=process.env.GSC_BENCH_MODES?process.env.GSC_BENCH_MODES.split(','):allowedModes;
assert.ok(Number.isSafeInteger(samplesRequested)&&samplesRequested>0&&samplesRequested<=11&&samplesRequested%2===1);
assert.ok(modes.length>0&&modes.every(mode=>allowedModes.includes(mode)));
const directory=await mkdtemp(path.join(os.tmpdir(),'gsc-tracked-paired-')),baseline=path.join(directory,'baseline');
const versions=[],files=['src/git/workingTreeChanges.ts','src/git/pullRequestOperationSnapshot.ts','src/git/branchOperationService.ts'];
try{
await mkdir(baseline);
const archive=execFileSync('git',['archive',reference],{cwd:workspace,maxBuffer:64*1024*1024});
execFileSync('tar',['-x','-C',baseline],{input:archive});
for(const [name,root]of [['before',baseline],['after',workspace]]){
 const outfile=path.join(directory,name+'.cjs'),contents="export {PullRequestOperationSnapshot} from './src/git/pullRequestOperationSnapshot';export {BranchOperationService} from './src/git/branchOperationService';export {runGit,runGitWithInput} from './src/git/gitExec';export {setGitExecutionObserver} from './src/git/gitExecutionDiagnostics';export {setOwnedFsmonitorPolicy} from './src/git/ownedFsmonitor';export {gitProcesses} from './src/git/gitProcessRegistry';";
 await build({stdin:{contents,loader:'ts',resolveDir:root},outfile,bundle:true,platform:'node',format:'cjs',target:'node18',logLevel:'silent',alias:{vscode:path.join(root,'test/helpers/vscodeMock.ts')},nodePaths:[path.join(workspace,'node_modules')]});
 const sourceSha256=Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])));
 versions.push({name,api:require(outfile),sourceSha256,bundleSha256:createHash('sha256').update(await readFile(outfile)).digest('hex')});
}
const shared=versions[1].api,root=path.join(directory,'repository');await mkdir(root);
// fixture 전용 고정 root와 인자 배열로 Git을 호출하고 셸에는 전달하지 않는다.
const git=args=>shared.runGit(args,root);
await git(['-c','init.templateDir=','init','-q','--initial-branch=main']);
for(const [key,value]of Object.entries({'core.fsmonitor':'false','core.hooksPath':path.join(directory,'hooks'),'commit.gpgSign':'false','user.name':'Paired Fixture','user.email':'fixture@example.invalid'}))await git(['config',key,value]);
await mkdir(path.join(directory,'hooks'));
const data=['blob','mark :1','data 5','base\n','blob','mark :2','data 7','source\n','commit refs/heads/main','mark :3','committer Paired Fixture <fixture@example.invalid> 1700000000 +0000','data 4','base',...Array.from({length:1000},(_,i)=>'M 100644 :1 tracked-'+i+'.txt'),'','commit refs/heads/source','mark :4','committer Paired Fixture <fixture@example.invalid> 1700000001 +0000','data 6','source','from :3','M 100644 :2 tracked-0.txt',''];
await shared.runGitWithInput(['fast-import','--quiet'],root,data.join('\n')+'\n');
await git(['reset','--hard','main']);
const [base,tree]=(await git(['rev-parse','main','source^{tree}'])).trim().split('\n');
// 원본 표본을 유지하고 홀수 개 측정값의 중앙값만 별도로 계산한다.
const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
const results=[];
 for(const mode of modes){
  console.log('Paired '+mode);
  await git(['reset','--hard',base]);
  if(mode!=='clean'&&mode!=='branch-squash')await writeFile(path.join(root,'tracked-0.txt'),'changed\n');
  if(mode==='staged'||mode==='cancelling')await git(['add','tracked-0.txt']);
  if(mode==='cancelling')await writeFile(path.join(root,'tracked-0.txt'),'base\n');
  const expected=Boolean(await git(['status','--porcelain=v1','-z','--untracked-files=no']));
  const index=await readFile(path.join(root,'.git/index')),samples=[[],[]],stopPolicies=versions.map(v=>v.api.setOwnedFsmonitorPolicy(()=>{}));
  try{
   for(let round=-1;round<samplesRequested;round++)for(const i of (round%2===0?[0,1]:[1,0])){
    const api=versions[i].api;
    if(mode==='branch-squash'){await git(['reset','--hard',base]);stopPolicies[i]();stopPolicies[i]=api.setOwnedFsmonitorPolicy(()=>{});}
    global.gc?.();
    const timings=[],stop=api.setGitExecutionObserver(value=>timings.push(value));
    const cpu=process.cpuUsage(),started=performance.now();let value;
    try{value=mode==='branch-squash'?await new api.BranchOperationService(root).squashMerge('source'):await new api.PullRequestOperationSnapshot(root).hasPendingChanges();}finally{stop();}
    const elapsedMs=performance.now()-started,used=process.cpuUsage(cpu);
    if(mode==='branch-squash'){assert.equal(value.status,'completed');assert.equal((await git(['rev-parse','HEAD^{tree}'])).trim(),tree);}
    else{assert.equal(value,expected);assert.deepEqual(await readFile(path.join(root,'.git/index')),index);}
    if(round>=0)samples[i].push({elapsedMs,nodeCpuMs:(used.user+used.system)/1000,processes:timings.length,commands:timings.reduce((m,t)=>(m[t.command]=(m[t.command]??0)+1,m),{})});
   }
  }finally{for(const stop of stopPolicies)stop();}
  results.push({mode,exact:true,indexPreserved:mode!=='branch-squash',versions:versions.map((v,i)=>({name:v.name,samples:samples[i],median:Object.fromEntries(['elapsedMs','nodeCpuMs','processes'].map(key=>[key,median(samples[i].map(x=>x[key]))]))}))});
 }
 const result={baselineCommit:reference,runtime:process.version,warmup:1,samples:samplesRequested,sameProcess:true,sameFixture:true,alternatingOrder:true,gcOutsideTiming:true,files:1000,versions:versions.map(({api,...rest})=>rest),results};
 if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(results.map(({mode,versions})=>({mode,versions:versions.map(v=>({name:v.name,median:v.median}))}))));
}finally{
 for(const v of versions)await v.api.gitProcesses.dispose();
 await rm(directory,{recursive:true,force:true});
}
