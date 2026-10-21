import assert from "node:assert/strict";
import test from "node:test";
import { branchAction, cloneBranch } from "../src/webview/graphBranchActions";
import { __setQuickPickResult } from "./helpers/vscodeMock";

for(const current of [true,false]){
  test(`branch action menu reads only the selected identity and preserves current=${current} choices`,async()=>{
    let reads=0;
    const deps:any={logService:{repoRoot:"/fixture",getLocalBranchCheckoutState:async(name:string)=>{reads++;assert.equal(name,"feature");return{name,current};},
      getLocalBranches:async()=>{throw new Error("Full metadata must not be read for one menu");}}};
    __setQuickPickResult((items:any[])=>{assert.equal(items.some(item=>item.action==="checkout"),!current);return undefined;});
    try{await branchAction(deps,"feature","local");assert.equal(reads,1);}finally{__setQuickPickResult(undefined);}
  });
}

test("checkout after a menu still revalidates the selected branch instead of reusing menu state",async()=>{
  let reads=0,switched=false;
  const deps:any={logService:{repoRoot:"/fixture",getLocalBranchCheckoutState:async(name:string)=>({name,current:++reads>1}),
    checkoutLocalBranch:async()=>{switched=true;},getLocalBranches:async()=>{throw new Error("No full metadata");}}};
  __setQuickPickResult((items:any[])=>items.find(item=>item.action==="checkout"));
  try{await branchAction(deps,"feature","local");assert.equal(reads,2);assert.equal(switched,false);}finally{__setQuickPickResult(undefined);}
});

test("clone source lookup also avoids tracking counts while preserving the name selection flow",async()=>{
  let reads=0;
  const deps:any={logService:{repoRoot:"/fixture",getLocalBranchCheckoutState:async(name:string)=>{reads++;return{name,current:false};},
    getLocalBranches:async()=>{throw new Error("No full metadata");},getBranches:async()=>[{name:"feature",kind:"local"}]}};
  await cloneBranch(deps,"feature",false);assert.equal(reads,1);
});
