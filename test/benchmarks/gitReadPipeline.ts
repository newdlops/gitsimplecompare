// 자식 간 객체 ID transport·실제 packed 객체 조회·로컬 bare remote push를 나눠 측정한다.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as git from "../../src/git/gitExec";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { pushBranchCommits } from "../../src/git/sequentialPush";
import { setGitExecutionObserver } from "../../src/git/gitExecutionDiagnostics";

/** 지연을 넣지 않고 stdout/stdin의 실제 drain만 기다리는 두 역할의 실행 파일을 만든다. */
async function fixture(root: string) {
  const executable = path.join(root, "transport-git");
  await writeFile(executable, `#!${process.execPath}
const {once} = require('node:events');
(async () => {
 const count=Number(process.env.GSC_RECORDS), record='a'.repeat(40)+'\\n';
 if(process.argv[2]==='rev-list') {
  let remaining=count;
  while(remaining) { const size=Math.min(remaining,1598); if(!process.stdout.write(record.repeat(size))) await once(process.stdout,'drain'); remaining-=size; }
 } else if(process.argv[2]==='cat-file') {
  let seen=0;
  for await(const chunk of process.stdin) { let rows=0; for(const byte of chunk) if(byte===10) rows++; seen+=rows;
   if(!process.stdout.write('128\\n'.repeat(rows))) await once(process.stdout,'drain'); }
  if(seen!==count) throw new Error('Input count mismatch');
 } else throw new Error('Unexpected command');
})().catch(error=>{console.error(error);process.exitCode=1;});
`, { mode: 0o755 });
  return executable;
}

interface NativeFixture { root: string; remote: string; base: string; head: string; records: number; expectedBytes: number }

/** checkout 없이 100개 하위 디렉터리의 blob 10만 개를 pack에 만들어 Native 경로를 비교한다. */
async function nativeFixture(root: string): Promise<NativeFixture> {
  await mkdir(root);
  await git.runGit(["-c", "init.templateDir=", "init", "-q", "--object-format=sha1", "--initial-branch=main"], root);
  await git.runGitWithInput(["fast-import", "--quiet"], root,
    "commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ndata 4\nbase\n\n");
  const base = (await git.runGit(["rev-parse", "HEAD"], root)).trim(), remote = path.join(root, "origin.git");
  await git.runGit(["-c", "init.templateDir=", "init", "-q", "--bare", "--initial-branch=main", remote], root);
  await git.runGit(["remote", "add", "origin", remote], root);
  await git.runGit(["push", "-qu", "origin", "main"], root);
  const count = 100_000, commands: string[] = [];
  for (let index = 0; index < count; index++) {
    const content = `${index}:`.padEnd(128, "x");
    commands.push("blob", `mark :${index + 1}`, "data 128", content);
  }
  commands.push("commit refs/heads/main", "mark :100001", "committer Fixture <fixture@example.invalid> 1700000000 +0000", "data 7", "fixture", `from ${base}`);
  for (let index = 0; index < count; index++) commands.push(`M 100644 :${index + 1} group-${String(Math.floor(index / 1000)).padStart(3, "0")}/file-${String(index).padStart(6, "0")}.txt`);
  commands.push("", "commit refs/heads/main", "committer Fixture <fixture@example.invalid> 1700000000 +0000", "data 6", "second", "from :100001", "");
  await git.runGitWithInput(["fast-import", "--quiet"], root, commands.join("\n") + "\n");
  const head = (await git.runGit(["rev-parse", "HEAD"], root)).trim();
  const subtreeIds = (await git.runGit(["ls-tree", "-d", head], root)).trim().split("\n").map(line => {
    const match = /^040000 tree ([a-f0-9]{40})\t/.exec(line); assert.ok(match); return match[1];
  });
  assert.equal(subtreeIds.length, 100);
  const subtreeBytes = (await git.runGitWithInput(["cat-file", "--batch-check=%(objectsize)"], root, subtreeIds.join("\n") + "\n"))
    .trim().split("\n").reduce((sum, value) => sum + Number(value), 0);
  const treeBytes = Number((await git.runGit(["cat-file", "-s", `${head}^{tree}`], root)).trim()) + subtreeBytes;
  const commitBytes = Number((await git.runGit(["cat-file", "-s", head], root)).trim())
    + Number((await git.runGit(["cat-file", "-s", `${head}^`], root)).trim());
  await writeFile(path.join(root, "untracked.txt"), "keep local\n");
  return { root, remote, base, head, records: count + subtreeIds.length + 3, expectedBytes: count * 128 + treeBytes + commitBytes };
}

