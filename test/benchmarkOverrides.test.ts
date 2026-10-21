import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { BenchmarkOverrides } from "./helpers/benchmarkOverrides";

test("benchmark overrides preserve method identity, descriptors, this and nested restoration", () => {
  const patches = new BenchmarkOverrides(), model = { value: 3, read(value: number) { return this.value + value; } };
  const original = Object.getOwnPropertyDescriptor(model, "read");
  const replacement = function (this: typeof model, value: number) { return this.value * value; };
  assert.equal(patches.method(model, "read", replacement), replacement); assert.equal(model.read, replacement);
  assert.equal(model.read(4), 12);
  patches.method(model, "read", () => { throw new Error("owned failure"); });
  assert.throws(() => model.read(4), /owned failure/);
  const inherited = Object.create(model) as typeof model;
  patches.method(inherited, "read", () => 19); assert.equal(inherited.read(4), 19);
  patches.restoreAll(); patches.restoreAll();
  assert.equal(Object.hasOwn(inherited, "read"), false); assert.deepEqual(Object.getOwnPropertyDescriptor(model, "read"), original);
  assert.equal(inherited.read(4), 7);
  Object.freeze(model); assert.throws(() => patches.method(model, "read", replacement));
  patches.restoreAll(); assert.equal(model.read(4), 7);
});

test("real GC distinguishes retained Node mock arguments from released benchmark overrides", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-benchmark-overrides-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, "overrides.cjs");
  // 테스트 runner에 esbuild 자체를 번들하지 않고 실제 설치본의 실행 파일 경계를 유지한다.
  const { build } = createRequire(path.resolve("package.json"))("esbuild") as typeof import("esbuild");
  await build({ entryPoints: [path.resolve("test/helpers/benchmarkOverrides.ts")], outfile, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
  const source = `
const assert=require('node:assert/strict'),{mock}=require('node:test'),{BenchmarkOverrides}=require(process.argv[1]);
function callAndRestore(scope){const target={run(){return 1}},argument={owned:true};const ref=new WeakRef(argument);
scope.method(target,'run',function(){return 2});assert.equal(target.run(argument),2);scope.restoreAll();return ref;}
async function collected(ref){for(let i=0;i<12;i++){await new Promise(setImmediate);global.gc();await new Promise(setImmediate);if(!ref.deref())return true;}return false;}
(async()=>{const native=callAndRestore(mock);assert.equal(await collected(native),false);mock.reset();assert.equal(await collected(native),true);
const plain=callAndRestore(new BenchmarkOverrides());assert.equal(await collected(plain),true);
console.log(JSON.stringify({nativeRestoreRetainsArguments:true,nativeResetReleasesArguments:true,benchmarkOverridesReleaseArguments:true}));})().catch(e=>{console.error(e);process.exitCode=1});`;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", "-e", source, outfile], { env, timeout: 15000 });
  assert.deepEqual(JSON.parse(stdout), { nativeRestoreRetainsArguments: true, nativeResetReleasesArguments: true, benchmarkOverridesReleaseArguments: true });
});
