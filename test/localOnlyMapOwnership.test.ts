import assert from "node:assert/strict";
import test from "node:test";
import type { Commit, LocalBranchStatus } from "../src/graph/graphTypes";
import { GitLocalOnlyBranchCache, type LocalOnlyBranchRunner } from "../src/git/gitLocalOnlyBranches";
import { GitLogService } from "../src/git/gitLogService";

/** 외부 원격이 없는 branch의 Native 입력만 만들어 ownership 검사를 DAG 계산과 함께 실행한다. */
function branch(hash = "tip"): LocalBranchStatus {
  return {name:"feature",hash,ahead:0,behind:0,gone:false,current:true,dateIso:"",subject:""};
}

/** 표시할 페이지의 commit은 cache 배열을 사전에 공유하지 않은 독립 DTO다. */
function commit(hash: string): Commit {
  return {hash,parents:[],refs:[],authorName:"Fixture",authorEmail:"fixture@example.test",dateIso:"",subject:hash};
}

test("readonly and mutable consumers share one calculation while public Map and arrays remain isolated", async () => {
  let calls=0;
  const cache=new GitLocalOnlyBranchCache("/fixture",async()=>{calls++;return "tip parent\nparent root\nroot\n";});
  cache.setLocalBranches([branch()]);cache.setRemoteTips([]);
  const [readonly,mutable]=await Promise.all([cache.getReadOnlyMap(),cache.getMap()]);
  assert.equal(calls,1);assert.strictEqual(readonly,cache.peek());assert.strictEqual(await cache.getReadOnlyMap(),readonly);
  assert.notStrictEqual(mutable,readonly);assert.notStrictEqual(mutable.get("tip"),readonly.get("tip"));
  mutable.get("tip")!.push("external edit");mutable.delete("parent");
  assert.deepEqual(readonly.get("tip"),["feature"]);assert.ok(readonly.has("parent"));
  const next=await cache.getMap();assert.notStrictEqual(next,mutable);assert.deepEqual(next.get("tip"),["feature"]);
  assert.equal(calls,1);
});

test("displaying a subset never iterates the full cached map and display edits cannot mutate membership", async t => {
  const service=new GitLogService("/fixture"),cache=(service as any).localOnlyBranchCache as GitLocalOnlyBranchCache;
  t.mock.method(cache as any,"runner",async()=>"tip parent\nparent root\nroot\n");
  service.seedGraphBranchTips([branch()],[]);await cache.getMap();
  const owned=cache.peek()!,iterate=owned[Symbol.iterator].bind(owned);let walks=0;
  t.mock.method(owned as Map<string,string[]>,Symbol.iterator,()=>{walks++;return iterate();});
  const page=[commit("tip"),commit("not-local")];
  assert.equal(await service.attachLocalOnlyBranches(page),1);
  assert.equal(walks,0,"A displayed subset must use keyed lookups, not duplicate every cached membership");
  assert.deepEqual(page[0].localOnlyBranches,["feature"]);
  assert.notStrictEqual(page[0].localOnlyBranches,owned.get("tip"));page[0].localOnlyBranches!.push("UI-only");
  assert.deepEqual(owned.get("tip"),["feature"]);assert.equal(page[1].localOnlyBranches,undefined);
  assert.equal(await service.attachLocalOnlyBranches(page),1);assert.deepEqual(page[0].localOnlyBranches,["feature"]);
  assert.equal(walks,0);
});

test("failed readonly reads preserve error identity, publish no partial cache and can recover", async () => {
  const failure=new Error("Native read failed");let calls=0;
  const runner:LocalOnlyBranchRunner=async()=>{if(++calls===1)throw failure;return "tip root\nroot\n";};
  const cache=new GitLocalOnlyBranchCache("/fixture",runner);cache.setLocalBranches([branch()]);cache.setRemoteTips([]);
  await assert.rejects(cache.getReadOnlyMap(),error=>error===failure);assert.equal(cache.peek(),undefined);
  assert.deepEqual((await cache.getReadOnlyMap()).get("tip"),["feature"]);assert.equal(calls,2);
});

test("a cancelled readonly generation cannot replace newer refs or keep its pending calculation", async () => {
  let calls=0,oldSignal:AbortSignal|undefined;
  const cache=new GitLocalOnlyBranchCache("/fixture",async(_args,_root,options)=>{
    if(++calls===1){oldSignal=options?.signal;return new Promise((_resolve,reject)=>oldSignal!.addEventListener("abort",()=>reject(new Error("cancelled")),{once:true}));}
    return "next root\nroot\n";
  });
  cache.setLocalBranches([branch()]);cache.setRemoteTips([]);const old=cache.getReadOnlyMap();
  cache.setLocalBranches([branch("next")]);await assert.rejects(old,/cancelled/);assert.equal(oldSignal?.aborted,true);
  const current=await cache.getReadOnlyMap();assert.equal(current.has("tip"),false);assert.deepEqual(current.get("next"),["feature"]);
  assert.strictEqual(cache.peek(),current);assert.equal(calls,2);
});
