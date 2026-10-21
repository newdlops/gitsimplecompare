import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gitCommandPolicy } from "../src/git/gitCommandPolicy";
import { fetchNegotiationCommand } from "../src/git/gitFetchNegotiation";
import { GitError, runGit } from "../src/git/gitExec";
import { gitProcesses } from "../src/git/gitProcessRegistry";

test("only the fixed object-free negotiation shape is a cancellable read",()=>{
  for(const length of [40,64]) {
    const args=fetchNegotiationCommand("a".repeat(length),"owned-server");
    assert.equal(gitCommandPolicy(args).readOnly,true);
    assert.equal(gitCommandPolicy(["-c","fetch.prune=true",...args]).readOnly,true);
    for(let i=1;i<args.indexOf("--");i++)assert.equal(gitCommandPolicy(args.filter((_arg,index)=>index!==i)).readOnly,false);
    for(const extra of ["--write-fetch-head","--prune","--write-commit-graph","--auto-maintenance","refs/heads/main:refs/heads/replaced"])
      assert.equal(gitCommandPolicy([...args,extra]).readOnly,false);
    assert.equal(gitCommandPolicy(["fetch","--negotiate-only","--","owned-server"]).readOnly,false);
    assert.equal(gitCommandPolicy(["fetch","--all"]).readOnly,false);
  }
  assert.throws(()=>fetchNegotiationCommand("HEAD","owned-server"));assert.throws(()=>fetchNegotiationCommand("a".repeat(40),""));
});

test("negotiation read deadlines close the owned process while ordinary fetch stays protected",{skip:process.platform==="win32"},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"gsc-negotiation-deadline-")),executable=path.join(root,"git-fixture");
  t.after(async()=>{await gitProcesses.dispose();await rm(root,{recursive:true,force:true});});
  await writeFile(executable,`#!${process.execPath}\nsetTimeout(()=>process.stdout.write('done'),150);\n`,{mode:0o755});
  await assert.rejects(runGit(fetchNegotiationCommand("a".repeat(40),"owned-server"),root,{executable,readTimeoutMs:20}),error=>error instanceof GitError&&error.code==="ETIMEDOUT");
  assert.equal(gitProcesses.isBusy(root),false);
  assert.equal(await runGit(["fetch"],root,{executable,readTimeoutMs:20}),"done");
});
