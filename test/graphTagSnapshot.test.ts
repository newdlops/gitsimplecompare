import assert from "node:assert/strict";
import test from "node:test";
import { GitLogService } from "../src/git/gitLogService";
import { GitTagService } from "../src/git/gitTagService";
import { readGraphRefreshSnapshot } from "../src/git/graphRefreshFingerprint";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { createOperationGraphPanel } from "./helpers/graphOperationPanel";
import { addOrigin, git, safetyFixture } from "./helpers/gitSafetyFixture";

test("Native empty-tag snapshot skips only the duplicate local query and a later tag is freshly read", async t => {
  const f = await safetyFixture(t,"tag-snapshot"), service = new GitTagService(f.root);
  const snapshot = await readGraphRefreshSnapshot(f.root); assert.equal(snapshot.localTagsAbsent,true);
  const calls:string[]=[];const stop=setGitExecutionObserver(row=>calls.push(row.command));
  let empty;
  try { empty=await service.getTagStatuses({localTagsAbsent:snapshot.localTagsAbsent}); } finally {stop();}
  assert.deepEqual(empty,[]);assert.deepEqual(calls,["remote"]);
  await git(f.root,"tag","-a","v-annotated","-m","tag fixture");
  const changed=await readGraphRefreshSnapshot(f.root);assert.equal(changed.localTagsAbsent,undefined);
  const actual=await service.getTagStatuses({localTagsAbsent:changed.localTagsAbsent});
  assert.deepEqual(actual,[{name:"v-annotated",localHash:f.head,remoteTargets:[]}]);
});

test("an empty local-tag proof still reads remote-only tags from a Native bare receiver", async t => {
  const f = await safetyFixture(t, "remote-tag-snapshot"), remote = await addOrigin(f.root, f.directory);
  await git(remote, "tag", "remote-only", f.head);
  const snapshot = await readGraphRefreshSnapshot(f.root);
  assert.equal(snapshot.localTagsAbsent, true);
  const commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command));
  let tags;
  try { tags = await new GitTagService(f.root).getTagStatuses({localTagsAbsent:snapshot.localTagsAbsent}); }
  finally { stop(); }
  assert.equal(commands.includes("for-each-ref"), false);
  assert.equal(commands.filter(command => command === "ls-remote").length, 1);
  assert.deepEqual(tags, [{name:"remote-only",remoteTargets:[{remote:"origin",name:"remote-only",hash:f.head}]}]);
});

test("Graph tag changes retain a full decoration reload and publish current local tags",async t=>{
  const f=await safetyFixture(t,"tag-refresh"),h=createOperationGraphPanel(t,new GitLogService(f.root));
  t.after(()=>h.panel.dispose());
  let localReads=0;const originalRead=GitTagService.prototype.getLocalTagRefs;
  t.mock.method(GitTagService.prototype,"getLocalTagRefs",function(this:GitTagService,signal?:AbortSignal){
    localReads++;return originalRead.call(this,signal);
  });
  await h.panel.runDirectGraph("ready");await h.panel.tagLoading.active?.promise;
  assert.equal(localReads,0,"The actual Graph route should reuse its proven empty ref snapshot");
  let previous=h.panel.commits;
  for(const [args,expected] of [
    [["tag","v-first"],["v-first"]],
    [["tag","v-second"],["v-first","v-second"]],
    [["tag","-d","v-first"],["v-second"]],
    [["tag","-d","v-second"],[]],
  ] as const){
    await git(f.root,...args);const offset=h.messages.length;
    await h.panel.refreshAfterGraphAction("references");await h.panel.tagLoading.active?.promise;
    assert.notEqual(h.panel.commits,previous,"Tag changes still need the Native full decoration path");previous=h.panel.commits;
    const latest=h.messages.slice(offset).filter((m:any)=>m.type==="tagStatus").at(-1);
    assert.ok(latest,"Changed tag refs need a fresh status publication");
    assert.deepEqual((latest as any).tags.map((tag:any)=>tag.name),expected);
  }
});
