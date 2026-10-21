import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runGitWithInput } from "../src/git/gitExec";
import { gitCommandIndex } from "../src/git/gitCommandPolicy";
import { ensureRemoteBranchForCurrentBranch } from "../src/ui/remoteBranchSetup";
import { RemoteBranchService } from "../src/git/remoteBranchService";
import { PullService } from "../src/git/pullService";
import { addOrigin, git, safetyFixture } from "./helpers/gitSafetyFixture";
import { window } from "./helpers/vscodeMock";

/** 계측 구간의 실제 Git 명령과 stdout 크기만 기록하며 fixture 준비·사후 확인은 제외한다. */
function observe(t: TestContext) {
  const spawn = childProcess.spawn, calls: { command: string; bytes: number }[] = [];
  const mock = t.mock.method(childProcess,"spawn",(...args: any[]) => {
    const child = (spawn as Function)(...args);
    if (args[0] === "git") {
      const row = { command: args[1][gitCommandIndex(args[1])], bytes: 0 }; calls.push(row);
      child.stdout.on("data",(chunk: Buffer) => { row.bytes += chunk.length; });
    }
    return child;
  });
  return {calls,stop:() => mock.mock.restore()};
}

test("a ready pull upstream uses one Native read without enumerating two thousand remote branches", async t => {
  const f = await safetyFixture(t,"pull-ready-gate"); await addOrigin(f.root,f.directory);
  await runGitWithInput(["update-ref","--stdin"],f.root,Array.from({length:2117},(_,i)=>`create refs/remotes/origin/extra-${i} ${f.head}\n`).join(""));
  await writeFile(join(f.root,"tracked.txt"),"keep unstaged\n");
  const index = await readFile(join(f.root,".git/index")),config = await readFile(join(f.root,".git/config"));
  const quickPick = t.mock.method(window,"showQuickPick",async () => {throw new Error("A configured upstream must not open setup");});
  const recording = observe(t);
  try { assert.equal(await ensureRemoteBranchForCurrentBranch(f.root,"pull"),true); }
  finally { recording.stop(); }
  assert.equal(recording.calls.length,1,JSON.stringify(recording.calls));
  assert.deepEqual(recording.calls.map(row=>row.command),["rev-parse"]);
  assert.ok(recording.calls[0].bytes < 256); assert.equal(quickPick.mock.callCount(),0);
  assert.deepEqual(await readFile(join(f.root,".git/index")),index);
  assert.deepEqual(await readFile(join(f.root,".git/config")),config);
  assert.equal(await readFile(join(f.root,"tracked.txt"),"utf8"),"keep unstaged\n");
  assert.equal(await git(f.root,"rev-parse","HEAD"),f.head);
});

for (const mode of ["configured","local-dot","gone","no-upstream","detached","unborn"]) {
  test(`Native pull upstream probe preserves ${mode} semantics`,async t => {
    const f = await safetyFixture(t,`pull-upstream-${mode}`);
    if (mode === "unborn") {
      await mkdir(join(f.directory,"empty")); await git(f.directory,"init","-q","-b","main",join(f.directory,"empty"));
      assert.equal(await new RemoteBranchService(join(f.directory,"empty")).hasCurrentBranchUpstream(),false); return;
    }
    if (["configured","gone","detached"].includes(mode)) await addOrigin(f.root,f.directory);
    if (mode === "local-dot") {
      await git(f.root,"branch","local-base"); await git(f.root,"config","branch.main.remote",".");
      await git(f.root,"config","branch.main.merge","refs/heads/local-base");
    }
    if (mode === "gone") await git(f.root,"update-ref","-d","refs/remotes/origin/main");
    if (mode === "detached") await git(f.root,"switch","--detach","-q");
    const index = await readFile(join(f.root,".git/index")),config = await readFile(join(f.root,".git/config"));
    assert.equal(await new RemoteBranchService(f.root).hasCurrentBranchUpstream(),["configured","local-dot"].includes(mode));
    assert.deepEqual(await readFile(join(f.root,".git/index")),index);
    assert.deepEqual(await readFile(join(f.root,".git/config")),config);
    assert.equal(await git(f.root,"rev-parse","HEAD"),f.head);
  });
}