/** Source 목록의 전체 보관 여부만 다르고 같은 두 자식과 같은 metadata 소비를 사용한다. */
async function measure(root: string, executable: string, records: number, native?: NativeFixture) {
  (globalThis as any).gc?.();
  const options = { executable, readTimeoutMs: 60_000, env: { GSC_RECORDS: String(records) } };
  const method = ["runGit", "ReadPipeline"].join("");
  const pipeline = (git as Record<string, unknown>)[method] as undefined | ((...args: any[]) => Promise<void>);
  const source = ["rev-list", "--objects", "--no-object-names", native?.head ?? "HEAD", ...(native ? [`^${native.base}`] : [])];
  // 기준은 이전 production 인자를, 후보는 새 size estimator의 buffered 인자를 그대로 사용한다.
  const target = ["cat-file", "--batch-check=%(objectsize)", ...(pipeline ? ["--buffer"] : [])];
  let pending = "", total = 0, rows = 0, largestChunk = 0;
  /** chunk 경계 밖으로 숫자를 보관하지 않고 각 metadata 행을 검증해 합계와 행 수를 확인한다. */
  const consume = (chunk: Buffer) => {
    largestChunk = Math.max(largestChunk, chunk.length);
    const text = pending + chunk.toString("utf8"); let start = 0, end: number;
    while ((end = text.indexOf("\n", start)) >= 0) {
      const value = text.slice(start, end);
      assert.match(value, /^\d+$/); if (!native) assert.equal(value, "128");
      total += Number(value); rows++; start = end + 1;
    }
    pending = text.slice(start); assert.ok(pending.length <= 32);
  };
  const before = process.memoryUsage(), cpu = process.cpuUsage(), started = performance.now();
  let peak = before.rss, peakHeap = before.heapUsed, peakExternal = before.external;
  const sample = setInterval(() => { const usage = process.memoryUsage(); peak = Math.max(peak, usage.rss); peakHeap = Math.max(peakHeap, usage.heapUsed); peakExternal = Math.max(peakExternal, usage.external); }, 5);
  try {
    if (pipeline) await pipeline(source, target, root, consume, options);
    else {
      const input = await git.runGit(source, root, options);
      await git.runGitStreamWithInput(target, root, input, consume, options);
    }
  } finally { clearInterval(sample); }
  const elapsedMs = Math.round(performance.now() - started), used = process.cpuUsage(cpu);
  assert.equal(total, native?.expectedBytes ?? records * 128); assert.equal(rows, records); assert.equal(pending, "");
  assert.equal(gitProcesses.isBusy(root), false);
  return { fixture: native ? "native-git-packed-objects" : "synthetic-child-transport", records, inputBytes: records * 41, metadataSumBytes: total, mode: pipeline ? "bounded-pipeline" : "buffered-list",
    elapsedMs, nodeCpuMs: Math.round((used.user + used.system) / 1000),
    peakNodeRssDeltaMiB: Math.round((peak - before.rss) / 1048576), peakNodeHeapDeltaMiB: Math.round((peakHeap - before.heapUsed) / 1048576),
    peakNodeExternalDeltaMiB: Math.round((peakExternal - before.external) / 1048576), largestOutputChunk: largestChunk,
    exactRowsAndSum: true, ownedProcessesIdle: true };
}

/** 실제 기존 목적 브랜치로 두 신규 커밋을 전송하고 서비스 시간과 최종 원격 OID를 확인한다. */
async function measurePush(native: NativeFixture) {
  (globalThis as any).gc?.();
  const calls: { command: string; elapsedMs: number }[] = [], cpu = process.cpuUsage(), started = performance.now();
  const stop = setGitExecutionObserver(event => calls.push({ command: event.command, elapsedMs: event.elapsedMs }));
  let result;
  try { result = await pushBranchCommits(native.root, { branch: "main", head: native.head, remote: "origin", targetRef: "refs/heads/main" }, { requireCurrentBranch: true }); }
  finally { stop(); }
  const elapsedMs = Math.round(performance.now() - started), used = process.cpuUsage(cpu);
  assert.equal(result.strategy, "single"); assert.equal(result.completed, 1); assert.equal(result.estimatedBytes, native.expectedBytes);
  assert.equal((await git.runGit(["rev-parse", "main"], native.remote)).trim(), native.head);
  assert.equal((await git.runGit(["rev-parse", "HEAD"], native.root)).trim(), native.head);
  assert.equal(await readFile(path.join(native.root, "untracked.txt"), "utf8"), "keep local\n");
  assert.equal(gitProcesses.isBusy(native.root), false);
  return { fixture: "native-existing-branch-push", records: native.records, estimatedBytes: result.estimatedBytes, elapsedMs,
    nodeCpuMs: Math.round((used.user + used.system) / 1000), directGitCalls: calls.length,
    nativePushes: calls.filter(call => call.command === "push").length,
    nativePushElapsedMs: calls.filter(call => call.command === "push").reduce((sum, call) => sum + call.elapsedMs, 0),
    exactRemoteAndLocalHead: true, untrackedPreserved: true, ownedProcessesIdle: true };
}

/** 전송 형식과 Native 조회·push를 같은 프로세스에서 실행하되 fixture·GC 비용은 측정에서 분리한다. */
async function main() {
  const output = process.argv[2]; assert.ok(output, "Output JSON path is required");
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-read-pipeline-benchmark-"));
  try {
    const executable = await fixture(root), results: unknown[] = [];
    for (const records of [100_000, 2_000_000]) { console.error(`Measuring ${records} records...`); results.push(await measure(root, executable, records)); }
    const native = await nativeFixture(path.join(root, "native"));
    console.error(`Measuring ${native.records} Native Git objects...`);
    results.push(await measure(native.root, "git", native.records, native));
    console.error("Measuring existing-branch Native push...");
    results.push(await measurePush(native));
    const report = { source: JSON.parse(process.env.GSC_BENCH_SOURCE!),
      scope: "Synthetic object-ID transport, isolated Native packed-object queries, and a two-new-commit single push to an existing local bare branch. No artificial delay, GitHub or UI. CPU/RSS are benchmark Node only; child CPU/RSS excluded. Fixture creation and GC precede each measurement; the Native pack is warm from setup.", results };
    await writeFile(output, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2));
  } finally { await rm(root, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
