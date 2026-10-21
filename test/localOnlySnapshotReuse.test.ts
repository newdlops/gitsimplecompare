import assert from "node:assert/strict";
import test from "node:test";
import { LocalOnlySnapshotReuse, localOnlyHistoryKey } from "../src/git/localOnlySnapshotReuse";
import { GitLocalOnlyBranchCache } from "../src/git/gitLocalOnlyBranches";

/** 새 local/remote가 모두 확인된 완료 결과를 만들며 cache 내부 구현과 다른 key를 사용한다. */
function completed(value = new Map([["commit", ["feature"]]])) {
  const cache = new LocalOnlySnapshotReuse(); cache.begin("history"); cache.localRead(); cache.remoteRead(); cache.complete("refs",value);
  return {cache,value};
}

test("invalidated membership needs fresh local, remote and identical history proof", () => {
  const {cache,value}=completed(); cache.invalidate(); cache.begin("history");
  assert.equal(cache.restore("refs"),undefined); cache.localRead(); assert.equal(cache.restore("refs"),undefined);
  cache.remoteRead(); assert.equal(cache.restore("refs"),value);
  cache.invalidate(); cache.begin("history"); cache.remoteRead(); assert.equal(cache.restore("refs"),undefined);
  cache.localRead(); assert.equal(cache.restore("refs"),value);
});

test("a changed ref, missing proof, new topology or cancellation never approves the old map", () => {
  for(const mode of ["refs","unknown","topology","hidden"]){
    const {cache}=completed(); cache.invalidate(); cache.begin(mode==="unknown"?undefined:mode==="topology"?"new":"history");
    cache.localRead(); cache.remoteRead(); if(mode==="hidden")cache.cancel();
    assert.equal(cache.restore(mode==="refs"?"changed":"refs"),undefined,mode);
  }
});

test("a temporary remote failure cannot approve a candidate and a new full snapshot can", () => {
  const {cache,value}=completed(); cache.invalidate(); cache.begin("history"); cache.localRead(); cache.remoteRead(); cache.remoteUnavailable();
  assert.equal(cache.restore("refs"),undefined); cache.remoteRead(); assert.equal(cache.restore("refs"),value);
});

test("a result computed from partial metadata is never retained for the next refresh", () => {
  const cache=new LocalOnlySnapshotReuse(); cache.begin("history"); cache.localRead(); cache.complete("refs",new Map());
  cache.invalidate(); cache.begin("history"); cache.localRead(); cache.remoteRead(); assert.equal(cache.restore("refs"),undefined);
});

test("candidate retention is bounded by entry count, memberships and estimated text/object size", () => {
  for(const value of [new Map(Array.from({length:4097},(_,i)=>[String(i),["branch"]])),
    new Map([["one",Array.from({length:65537},()=>"branch")]]),new Map([["one",["x".repeat(3*1024*1024)]]])]){
    const {cache}=completed(value); cache.invalidate(); cache.begin("history"); cache.localRead(); cache.remoteRead();
    assert.equal(cache.restore("refs"),undefined);
  }
});

test("history key includes replacements and executable environment while checkout identity is separate", () => {
  const fingerprint=(head:string,replace="")=>`${head}\nrefs/heads/main\nrefs/heads/main hash\n${replace}--worktrees--\nworktrees`;
  const first=localOnlyHistoryKey("history",fingerprint("old"),"git-path");
  assert.equal(localOnlyHistoryKey("history",fingerprint("new"),"git-path"),first);
  assert.notEqual(localOnlyHistoryKey("history",fingerprint("old","refs/replace/original replacement\n"),"git-path"),first);
  assert.notEqual(localOnlyHistoryKey("history",fingerprint("old","refs/custom-replacements/original replacement\n"),"git-path"),first);
  assert.notEqual(localOnlyHistoryKey("history",fingerprint("old"),"another-path"),first);
  assert.equal(localOnlyHistoryKey(undefined,fingerprint("old"),"git-path"),undefined);
  assert.equal(localOnlyHistoryKey("history","incomplete","git-path"),undefined);
});

test("consecutive refreshes without history proof never reuse a completed unknown-topology map",async()=>{
  let reads=0;
  const cache=new GitLocalOnlyBranchCache("/fixture",async()=>++reads===1?"head parent\nparent\n":"head\n");
  const branches=[{name:"main",hash:"head",current:true,ahead:0,behind:0,gone:false,dateIso:"",subject:""}];
  cache.beginSnapshot(undefined,"head\nrefs/heads/main\n--worktrees--");cache.setLocalBranches(branches);cache.setRemoteTips([]);
  assert.equal((await cache.getMap()).has("parent"),true);
  cache.beginSnapshot(undefined,"head\nrefs/heads/main\n--worktrees--");cache.setLocalBranches(branches);cache.setRemoteTips([]);
  assert.equal((await cache.getMap()).has("parent"),false);assert.equal(reads,2);
});
