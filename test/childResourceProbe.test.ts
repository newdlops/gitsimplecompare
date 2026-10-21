import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadChildResourceProbe } from "./helpers/childResourceProbe";

/** 벽시계 스케줄링 지연과 구분해 실제 프로세스 CPU를 최소 지정 시간만큼 소비한다. */
const burn = (milliseconds: number) => `const start=process.cpuUsage();while(true){let x=0;for(let i=0;i<10000;i++)x=Math.imul(x+1,31);const used=process.cpuUsage(start);if(used.user+used.system>=${milliseconds * 1000})break;}`;

test("child counters include short waited children and their waited descendants but exclude parent CPU", { skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-child-counters-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const capture = await loadChildResourceProbe(directory), before = capture();
  const parentStart = process.cpuUsage();
  while (process.cpuUsage(parentStart).user + process.cpuUsage(parentStart).system < 30_000) { Math.sqrt(Math.random()); }
  assert.deepEqual(capture(), before, "Parent work must not become waited-child work");
  const source = `const probe=require(process.argv[1]);require('node:child_process').execFileSync(process.execPath,['-e',${JSON.stringify(burn(80))}]);const child=probe.capture(),self=process.cpuUsage();console.log(JSON.stringify({selfMs:(self.user+self.system)/1000,childMs:child.userCpuMs+child.systemCpuMs}));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", source, path.join(directory, "child-resource-probe.node")]);
  const after = capture(), reported = JSON.parse(stdout) as { selfMs: number; childMs: number };
  const measured = after.userCpuMs + after.systemCpuMs - before.userCpuMs - before.systemCpuMs;
  assert.ok(reported.childMs >= 80, "The short grandchild must have consumed real CPU");
  assert.ok(measured >= reported.selfMs + reported.childMs - 1, "The OS must account for both waited generations");
  for (const key of Object.keys(before) as Array<keyof typeof before>) assert.ok(Number.isFinite(after[key]) && after[key] >= before[key]);
});

test("a live child is excluded until it terminates and is waited", { skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-live-child-counters-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const capture = await loadChildResourceProbe(directory), before = capture();
  const child = spawn(process.execPath, ["-e", `${burn(25)};process.stdout.write('ready');setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await once(child.stdout!, "data");
  assert.deepEqual(capture(), before);
  const closed = once(child, "close"); child.kill("SIGTERM"); await closed;
  const after = capture();
  assert.ok(after.userCpuMs + after.systemCpuMs - before.userCpuMs - before.systemCpuMs >= 25);
});
