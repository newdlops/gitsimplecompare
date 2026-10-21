import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test, { type TestContext } from "node:test";
import { hasWorkingTreeChanges } from "../src/git/workingTreeChanges";
import { runGit, setGitExecutableResolver } from "../src/git/gitExec";
import { gitProcesses } from "../src/git/gitProcessRegistry";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 기존 Native status가 성공한 동일 상태의 boolean만 대조한다. 경로 해석·rename 표시는 oracle에 맡긴다. */
async function check(root: string): Promise<boolean> {
  const index = path.join(root, ".git/index"), bytes = await readFile(index);
  const expected = (await runGit(["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=normal"], root)).length > 0;
  assert.equal(await hasWorkingTreeChanges(root, true), expected);
  assert.deepEqual(await readFile(index), bytes, "a boolean read must not refresh or replace the real index");
  return expected;
}

test("staged edited renames, inverse unstaged edits and deletions preserve Native change detection", async t => {
  const f = await safetyFixture(t, "change-flag-rename");
  assert.equal(await check(f.root), false);
  await rename(path.join(f.root,"tracked.txt"),path.join(f.root,"renamed.txt"));
  await writeFile(path.join(f.root,"renamed.txt"),"base\nextra line\n"); await git(f.root,"add","-A");
  assert.equal(await check(f.root), true);
  await writeFile(path.join(f.root,"renamed.txt"),"base\n"); assert.equal(await check(f.root), true);
  await git(f.root,"reset","--hard",f.head); assert.equal(await check(f.root), false);
  await rm(path.join(f.root,"tracked.txt")); assert.equal(await check(f.root), true);
});

test("ignored-only paths, literal names and user untracked display settings retain Native semantics", async t => {
  const f = await safetyFixture(t, "change-flag-untracked");
  await writeFile(path.join(f.root,".git/info/exclude"),"ignored/\n");
  await mkdir(path.join(f.root,"ignored")); await writeFile(path.join(f.root,"ignored/local.txt"),"local\n");
  assert.equal(await check(f.root), false);
  await git(f.root,"config","status.showUntrackedFiles","no");
  await mkdir(path.join(f.root,"new [literal]\nfolder")); await writeFile(path.join(f.root,"new [literal]\nfolder/new.txt"),"local\n");
  assert.equal(await check(f.root), true);
});

/** 실제 자식은 stdout을 일부 내보낸 뒤 성공/실패한다. 외부 저장소나 감시자는 만들지 않는다. */
async function outputFixture(t: TestContext, fail: boolean, retry = false) {
  const root = await mkdtemp(path.join(os.tmpdir(),"gsc-change-flag-output-")), executable = path.join(root,"git-fixture");
  await writeFile(executable,`#!${process.execPath}
const fs=require('node:fs'),counter=${JSON.stringify(path.join(root,"attempts"))};
const first=!fs.existsSync(counter);fs.appendFileSync(counter,'attempt\\n');
if (${retry} && !first) process.exit(0);
process.stdout.write(Buffer.alloc(2*1024*1024,120),()=>{if(${fail} || ${retry}){process.stderr.write(${retry}?"fatal: Unable to create index.lock: File exists":"fatal: damaged index");process.exitCode=128;}});
`,{mode:0o755});
  t.after(()=>rm(root,{recursive:true,force:true})); t.after(setGitExecutableResolver(()=>executable));
  return {root};
}

test("a large streamed change flag completes only after Native close and releases the owned slot", async t => {
  const f=await outputFixture(t,false);
  assert.equal(await hasWorkingTreeChanges(f.root,true),true);
  assert.equal(gitProcesses.isBusy(f.root),false);
});

test("partial stdout followed by a Native failure cannot become a successful change flag", async t => {
  const f=await outputFixture(t,true);
  await assert.rejects(hasWorkingTreeChanges(f.root,true),/damaged index/);
  assert.equal(gitProcesses.isBusy(f.root),false);
});

test("a safe lock retry discards the previous partial flag before accepting a clean result", async t => {
  const f=await outputFixture(t,false,true);
  assert.equal(await hasWorkingTreeChanges(f.root,true),false);
  assert.equal((await readFile(path.join(f.root,"attempts"),"utf8")).trim().split("\n").length,2);
  assert.equal(gitProcesses.isBusy(f.root),false);
});
