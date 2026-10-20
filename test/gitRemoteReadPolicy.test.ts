import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitCommandPolicy } from "../src/git/gitCommandPolicy";
import { runGit } from "../src/git/gitExec";
import { gitProcesses } from "../src/git/gitProcessRegistry";

test("remote enumeration is read-only while every remote mutation remains protected", () => {
  for (const args of [["remote"], ["remote", "-v"], ["remote", "--verbose"], ["-c", "color.ui=false", "remote"], ["remote", "get-url", "origin"]]) {
    assert.equal(gitCommandPolicy(args).readOnly, true, args.join(" "));
  }
  for (const args of [["remote", "add", "origin", "/remote"], ["remote", "remove", "origin"], ["remote", "rename", "old", "new"],
    ["remote", "set-url", "origin", "/new"], ["remote", "update"], ["remote", "prune", "origin"], ["remote", "-v", "add", "origin", "/remote"]]) {
    assert.equal(gitCommandPolicy(args).readOnly, false, args.join(" "));
  }
});

test("Native remote enumeration emits no mutation completion while remote add still invalidates readers", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-remote-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(["-c", "init.templateDir=", "init", "-q"], root);
  const writes: string[] = [];
  t.after(gitProcesses.onDidFinishWrite(changed => { if (changed === root) writes.push(changed); }));
  await runGit(["remote"], root); await runGit(["remote", "-v"], root);
  assert.equal(writes.length, 0, "read-only remote discovery must not invalidate status caches as a write");
  await runGit(["remote", "add", "origin", path.join(root, "remote.git")], root);
  assert.equal(writes.length, 1);
  await runGit(["remote"], root); await runGit(["remote", "get-url", "origin"], root);
  assert.equal(writes.length, 1);
});

test("cancelling failed spawns without child PIDs never signals the test process group", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-missing-child-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [["status"], ["remote"], ["commit"]]) {
    const controller = new AbortController();
    const pending = runGit(args, root, { executable: path.join(root, "missing-executable"), signal: controller.signal });
    const rejected = assert.rejects(pending, (error: any) => error.code === "ABORT_ERR" || error.code === "ENOENT");
    controller.abort(); await rejected;
    assert.equal(gitProcesses.isBusy(root), false);
  }
});

test("explicit cancellation still terminates a successfully spawned write child", { skip: process.platform === "win32", timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-write-child-")), executable = path.join(root, "git-fixture"), ready = path.join(root, "ready.pid");
  const controller = new AbortController();
  t.after(() => controller.abort()); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);\n`, { mode: 0o755 });
  const pending = runGit(["commit"], root, { executable, signal: controller.signal });
  const rejected = assert.rejects(pending, (error: any) => error.code === "ABORT_ERR");
  let pid: number | undefined; const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { pid = Number(await readFile(ready, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(pid); controller.abort(); await rejected;
  assert.equal(gitProcesses.isBusy(root), false); assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
});
