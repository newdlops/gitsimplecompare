import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GhCliError, runGh } from "../src/git/ghCli";
import { beginGitHubReadLifetime, GitHubReadCache, readGitHub } from "../src/git/githubReadCache";

/** fixture 파일을 만들고 실패 후에도 생성한 파일만 삭제한다. */
async function executable(t: TestContext, body: string, cleanup = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-gh-lifecycle-"));
  const file = path.join(root, "gh-fixture");
  await writeFile(file, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  if (cleanup) t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file };
}

/** SIGTERM을 무시하는 자식과 선택적으로 자연 종료하는 부모를 만들고 소유 PID만 사후 회수한다. */
async function stubborn(t: TestContext, independentChild = false) {
  const fixture = await executable(t, `
const fs = require('node:fs');
const {spawn} = require('node:child_process');
if (process.env.GSC_GH_CHILD === '1' || process.env.GSC_GH_INDEPENDENT !== '1') process.on('SIGTERM', () => {});
if (process.env.GSC_GH_CHILD === '1') setInterval(() => {}, 1000);
else {
  const child = spawn(process.execPath, [__filename], {env:{...process.env,GSC_GH_CHILD:'1'},stdio:process.env.GSC_GH_INDEPENDENT === '1' ? 'ignore' : 'inherit'});
  setTimeout(() => fs.writeFileSync(process.env.GSC_GH_READY, JSON.stringify([process.pid,child.pid])), 100);
  setInterval(() => {}, 1000);
}
`, false);
  const ready = path.join(fixture.root, "ready.json");
  t.after(async () => {
    try { for (const pid of JSON.parse(await readFile(ready, "utf8"))) {
      try { process.kill(pid, "SIGKILL"); } catch { /* 이미 종료한 fixture다. */ }
    } } catch { /* spawn 실패 때는 준비 파일이 없다. */ }
    await rm(fixture.root, { recursive: true, force: true });
  });
  return { ...fixture, ready, env: { GITHUB_CLI_PATH: fixture.file, GSC_GH_READY: ready, GSC_GH_INDEPENDENT: independentChild ? "1" : "0" } };
}

/** 시작 지연과 종료 상한을 분리해 신호 처리기 준비 후 취소한다. */
async function waitForReady(file: string): Promise<number[]> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  throw new Error("GitHub fixture did not start.");
}

/** 종료 이후 대기는 5초로 제한하며 준비 중 실패도 observed Promise에서 즉시 처리한다. */
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Owned GitHub read did not close.")), 5000);
  })]); } finally { clearTimeout(timer!); }
}

for (const independent of [false, true]) {
  test(`managed cancellation waits for resistant GitHub descendants (independent stdio: ${independent})`, { skip: process.platform === "win32" }, async t => {
    const fixture = await stubborn(t, independent), controller = new AbortController();
    t.after(() => controller.abort());
    const observed = runGh(["api"], fixture.root, { env: fixture.env, managedRead: true, signal: controller.signal, operation: "test" })
      .then(() => undefined, error => error);
    const pids = await waitForReady(fixture.ready);
    controller.abort();
    const error = await bounded(observed);
    assert.ok(error instanceof GhCliError); assert.equal(error.code, "ABORTED");
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

test("repeated cache lifetimes await actual CLI closure and leave no owned processes", { skip: process.platform === "win32" }, async t => {
  for (let session = 0; session < 3; session++) {
    const fixture = await stubborn(t);
    const cache = new GitHubReadCache();
    const observed = cache.read(["api"], fixture.root, { env: fixture.env, operation: "test" }).then(() => undefined, error => error);
    const pids = await waitForReady(fixture.ready);
    await bounded(cache.dispose());
    assert.equal((await observed).name, "AbortError");
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
});

test("managed output collection preserves UTF-8 split across stream chunks", async t => {
  const fixture = await executable(t, `const data=Buffer.from('한글 🌱'); process.stdout.write(data.subarray(0,2)); setTimeout(()=>process.stdout.write(data.subarray(2)),20);`);
  assert.equal(await runGh(["api"], fixture.root, { env: { GITHUB_CLI_PATH: fixture.file }, managedRead: true }), "한글 🌱");
});

test("buffer overflow rejects after close and retains the existing gh error contract", async t => {
  const fixture = await executable(t, `process.stdout.write('x'.repeat(100)); setInterval(()=>{},1000);`);
  await assert.rejects(bounded(runGh(["api"], fixture.root, { env: { GITHUB_CLI_PATH: fixture.file }, managedRead: true, maxBufferBytes: 20 })),
    (error: unknown) => error instanceof GhCliError && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && error.stdout.length === 20);
});

test("GitHub writes stay outside read-cache disposal and retain their full response", async t => {
  const fixture = await executable(t, `setTimeout(()=>process.stdout.write('write-completed'),150);`);
  const pending = runGh(["pr", "edit"], fixture.root, { env: { GITHUB_CLI_PATH: fixture.file }, operation: "test-write" });
  await new GitHubReadCache().dispose();
  assert.equal(await pending, "write-completed");
});

test("an older lifetime disposer cannot stop a newer activation's successful read", async t => {
  const fixture = await executable(t, "process.stdout.write('new-lifetime');");
  const older = beginGitHubReadLifetime(), newer = beginGitHubReadLifetime();
  t.after(newer);
  await older();
  assert.equal(await readGitHub(["api"], fixture.root, { operation: "test", env: { GITHUB_CLI_PATH: fixture.file } }), "new-lifetime");
  await newer();
  await assert.rejects(readGitHub(["api"], fixture.root, { operation: "test" }), { name: "AbortError" });
});
