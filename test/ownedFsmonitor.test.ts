import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runGit, runGitWithInput, setGitExecutableResolver } from "../src/git/gitExec";
import { gitProcesses } from "../src/git/gitProcessRegistry";
import { ensureOwnedFsmonitor, setOwnedFsmonitorPolicy } from "../src/git/ownedFsmonitor";
import { registerStatusIndex } from "../src/git/statusIndexOwnership";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 foreground 자식과 status handshake를 사용하되 파일 감시/사용자 저장소는 만들지 않는다. */
async function fixture(t: TestContext, fail: boolean | "never-ready" | "existing" | "broken-status" | "unresponsive" | "owned-unresponsive" | "query-error" | "owned-query-error" | "hook" = false, configDelay = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-fsmonitor-session-"));
  const executable = path.join(root, "git-fixture"), ready = path.join(root, "monitor.pid"), count = path.join(root, "starts"), preparing = path.join(root, "preparing");
  const statusChecks = path.join(root, "status-checks");
  const queryChecks = path.join(root, "query-checks"), queryPid = path.join(root, "query.pid");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
  const args = process.argv.slice(2);
let at=0;
while (args[at]?.startsWith('-')) at+=['-c','-C','--config-env'].includes(args[at]) ? 2 : 1;
const command = args[at];
if (command === 'config') {
  fs.appendFileSync(${JSON.stringify(preparing)}, 'ready\\n');
  if (${fail === "hook"}) { process.stderr.write('bad boolean config value: /user/monitor-hook'); process.exit(128); }
  setTimeout(()=>process.stdout.write('true\\n'), ${configDelay});
}
else if (command === 'fsmonitor--daemon' && args.includes('status')) {
  fs.appendFileSync(${JSON.stringify(statusChecks)}, 'check\\n');
  if (${fail === "existing" || fail === "unresponsive" || fail === "query-error"}) process.exit(0);
  if (${fail === "never-ready"}) process.exit(1);
  try { process.kill(Number(fs.readFileSync(${JSON.stringify(ready)},'utf8')),0); } catch { process.exit(1); }
  if (${fail === "broken-status"}) process.exit(2);
} else if (command === 'fsmonitor--daemon' && args.includes('run')) {
  fs.appendFileSync(${JSON.stringify(count)}, 'start\\n');
  if (${fail === true}) process.exit(3);
  fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(()=>{},1000);
} else if (command === 'status' && args.includes(':(top,exclude)**')) {
  fs.appendFileSync(${JSON.stringify(queryChecks)}, 'query\\n');
  fs.writeFileSync(${JSON.stringify(queryPid)}, String(process.pid));
  if (${fail === "query-error" || fail === "owned-query-error"}) process.exit(1);
  if (${fail === "unresponsive" || fail === "owned-unresponsive"}) setInterval(()=>{},1000);
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
  return { root, executable, ready, count, preparing, reset, statusChecks, queryChecks, queryPid };
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
  assert.equal((await readFile(f.queryChecks, "utf8")).trim(), "query");
  await assert.rejects(readFile(f.count), { code: "ENOENT" });
});

test("an existing listening daemon with a stalled query is bypassed once for concurrent and later reads", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t, "unresponsive");
  t.after(() => gitProcesses.dispose());
  assert.deepEqual(await Promise.all([runGit(["diff"], f.root), runGit(["ls-files", "-z"], f.root)]), ["false", "false"]);
  assert.equal(await runGit(["status", "--porcelain"], f.root), "false");
  assert.equal((await readFile(f.queryChecks, "utf8")).trim(), "query", "a stalled IPC probe must be shared and cached");
  const pid = Number(await readFile(f.queryPid, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the probe must close before full scans begin");
  await assert.rejects(readFile(f.count), { code: "ENOENT" }, "an existing user's daemon must not be restarted");
});

