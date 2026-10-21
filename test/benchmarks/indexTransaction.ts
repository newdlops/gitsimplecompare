// 실제 Git index의 원자 게시 비용과 Node 메모리를 측정한다. 전체 PR/프로세스 트리 자원과 구분한다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withConflictIndexTransaction } from "../../src/git/conflictIndexTransaction";
import { runGit, runGitWithInput } from "../../src/git/gitExec";
import { gitProcesses } from "../../src/git/gitProcessRegistry";

/** 측정 밖에서 스트리밍 hash를 계산해 검증 자체가 큰 index Buffer를 붙잡지 않게 한다. */
async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** 작업 파일을 만들지 않고 같은 blob을 가리키는 많은 정상 stage-0 entry를 Native Git으로 만든다. */
async function fixture(directory: string, entries: number) {
  const root = path.join(directory, "repository"); await mkdir(root);
  await runGit(["-c", "init.templateDir=", "init", "-q", "--initial-branch=main"], root);
  for (const [key, value] of Object.entries({ "user.name": "Index Fixture", "user.email": "index@example.invalid",
    "core.fsmonitor": "false", "core.splitIndex": "false", "commit.gpgSign": "false", "core.hooksPath": directory })) {
    await runGit(["config", key, value], root);
  }
  await runGit(["commit", "--allow-empty", "-qm", "base"], root);
  const blob = (await runGitWithInput(["hash-object", "-w", "--stdin"], root, "fixture\n")).trim();
  const input = Array.from({ length: entries }, (_, index) =>
    `100644 ${blob}\ttracked-${String(index).padStart(8, "0")}-${"x".repeat(170)}.txt\0`).join("");
  await runGitWithInput(["update-index", "-z", "--index-info"], root, input);
  const tree = (await runGit(["write-tree"], root)).trim(), index = path.join(root, ".git/index");
  return { root, index, tree, indexBytes: (await stat(index)).size, sha256: await digest(index) };
}

/** 같은 1ms 간격으로 Node만 관측한다. Git/OS 전체 CPU/RSS 또는 완전한 순간 peak 계측은 아니다. */
async function measure(f: Awaited<ReturnType<typeof fixture>>) {
  assert.ok(global.gc, "Use the runner's --expose-gc option"); global.gc();
  const initial = process.memoryUsage(), peak = { ...initial }, cpu = process.cpuUsage(), started = performance.now();
  /** 이미 만든 fixture와 실행 중 index Buffer 증가분을 구분하고 관측한 최댓값을 남긴다. */
  const sample = () => {
    const memory = process.memoryUsage();
    for (const key of ["rss", "external", "arrayBuffers"] as const) peak[key] = Math.max(peak[key], memory[key]);
  };
  const timer = setInterval(sample, 1);
  try { await withConflictIndexTransaction(f.root, true, async () => undefined); sample(); }
  finally { clearInterval(timer); }
  const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu);
  assert.equal(await digest(f.index), f.sha256, "Publication must preserve every index byte");
  assert.equal((await runGit(["write-tree"], f.root)).trim(), f.tree, "Native Git must accept the published index and identical tree");
  assert.equal(gitProcesses.isBusy(f.root), false);
  return { elapsedMs, nodeCpuMs: (used.user + used.system) / 1000,
    sampledNodeRssGrowthBytes: peak.rss - initial.rss, sampledExternalGrowthBytes: peak.external - initial.external,
    sampledArrayBufferGrowthBytes: peak.arrayBuffers - initial.arrayBuffers, exactIndexBytes: true, nativeTreeExact: true };
}

/** 직접 만든 임시 저장소만 사용하고 같은 source의 반복값도 각각 저장하며 종료 시 모두 해제한다. */
async function main(): Promise<void> {
  const entries = Number(process.env.GSC_BENCH_INDEX_ENTRIES || 100000), repeats = Number(process.env.GSC_BENCH_REPEATS || 3);
  assert.ok(Number.isSafeInteger(entries) && entries >= 1000 && entries <= 300000);
  assert.ok(Number.isSafeInteger(repeats) && repeats >= 1 && repeats <= 10);
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-index-publish-benchmark-"));
  try {
    const f = await fixture(directory, entries), samples = [];
    for (let index = 0; index < repeats; index++) samples.push(await measure(f));
    const result = { version: 1, source: JSON.parse(process.env.GSC_BENCH_SOURCE || "null"),
      scope: "Native-valid index publication only; sampled benchmark Node resources, excluding Git children, Chromium and OS",
      fixture: { entries, indexBytes: f.indexBytes, tree: f.tree, sha256: f.sha256 }, sampleIntervalMs: 1, samples };
    const output = process.argv[2];
    if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } finally { await gitProcesses.dispose(); await rm(directory, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
