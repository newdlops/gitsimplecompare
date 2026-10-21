import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PhaseMemorySampler } from "./helpers/phaseMemorySampler";
import { summarizePhaseMemory } from "./helpers/phaseMemorySummary";

test("phase RSS includes a real touched allocation and excludes its observer through actual close", { skip: process.platform === "win32" }, async t => {
  const worker = spawn(process.execPath, ["-e", "globalThis.bytes=Buffer.alloc(64*1024*1024,171);process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "inherit"] });
  const closed = once(worker, "close");
  t.after(async () => { if (worker.exitCode === null) worker.kill(); await closed; });
  await once(worker.stdout!, "data");
  const sampler = await PhaseMemorySampler.start([]);
  t.after(() => sampler.stop());
  const result = await sampler.stop();
  assert.equal(result.complete, true); assert.deepEqual(result.errors, []);
  assert.equal(result.rootPid, process.pid); assert.ok(result.samples.length >= 2);
  for (const sample of result.samples) {
    assert.ok(sample.pids.includes(process.pid)); assert.ok(sample.pids.includes(worker.pid!));
    assert.equal(sample.pids.includes(result.observerPid), false);
    assert.equal(sample.sumRssBytes, sample.nodeRssBytes + sample.chromiumRssBytes + sample.otherOwnedRssBytes);
    assert.ok(sample.otherOwnedRssBytes >= 64*1024*1024);
    assert.equal(sample.chromiumRssBytes, 0);
  }
  assert.deepEqual(await sampler.stop(), result);
  assert.throws(() => process.kill(result.observerPid, 0), { code: "ESRCH" });
});

test("known browser roots classify their owned memory separately from other descendants", { skip: process.platform === "win32" }, async t => {
  const worker = spawn(process.execPath, ["-e", "globalThis.bytes=Buffer.alloc(32*1024*1024,172);process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "inherit"] });
  const closed = once(worker, "close");
  t.after(async () => { if (worker.exitCode === null) worker.kill(); await closed; });
  await once(worker.stdout!, "data");
  // 분류 계약만 검사한다. 실제 benchmark의 browser PID는 Chromium SystemInfo 응답에서 온다.
  const sampler = await PhaseMemorySampler.start([worker.pid!]); t.after(() => sampler.stop());
  const result = await sampler.stop();
  assert.equal(result.complete, true);
  assert.ok(result.samples.every(sample => sample.chromiumRssBytes >= 32*1024*1024));
});

test("invalid observer inputs reject instead of reporting a complete empty memory sample", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(PhaseMemorySampler.start([-1]), /Memory sampler failed/);
});

test("phase summary keeps a simultaneous peak and spills raw samples without retaining their array", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-phase-memory-summary-")), previous = process.argv[2];
  process.argv[2] = path.join(directory, "report.json");
  t.after(async () => { if (previous === undefined) delete process.argv[2]; else process.argv[2] = previous; await rm(directory, {recursive:true,force:true}); });
  const row = (afterStartMs: number, nodeRssBytes: number, chromiumRssBytes: number, otherOwnedRssBytes: number) => ({
    afterStartMs, nodeRssBytes, chromiumRssBytes, otherOwnedRssBytes, sumRssBytes: nodeRssBytes+chromiumRssBytes+otherOwnedRssBytes, scanMs:1, pids:[process.pid] });
  const samples = [row(0,100,300,200),row(50,400,150,10),row(100,200,100,0)];
  const input = {complete:true,rootPid:process.pid,observerPid:999999,intervalMs:50,samples,errors:[],scope:"Fixture samples"};
  const result = await summarizePhaseMemory(input,"fixture");
  assert.equal(result.sampledPeak.sumRssBytes,600);
  assert.deepEqual(result.componentMaxBytes,{node:400,chromium:300,otherOwned:200});
  assert.equal("samples" in result,false); assert.equal(result.sampleCount,3);
  assert.deepEqual(JSON.parse(await readFile(result.rawSamplesFile,"utf8")),input);
  await assert.rejects(summarizePhaseMemory({...input,complete:false},"incomplete"));
});