test("status and literal untracked expansion share the same stalled monitor probe", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t, "unresponsive");
  t.after(() => gitProcesses.dispose());
  assert.equal(await runGit(["status", "--porcelain=v2", "--untracked-files=normal"], f.root), "false");
  assert.equal(await runGit(["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", "untracked/"], f.root), "false");
  assert.equal((await readFile(f.queryChecks, "utf8")).trim(), "query", "literal filenames must not add another stalled monitor query");
  assert.equal((await readFile(f.preparing, "utf8")).trim(), "ready");
});

test("pathspec-only flags share a healthy monitor while changed Git configuration keeps a separate preparation", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "existing");
  t.after(() => gitProcesses.dispose());
  await Promise.all([runGit(["status"], f.root), runGit(["--literal-pathspecs", "ls-files", "-z"], f.root)]);
  await runGit(["--glob-pathspecs", "diff"], f.root);
  await runGit(["--noglob-pathspecs", "--icase-pathspecs", "diff"], f.root);
  assert.equal((await readFile(f.queryChecks, "utf8")).trim(), "query", "only filename matching differs across the reads");
  await runGit(["-c", "include.path=/a/different/config", "--literal-pathspecs", "diff"], f.root);
  assert.equal((await readFile(f.queryChecks, "utf8")).trim().split("\n").length, 2, "configuration must remain part of monitor identity");
});

