import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runGit, setGitExecutableResolver } from "../src/git/gitExec";
import { gitProcesses } from "../src/git/gitProcessRegistry";
import { setOwnedFsmonitorPolicy } from "../src/git/ownedFsmonitor";

/** 실제 foreground 자식과 status handshake를 사용하되 파일 감시/사용자 저장소는 만들지 않는다. */
async function fixture(t: TestContext, fail: boolean | "never-ready" | "existing" | "broken-status" = false, configDelay = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-fsmonitor-session-"));
  const executable = path.join(root, "git-fixture"), ready = path.join(root, "monitor.pid"), count = path.join(root, "starts"), preparing = path.join(root, "preparing");
  const statusChecks = path.join(root, "status-checks");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
  const args = process.argv.slice(2);
let at=0;
while (args[at]?.startsWith('-')) at+=['-c','-C','--config-env'].includes(args[at]) ? 2 : 1;
const command = args[at];
if (command === 'config') { fs.appendFileSync(${JSON.stringify(preparing)}, 'ready\\n'); setTimeout(()=>process.stdout.write('true\\n'), ${configDelay}); }
else if (command === 'fsmonitor--daemon' && args.includes('status')) {
  fs.appendFileSync(${JSON.stringify(statusChecks)}, 'check\\n');
  if (${fail === "existing"}) process.exit(0);
  if (${fail === "never-ready"}) process.exit(1);
  try { process.kill(Number(fs.readFileSync(${JSON.stringify(ready)},'utf8')),0); } catch { process.exit(1); }
  if (${fail === "broken-status"}) process.exit(2);
} else if (command === 'fsmonitor--daemon' && args.includes('run')) {
  fs.appendFileSync(${JSON.stringify(count)}, 'start\\n');
  if (${fail === true}) process.exit(3);
  fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(()=>{},1000);
} else {
  let value='inherited';
  for(let i=0;i<Number(process.env.GIT_CONFIG_COUNT||0);i++) if(process.env['GIT_CONFIG_KEY_'+i]==='core.fsmonitor') value=process.env['GIT_CONFIG_VALUE_'+i];
  for(let i=0;i<at;i++) if(args[i]==='-c' && args[i+1]?.startsWith('core.fsmonitor')) value=args[i+1].split('=')[1]||'true';
  process.stdout.write(value);
}
`, { mode: 0o755 });
  t.after(async () => {
    try { process.kill(Number(await readFile(ready, "utf8")), "SIGKILL"); } catch { /* 제품 종료로 이미 회수한 자식이다. */ }
    await rm(root, { recursive: true, force: true });
  });
  t.after(setGitExecutableResolver(() => executable));
  const reset = setOwnedFsmonitorPolicy(() => undefined); t.after(reset);
  return { root, ready, count, preparing, reset, statusChecks };
}

test("ordinary index reads start one owned foreground monitor independently of idle cleanup settings", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t);
  await Promise.all([runGit(["diff", "--name-only"], f.root), runGit(["ls-files", "-z"], f.root)]);
  const pid = Number(await readFile(f.ready, "utf8"));
  assert.equal(gitProcesses.ownsMonitor(pid, f.root), true);
  assert.equal(gitProcesses.ownsMonitor(pid, await realpath(f.root)), true);
  assert.equal(typeof gitProcesses.lastUsed(await realpath(f.root)), "number");
  assert.equal((await readFile(f.count, "utf8")).trim(), "start");
  await gitProcesses.dispose();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("failed monitor preparation forces a command-scope fallback without changing repository settings", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, true);
  assert.equal(await runGit(["diff", "--name-only"], f.root), "false");
  await gitProcesses.dispose();
});

test("explicit command-scope fsmonitor=false bypasses monitor startup", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t);
  await runGit(["-c", "core.fsmonitor=false", "status", "--porcelain"], f.root);
  await assert.rejects(readFile(f.count, "utf8"), { code: "ENOENT" });
});

test("session disposal while Git preparation is pending prevents a late index read or daemon spawn", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, false, 500);
  const pending = runGit(["diff", "--name-only"], f.root);
  for (let i = 0; i < 100; i++) {
    try { await readFile(f.preparing); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  await readFile(f.preparing); f.reset();
  await assert.rejects(pending, error => (error as { code?: string }).code === "ABORT_ERR");
  await gitProcesses.dispose();
  await assert.rejects(readFile(f.count, "utf8"), { code: "ENOENT" });
});

test("a failed startup overrides earlier CLI fsmonitor=true as well as inherited environment", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, true);
  const args = ["-c", "core.fsmonitor=true", "diff", "--name-only"];
  assert.equal(await runGit(args, f.root), "false");
  assert.deepEqual(args, ["-c", "core.fsmonitor=true", "diff", "--name-only"]);
  await gitProcesses.dispose();
});

test("a live monitor that never becomes ready is closed before falling back to a full scan", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "never-ready");
  assert.equal(await runGit(["diff", "--name-only"], f.root), "false");
  const pid = Number(await readFile(f.ready, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(gitProcesses.ownsMonitor(pid, f.root), false);
});

test("CLI true overrides an earlier false or environment false before ownership preparation", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t);
  await runGit(["-c", "core.fsmonitor=false", "-c", "core.fsmonitor", "diff"], f.root);
  const pid = Number(await readFile(f.ready, "utf8"));
  assert.equal(gitProcesses.ownsMonitor(pid, f.root), true);
  await gitProcesses.dispose();
});

test("an explicit caller hook is preserved even after a cached failed builtin preparation", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, true);
  assert.equal(await runGit(["diff"], f.root), "false");
  assert.equal(await runGit(["-c", "core.fsmonitor=/user/monitor-hook", "diff"], f.root), "/user/monitor-hook");
  assert.equal((await readFile(f.count, "utf8")).trim(), "start");
});

test("config-env true takes precedence over inherited false before preparing the monitor", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t);
  await runGit(["--config-env=core.fsmonitor=GSC_MONITOR_VALUE", "diff"], f.root, { env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false", GSC_MONITOR_VALUE: "true" } });
  assert.equal(gitProcesses.ownsMonitor(Number(await readFile(f.ready, "utf8")), f.root), true);
  await gitProcesses.dispose();
});

test("creating another worktree cannot autostart an unmanaged monitor in the new directory", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t);
  assert.equal(await runGit(["worktree", "add", "/other/worktree", "branch"], f.root), "false");
  await assert.rejects(readFile(f.count), { code: "ENOENT" });
});

test("a confirmed existing monitor is reused during a burst without repeated Git preparation probes", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "existing");
  await runGit(["diff"], f.root); await runGit(["status"], f.root);
  assert.equal((await readFile(f.preparing, "utf8")).trim(), "ready");
  await assert.rejects(readFile(f.count), { code: "ENOENT" });
});

test("a broken handshake stops retrying instead of adding ten more Git startup delays", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "broken-status");
  assert.equal(await runGit(["diff"], f.root), "false");
  assert.ok((await readFile(f.statusChecks, "utf8")).trim().split("\n").length <= 4);
  const pid = Number(await readFile(f.ready, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("reference and remote-reference queries do not prepare an index monitor", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "never-ready");
  t.after(() => gitProcesses.dispose());
  for (const args of [["show-ref", "--verify", "--quiet", "refs/stash"], ["reflog", "show", "refs/stash"],
    ["reflog", "list"], ["ls-remote", "--tags", "origin"], ["check-ref-format", "refs/tags/release"]]) {
    assert.equal(await runGit(args, f.root), "inherited", `${args[0]} must not override monitor config for an index-free read`);
  }
  await assert.rejects(readFile(f.preparing), { code: "ENOENT" });
  await assert.rejects(readFile(f.count), { code: "ENOENT" });
});
