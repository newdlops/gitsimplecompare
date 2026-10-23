import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { GraphBranchCatalog } from "../src/git/graphBranchCatalog";
import { GitError, runGit } from "../src/git/gitExec";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 임의의 지연 없이 공유 조회와 실제 close 경계를 각각 해제한다. */
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
/** 현재 Promise 연쇄를 관찰하기 위해 이벤트 루프를 한 번만 진행한다. */
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const remote = "0123456789012345678901234567890123456789\x1forigin/main\x1frefs/remotes/origin/main\n";

test("a cold Native catalog burst resolves one common directory and one exact remote snapshot", async t => {
  const f = await safetyFixture(t, "common-directory-burst");
  await git(f.root, "update-ref", "refs/remotes/origin/main", f.head);
  const files = ["index", "HEAD", "config"].map(name => path.join(f.root, ".git", name));
  const before = await Promise.all(files.map(file => readFile(file)));
  const calls: string[] = [], catalog = new GraphBranchCatalog((args, root, options) => {
    calls.push(args[0]); return runGit(args, root, options);
  });
  const values = await Promise.all(Array.from({ length: 32 }, () => catalog.getRemoteTips(f.root)));
  const expected = [{ hash: f.head, name: "origin/main", fullRef: "refs/remotes/origin/main", kind: "remote" }];
  for (const value of values) assert.deepEqual(value, expected);
  values[0][0].name = "consumer-only"; assert.deepEqual(values[1], expected);
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
  assert.deepEqual(calls.sort(), ["for-each-ref", "rev-parse"], "A same-root burst must not launch one directory process per consumer");
});

test("cancelling one common-directory consumer does not cancel the other Native lookup", async t => {
  const f = await safetyFixture(t, "common-directory-cancel"), gate = barrier(); t.after(gate.release);
  const left = new AbortController(); let directoryCalls = 0, nativeAborts = 0;
  const catalog = new GraphBranchCatalog(async (args, root, options) => {
    if (args[0] === "rev-parse") {
      directoryCalls++; options?.signal?.addEventListener("abort", () => { nativeAborts++; }, { once: true });
      await gate.promise;
    }
    return runGit(args, root, options);
  });
  const first = catalog.getRemoteTips(f.root, left.signal), firstRejected = assert.rejects(first, /cancelled/i);
  const second = catalog.getRemoteTips(f.root);
  await turn(); left.abort(); gate.release(); await firstRejected; await second;
  assert.equal(directoryCalls, 1); assert.equal(nativeAborts, 0);
});

test("a new directory consumer waits for cancelled Native close before starting a replacement", async t => {
  const closed = barrier(), aborted = barrier(); t.after(closed.release);
  let directoryCalls = 0, active = 0, maximum = 0;
  const catalog = new GraphBranchCatalog(async (args, _root, options) => {
    if (args[0] !== "rev-parse") return remote;
    directoryCalls++; active++; maximum = Math.max(maximum, active);
    try {
      if (directoryCalls === 1) {
        options?.signal?.addEventListener("abort", aborted.release, { once: true });
        await aborted.promise; await closed.promise;
        throw new DOMException("Native directory read cancelled after close", "AbortError");
      }
      return "/owned-common-close/.git\n";
    } finally { active--; }
  });
  const controller = new AbortController(), first = catalog.getRemoteTips("/owned-directory-close", controller.signal);
  const rejection = assert.rejects(first, /cancelled/i);
  await turn(); controller.abort(); await aborted.promise;
  const next = catalog.getRemoteTips("/owned-directory-close"); await turn();
  try { assert.equal(directoryCalls, 1, "The stopped process still owns its slot until close"); }
  finally { closed.release(); }
  await rejection; assert.equal((await next)[0].name, "origin/main");
  assert.equal(directoryCalls, 2); assert.equal(maximum, 1);
});

test("a cached catalog burst schedules at most one orphan sweep and still returns independent snapshots", async t => {
  const catalog = new GraphBranchCatalog(async args => args[0] === "rev-parse" ? "/owned-timer-common/.git\n" : remote);
  await catalog.getRemoteTips("/owned-timer-root"); await turn();
  const original = globalThis.setTimeout; let sweeps = 0;
  t.mock.method(globalThis, "setTimeout", ((...args: Parameters<typeof setTimeout>) => {
    if (args[1] === 0) sweeps++;
    return Reflect.apply(original, globalThis, args);
  }) as typeof setTimeout);
  const values = await Promise.all(Array.from({ length: 128 }, () => catalog.getRemoteTips("/owned-timer-root")));
  await turn(); assert.ok(sweeps <= 1, `Orphan timer burst: ${sweeps}`);
  assert.equal(values.length, 128); assert.notEqual(values[0], values[1]);
});

for (const code of ["ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "GIT_READ_STOPPING"]) {
  test(`a common-directory ${code} cannot become a successful fallback catalog`, async () => {
    const stopped = new GitError("Native common-directory read stopped", "", "", Object.assign(new Error("stopped"), { code }));
    let remoteReads = 0;
    const catalog = new GraphBranchCatalog(async args => {
      if (args[0] === "rev-parse") throw stopped;
      remoteReads++; return remote;
    });
    await assert.rejects(catalog.getRemoteTips(`/owned-stopped-${code}`), error => error === stopped);
    assert.equal(remoteReads, 0);
  });
}

test("an aborted caller cannot receive a cached successful catalog or spawn more Git reads", async () => {
  let calls = 0;
  const catalog = new GraphBranchCatalog(async args => {
    calls++; return args[0] === "rev-parse" ? "/owned-cached-cancel/.git\n" : remote;
  });
  await catalog.getRemoteTips("/owned-cached-cancel"); const before = calls;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(catalog.getRemoteTips("/owned-cached-cancel", controller.signal), error => (error as Error).name === "AbortError");
  assert.equal(calls, before);
});
