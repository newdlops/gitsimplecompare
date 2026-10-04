import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { SharedMonitorInspection } from "../src/git/sharedMonitorInspection";
import type { GitMonitorSnapshot } from "../src/git/idleGitCleanup";

const complete: GitMonitorSnapshot = { complete: true, monitors: [] };

/** 실제 임시 파일을 쓰는 서로 다른 창 coordinator에 같은 공유 디렉터리를 제공한다. */
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-shared-inspection-test-"));
  const directory = path.join(root, "shared");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory };
}

test("simultaneous windows perform one inspection and reuse its recent completed snapshot", async t => {
  const f = await fixture(t); let calls = 0;
  const load = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 100)); return complete; };
  const first = new SharedMonitorInspection(f.directory, load), second = new SharedMonitorInspection(f.directory, load);
  const values = await Promise.all([first.read(), second.read(), second.read()]);
  assert.equal(calls, 1);
  assert.ok(values.every(value => value.complete));
  await first.read(); assert.equal(calls, 1);
  values[0].monitors.push({} as never);
  assert.deepEqual((await second.read()).monitors, [], "local consumers cannot mutate the stored snapshot");
});

test("independent extension-host processes share one actual inspection lease", async t => {
  const f = await fixture(t), module = path.join(f.root, "reader.cjs"), count = path.join(f.root, "calls");
  const run = promisify(execFile);
  await run(path.resolve("node_modules/esbuild/bin/esbuild"), ["src/git/sharedMonitorInspection.ts", `--outfile=${module}`, "--bundle", "--platform=node", "--format=cjs", "--log-level=error"]);
  const worker = path.join(f.root, "worker.cjs");
  await writeFile(worker, `const {SharedMonitorInspection}=require(${JSON.stringify(module)});const fs=require('node:fs/promises');new SharedMonitorInspection(${JSON.stringify(f.directory)},async()=>{await fs.appendFile(${JSON.stringify(count)},'load\\n');await new Promise(r=>setTimeout(r,150));return {complete:true,monitors:[]};}).read().then(v=>process.stdout.write(String(v.complete)));`);
  const results = await Promise.all([run(process.execPath, [worker]), run(process.execPath, [worker])]);
  assert.ok(results.every(result => result.stdout === "true"));
  assert.equal((await readFile(count, "utf8")).trim(), "load");
});

test("failed inspection backs off across windows and a successful retry resets the backoff", async t => {
  const f = await fixture(t); let now = 1000, calls = 0, succeeds = false;
  const load = async () => { calls++; return succeeds ? complete : { complete: false, monitors: [], reason: "test-unavailable" }; };
  const first = new SharedMonitorInspection(f.directory, load, () => now), second = new SharedMonitorInspection(f.directory, load, () => now);
  assert.equal((await first.read()).complete, false);
  now += 59_000; await second.read(); assert.equal(calls, 1);
  now += 1001; await second.read(); assert.equal(calls, 2);
  now += 119_000; await first.read(); assert.equal(calls, 2);
  now += 1001; succeeds = true; assert.equal((await first.read()).complete, true); assert.equal(calls, 3);
  now += 15_001; await second.read(); assert.equal(calls, 4);
});

test("a dead lease owner is reclaimed without accepting malformed cached data", async t => {
  const f = await fixture(t);
  await mkdir(f.directory, { mode: 0o700 });
  await mkdir(path.join(f.directory, "lease"), { mode: 0o700 });
  await writeFile(path.join(f.directory, "lease", "2147483647-dead.json"), "{}", { mode: 0o600 });
  await writeFile(path.join(f.directory, "snapshot.json"), "{broken", { mode: 0o600 });
  const cache = new SharedMonitorInspection(f.directory, async () => complete);
  assert.equal((await cache.read()).complete, true);
});
