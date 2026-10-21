import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GitLogService } from "../src/git/gitLogService";
import { gitProcesses } from "../src/git/gitProcessRegistry";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { disposeWorkingTreeSnapshots } from "../src/git/workingTreeSnapshot";
import { createOperationGraphPanel } from "./helpers/graphOperationPanel";
import { readNativeGraphExpectation } from "./helpers/graphNativeExpectation";
import { addOrigin, commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 제품이 실제로 시작한 marker/status 조회와 owned Git 종료를 기다린다. 별도로 결과를 예열하지 않는다. */
async function settled(panel:any,service:GitLogService) {
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){
    const cache=(service as any).localOnlyBranchCache;
    if(!panel.loading&&!panel.workingTree.state?.loading&&!gitProcesses.isBusy(service.repoRoot)&&cache.completed){
      await new Promise(resolve=>setTimeout(resolve,20));
      if(!panel.loading&&!gitProcesses.isBusy(service.repoRoot)&&cache.completed)return;
    }
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error("Graph local-only read did not settle");
}

/** 이미 게시한 feature가 main을 upstream으로 삼는 실제 PR 브랜치와 같은 형태를 만든다. */
async function fixture(t:TestContext) {
  const f=await safetyFixture(t,"graph-local-only-reuse"); await addOrigin(f.root,f.directory);
  await git(f.root,"switch","-qc","feature"); const tip=await commitText(f.root,"feature\n","feature");
  await git(f.root,"push","-qu","origin","feature");
  await git(f.root,"config","branch.feature.merge","refs/heads/main");
  await git(f.root,"branch","alias",tip); await git(f.root,"config","branch.alias.remote","origin");
  await git(f.root,"config","branch.alias.merge","refs/heads/main");
  const service=new GitLogService(f.root),{panel}=createOperationGraphPanel(t,service);
  t.after(async()=>{panel.dispose();await disposeWorkingTreeSnapshots();await gitProcesses.dispose();});
  assert.equal(await panel.runDirectGraph("ready"),true); await settled(panel,service);
  assert.deepEqual(panel.commits.find((c:any)=>c.hash===tip).localOnlyBranches,["alias","feature"]);
  return {...f,tip,service,panel};
}

for(const action of ["unchanged fetch","loaded checkout"]){
  test(`Native ${action} revalidates local-only markers without another DAG read`,{timeout:60000},async t=>{
    const f=await fixture(t), index=await readFile(join(f.root,".git/index"));
    await writeFile(join(f.root,"untracked.txt"),"keep me\n");
    if(action==="unchanged fetch")await f.service.fetchAll();else await f.service.checkoutLocalBranch("alias");
    let walks=0;const stop=setGitExecutionObserver(timing=>{if(timing.command==="rev-list")walks++;});
    try{if(action==="unchanged fetch")await f.panel.refreshAfterFetchAction();else await f.panel.refreshAfterCheckoutAction();await settled(f.panel,f.service);}finally{stop();}
    assert.equal(walks,0,"Unchanged Native local/remote/history proof must avoid another DAG walk");
    const actual=await readNativeGraphExpectation(f.root,f.panel.commits.length);
    const values=(commits:any[])=>commits.map(c=>[c.hash,c.parents,[...c.refs].sort(),[...c.localOnlyBranches??[]].sort()]).sort();
    assert.deepEqual(values(f.panel.commits),values(actual));
    assert.equal(await readFile(join(f.root,"untracked.txt"),"utf8"),"keep me\n");
    if(action==="unchanged fetch")assert.deepEqual(await readFile(join(f.root,".git/index")),index);
  });
}

test("Native upstream and shallow changes discard old markers even when branch OIDs stay fixed",{timeout:60000},async t=>{
  const f=await fixture(t); await f.service.fetchAll();
  await git(f.root,"config","branch.feature.merge","refs/heads/feature");
  await f.panel.refreshAfterFetchAction();await settled(f.panel,f.service);
  assert.deepEqual(f.panel.commits.find((c:any)=>c.hash===f.tip).localOnlyBranches,["alias"]);
  await writeFile(join(f.root,".git/shallow"),f.tip+"\n"); await f.service.fetchAll();
  let walks=0;const stop=setGitExecutionObserver(timing=>{if(timing.command==="rev-list")walks++;});
  try{await f.panel.refreshAfterFetchAction();await settled(f.panel,f.service);}finally{stop();}
  assert.ok(walks>0,"Changed topology cannot reuse the old marker map");
  const actual=await readNativeGraphExpectation(f.root,f.panel.commits.length);
  assert.deepEqual(f.panel.commits.map((c:any)=>[c.hash,c.parents,c.localOnlyBranches]),actual.map(c=>[c.hash,c.parents,c.localOnlyBranches]));
});