test("a newly owned daemon that listens but never answers is closed before the fallback read", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t, "owned-unresponsive");
  t.after(() => gitProcesses.dispose());
  assert.equal(await runGit(["diff"], f.root), "false");
  for (const file of [f.ready, f.queryPid]) {
    const pid = Number(await readFile(file, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

test("a query failure with exit one cannot be mistaken for a missing daemon and restart the user's daemon", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "query-error");
  t.after(() => gitProcesses.dispose());
  assert.equal(await runGit(["diff"], f.root), "false");
  await assert.rejects(readFile(f.count), { code: "ENOENT" });
  assert.equal((await readFile(f.queryChecks, "utf8")).trim(), "query");
});

test("an owned daemon query failure is not retried as a missing socket", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "owned-query-error");
  t.after(() => gitProcesses.dispose());
  assert.equal(await runGit(["diff"], f.root), "false");
  assert.equal((await readFile(f.queryChecks, "utf8")).trim(), "query");
  const pid = Number(await readFile(f.ready, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("session disposal cancels a pending daemon query without starting the waiting index read", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t, "unresponsive");
  t.after(() => gitProcesses.dispose());
  const pending = runGit(["diff"], f.root);
  // 선행 query 시작을 파일로 관찰해 임의의 sleep 뒤 취소하는 경쟁 조건을 피한다.
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(f.queryPid); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  const pid = Number(await readFile(f.queryPid, "utf8"));
  f.reset();
  await assert.rejects(pending, error => (error as { code?: string }).code === "ABORT_ERR");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("a broken handshake stops retrying instead of adding ten more Git startup delays", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "broken-status");
  assert.equal(await runGit(["diff"], f.root), "false");
  assert.ok((await readFile(f.statusChecks, "utf8")).trim().split("\n").length <= 4);
  const pid = Number(await readFile(f.ready, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("reference queries and index-free ref/object writes do not prepare an index monitor", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "never-ready");
  t.after(() => gitProcesses.dispose());
  for (const args of [["show-ref", "--verify", "--quiet", "refs/stash"], ["reflog", "show", "refs/stash"],
    ["reflog", "list"], ["ls-remote", "--tags", "origin"], ["check-ref-format", "refs/tags/release"],
    ["update-ref", "refs/gitsimplecompare/snapshot", "a".repeat(40)], ["commit-tree", "a".repeat(40), "-m", "snapshot"], ["mktree"]]) {
    assert.equal(await runGit(args, f.root), "inherited", `${args[0]} must not override monitor config for an index-free read`);
  }
  await assert.rejects(readFile(f.preparing), { code: "ENOENT" });
  await assert.rejects(readFile(f.count), { code: "ENOENT" });
});

test("native ref/object writes preserve the real index and do not start a builtin monitor", { skip: process.platform !== "darwin" }, async t => {
  const f = await safetyFixture(t, "index-free-native");
  const index = await readFile(path.join(f.root, ".git/index"));
  await git(f.root, "config", "core.fsmonitor", "true");
  const reset = setOwnedFsmonitorPolicy(() => undefined); t.after(reset);
  t.after(async () => {
    reset(); await gitProcesses.dispose();
    await runGit(["fsmonitor--daemon", "stop"], f.root, { retryOnLock: false }).catch(() => undefined);
  });
  const commands: string[] = [];
  const stop = setGitExecutionObserver(timing => commands.push(timing.command));
  let commit: string;
  try {
    const tree = (await runGitWithInput(["mktree"], f.root, "")).trim();
    commit = await git(f.root, "commit-tree", tree, "-p", f.head, "-m", "private object");
    await git(f.root, "update-ref", "refs/gitsimplecompare/index-free", commit);
  } finally { stop(); }
  assert.deepEqual(commands, ["mktree", "commit-tree", "update-ref"], "Index-free writes must not add a monitor probe or process");
  assert.deepEqual(await readFile(path.join(f.root, ".git/index")), index);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), f.head);
  assert.equal(await git(f.root, "rev-parse", "refs/gitsimplecompare/index-free"), commit);
  await assert.rejects(runGit(["fsmonitor--daemon", "status"], f.root, { retryOnLock: false }));
});

test("private status reads finish without waiting for a stalled monitor query", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t, "unresponsive");
  const index = path.join(f.root, "private-index");
  t.after(registerStatusIndex(index));
  t.after(() => gitProcesses.dispose());
  const env = { GIT_INDEX_FILE: index };
  const pending = runGit(["status", "--porcelain=v2"], f.root, { env, allowPrivateIndexWrites: true });
  // 실제 probe가 시작된 뒤 결과를 검사해 임의 시간 안에 끝났다는 속도 추측을 피한다.
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(f.queryPid); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  const pid = Number(await readFile(f.queryPid, "utf8"));
  assert.equal(await pending, "false");
  assert.doesNotThrow(() => process.kill(pid, 0), "the first snapshot must finish while monitor health is still being checked");
  assert.equal(await runGit(["--literal-pathspecs", "ls-files", "--others"], f.root, { env }), "false");
  assert.equal((await readFile(f.queryChecks, "utf8")).trim(), "query");
  f.reset(); await gitProcesses.dispose();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("private status reads use a confirmed healthy monitor after the first full scan", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t);
  const index = path.join(f.root, "private-index");
  t.after(registerStatusIndex(index));
  t.after(() => gitProcesses.dispose());
  const env = { GIT_INDEX_FILE: index };
  assert.equal(await runGit(["status", "--porcelain=v2"], f.root, { env }), "false");
  assert.equal(await ensureOwnedFsmonitor(f.root, { env, executable: f.executable }), true);
  assert.equal(await runGit(["status", "--porcelain=v2"], f.root, { env }), "inherited");
  assert.equal((await readFile(f.queryChecks, "utf8")).trim(), "query");
  assert.equal(gitProcesses.ownsMonitor(Number(await readFile(f.ready, "utf8")), f.root), true);
});

test("private status background preparation preserves a configured custom hook", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "hook");
  const index = path.join(f.root, "private-index");
  t.after(registerStatusIndex(index));
  t.after(() => gitProcesses.dispose());
  assert.equal(await runGit(["status", "--porcelain=v2"], f.root, { env: { GIT_INDEX_FILE: index } }), "inherited");
  await assert.rejects(readFile(f.queryChecks), { code: "ENOENT" });
  await assert.rejects(readFile(f.count), { code: "ENOENT" });
});
