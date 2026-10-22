import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runGit } from "../src/git/gitExec";
import { setOwnedFsmonitorPolicy } from "../src/git/ownedFsmonitor";
import { gitProcesses } from "../src/git/gitProcessRegistry";

for(const split of [false,true])test(`mapped fsmonitor socket environment revalidates endpoint health (${split?"separate":"joined"} option)`,{skip:process.platform!=="darwin"},async t=>{
  const root=await mkdtemp(join(tmpdir(),"gsc-monitor-config-env-")),executable=join(root,"git-fixture"),checks=join(root,"queries");
  await writeFile(executable,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
if(args.includes('config'))process.stdout.write('true\\n');
else if(args.includes('fsmonitor--daemon')&&args.includes('status')){}
else if(args.includes('status')&&args.includes(':(top,exclude)**'))fs.appendFileSync(path.join(__dirname,'queries'),'query\\n');
else if(args.includes('diff'))process.stdout.write(process.env.GSC_MONITOR_SOCKET||'');
else process.exit(3);
`,{mode:0o755});
  const stop=setOwnedFsmonitorPolicy(()=>{});
  t.after(async()=>{stop();await gitProcesses.dispose();await rm(root,{recursive:true,force:true});});
  const mapping="fsmonitor.socketDir=GSC_MONITOR_SOCKET",globals=split?["--config-env",mapping]:[`--config-env=${mapping}`];
  for(const value of ["/fixture/first","/fixture/second"])
    assert.equal(await runGit([...globals,"diff"],root,{executable,env:{GIT_CONFIG_COUNT:"0",GSC_MONITOR_SOCKET:value}}),value);
  assert.equal((await readFile(checks,"utf8")).trim().split("\n").length,2,"a different endpoint must not borrow the first endpoint's healthy IPC proof");
});