test("an invalid repository is reported without opening pull setup",async t => {
  const f = await safetyFixture(t,"pull-invalid-gate"),root = join(f.directory,"not-a-repo"); await mkdir(root);
  const quickPick = t.mock.method(window,"showQuickPick",async () => {throw new Error("Read errors must not open setup");});
  await assert.rejects(ensureRemoteBranchForCurrentBranch(root,"pull"),/not a git repository/i);
  assert.equal(quickPick.mock.callCount(),0);
});

test("a gone upstream still opens the existing complete setup choices without changing config",async t => {
  const f = await safetyFixture(t,"pull-gone-setup"); await addOrigin(f.root,f.directory);
  await git(f.root,"update-ref","refs/remotes/origin/available",f.head);
  await git(f.root,"update-ref","-d","refs/remotes/origin/main");
  const config = await readFile(join(f.root,".git/config")); let labels: string[] = [];
  const picker = t.mock.method(window,"showQuickPick",async (items: any) => { labels = (await items).map((item: any)=>item.label); return undefined; });
  assert.equal(await ensureRemoteBranchForCurrentBranch(f.root,"pull"),false);
  assert.equal(picker.mock.callCount(),1); assert.ok(labels.some(label=>label.includes("origin/available")));
  assert.deepEqual(await readFile(join(f.root,".git/config")),config);
  assert.equal(await git(f.root,"rev-parse","HEAD"),f.head);
});

test("upstream probes always observe current configuration and preserve actual pull validation",async t => {
  const f = await safetyFixture(t,"pull-upstream-fresh"); await addOrigin(f.root,f.directory);
  const service = new RemoteBranchService(f.root);
  assert.equal(await service.hasCurrentBranchUpstream(),true);
  await git(f.root,"config","--unset","branch.main.remote");
  assert.equal(await service.hasCurrentBranchUpstream(),false);
  await assert.rejects(new PullService(f.root).pullCurrent(),/no upstream configured/);
  assert.equal(await git(f.root,"rev-parse","HEAD"),f.head);
  await git(f.root,"config","branch.main.remote","origin");
  assert.equal(await service.hasCurrentBranchUpstream(),true);
});

test("a corrupt config is propagated instead of being interpreted as an unset upstream",async t => {
  const f = await safetyFixture(t,"pull-corrupt-config"); await addOrigin(f.root,f.directory);
  const invalid = Buffer.from("[branch \"main\"\ninvalid\n"); await writeFile(join(f.root,".git/config"),invalid);
  const picker = t.mock.method(window,"showQuickPick",async () => {throw new Error("Broken repository must not open setup");});
  await assert.rejects(ensureRemoteBranchForCurrentBranch(f.root,"pull"),/bad config|invalid config/i);
  assert.equal(picker.mock.callCount(),0); assert.deepEqual(await readFile(join(f.root,".git/config")),invalid);
});

test("the upstream probe follows the linked worktree rather than the main worktree branch",async t => {
  const f = await safetyFixture(t,"pull-linked-probe"); await addOrigin(f.root,f.directory);
  const root = join(f.directory,"linked"); await git(f.root,"worktree","add","-qb","linked",root);
  const linked = new RemoteBranchService(root);
  assert.equal(await linked.hasCurrentBranchUpstream(),false);
  assert.equal(await new RemoteBranchService(f.root).hasCurrentBranchUpstream(),true);
  await git(root,"branch","--set-upstream-to=origin/main","linked");
  assert.equal(await linked.hasCurrentBranchUpstream(),true);
  assert.equal(await git(f.root,"branch","--show-current"),"main");
  assert.equal(await git(root,"branch","--show-current"),"linked");
});
