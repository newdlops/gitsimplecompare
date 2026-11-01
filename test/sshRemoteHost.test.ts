// 사용자 SSH 설정 대신 소유 config와 실제 ssh -G/소유 프로세스로 별칭과 수명을 검증한다.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSshRemoteHost } from "../src/git/sshRemoteHost";
import { runManagedGhRead } from "../src/git/ghManagedRead";

/** 실제 SSH는 -F로 지정한 소유 config만 읽고 네트워크 연결은 만들지 않는다. */
test("native SSH Include/HostName aliases resolve like gh and preserve a foreign host", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-ssh-host-")); t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, "config"), included = path.join(root, "included");
  await writeFile(config, `Include ${included}\nHost *\n  BatchMode yes\n`);
  await writeFile(included, "Host github-work\n  HostName ssh.github.com\nHost company-*\n  HostName ghe.example\n");
  const execute: typeof runManagedGhRead = (executable, args, cwd, options) => runManagedGhRead(executable, ["-F", config, ...args], cwd, options);
  assert.equal(await resolveSshRemoteHost("github-work", root, {}, execute), "github.com");
  assert.equal(await resolveSshRemoteHost("company-work", root, {}, execute), "ghe.example");
});

/** stdout/stderr를 소유 파일에 남기지 않고 PID만 기록하는 무해한 장기 실행 경계다. */
async function processFixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-ssh-lifetime-")); t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "pid");
  const execute: typeof runManagedGhRead = (_executable, _args, cwd, options) => runManagedGhRead(process.execPath,
    ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`], cwd, options);
  const pid = async () => { const until = Date.now() + 2000; for (;;) {
    try { return Number(await readFile(marker, "utf8")); } catch { assert(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 5)); }
  } };
  return { root, execute, pid };
}

test("SSH evaluation cancellation waits for the owned process to close", async t => {
  const f = await processFixture(t), controller = new AbortController();
  const pending = resolveSshRemoteHost("github-work", f.root, { signal: controller.signal }, f.execute);
  const rejected = assert.rejects(pending, { name: "AbortError" }), pid = await f.pid();
  controller.abort(); await rejected; assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("a stalled SSH evaluation returns the original-host fallback only after owned close", async t => {
  const f = await processFixture(t), pending = resolveSshRemoteHost("github-work", f.root, {}, f.execute), pid = await f.pid();
  assert.equal(await pending, undefined); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("malformed hostnames never become SSH options or executable requests", async () => {
  let calls = 0;
  const execute: typeof runManagedGhRead = async () => { calls++; return "hostname github.com\n"; };
  for (const host of ["-Fconfig", "github.com\nProxyCommand", "github.com user"]) assert.equal(await resolveSshRemoteHost(host, "/repo", {}, execute), undefined);
  assert.equal(calls, 0);
});

test("relative PATH entries cannot launch an executable supplied by the repository", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-ssh-path-")); t.after(() => rm(root, { recursive: true, force: true }));
  let executable = "";
  const result = await resolveSshRemoteHost("github-work", root, { env: { ...process.env, PATH: "." } }, async name => { executable = name; return "hostname github.com\n"; });
  assert.equal(result, undefined); assert.equal(executable, "");
});

test("Windows SSH CRLF output preserves canonical hostname translation", async () => {
  assert.equal(await resolveSshRemoteHost("github-work", "/repo", {}, async () => "hostname SSH.GITHUB.COM\r\nuser git\r\n"), "github.com");
});
