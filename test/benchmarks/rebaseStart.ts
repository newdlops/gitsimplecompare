// UI의 실행 버튼이 호출하는 실제 RebaseService.start를 깨끗한 임시 저장소에서 대조한다.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mock } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit, runGitWithInput } from "../../src/git/gitExec";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { captureRebaseCheckout } from "../../src/git/rebasePlanSafety";
import { RebaseService, type RebaseItem } from "../../src/git/rebaseService";

/** 외부 저장소를 받지 않고 고정된 파일·이력과 서로 독립적인 6개 변경을 fast-import한다. */
async function fixture(directory: string) {
  const root = path.join(directory, "repo"), marksFile = path.join(directory, "marks");
  await mkdir(root); await mkdir(path.join(directory, "hooks"));
  await runGit(["-c", "init.templateDir=", "init", "-q", "--initial-branch=main"], root);
  for (const [key, value] of Object.entries({ "user.name": "Rebase Fixture", "user.email": "rebase@example.invalid",
    "core.fsmonitor": "false", "core.hooksPath": path.join(directory, "hooks"), "commit.gpgSign": "false" }))
    await runGit(["config", key, value], root);
  const files = 1000, commits = 1000;
  let mark = 1;
  const data = ["blob", "mark :1", "data 8", "fixture\n"];
  /** 고정된 부모·메시지·변경을 가진 fast-import commit 한 건을 추가한다. */
  const commit = (ref: string, parent: number | undefined, message: string, changes: string[] = []) => {
    const current = ++mark;
    data.push(`commit refs/heads/${ref}`, `mark :${current}`, "committer Rebase Fixture <rebase@example.invalid> 1700000000 +0000",
      `data ${Buffer.byteLength(message)}`, message, ...(parent ? [`from :${parent}`] : []), ...changes, "");
    return current;
  };
  let base = commit("main", undefined, "base", Array.from({ length: files }, (_, index) => `M 100644 :1 file-${index}.txt`));
  for (let index = 1; index < commits; index++) base = commit("main", base, `main ${index}`);
  let tip = base;
  const topics: number[] = [];
  for (let index = 0; index < 6; index++) {
    tip = commit("topic", tip, `topic ${index}`, [`M 100644 :1 topic-${index}.txt`]); topics.push(tip);
  }
  await runGitWithInput(["fast-import", "--quiet", `--export-marks=${marksFile}`], root, data.join("\n") + "\n");
  const ids = new Map((await readFile(marksFile, "utf8")).trim().split("\n").map(line => {
    const [mark, hash] = line.split(" "); return [Number(mark.slice(1)), hash];
  }));
  await runGit(["reset", "--hard", "main"], root);
  return { root, files, commits, base: ids.get(base)!, tip: ids.get(tip)!, topics: topics.map(mark => ids.get(mark)!) };
}

/** 시간 구간에는 실제 Start와 helper를 포함하며 준비·결과 검증·fixture 비용은 제외한다. */
async function measure(f: Awaited<ReturnType<typeof fixture>>, mode: "messages-and-squash" | "reorder", sample: number) {
  await runGit(["switch", "-qC", `sample-${mode}-${sample}`, f.tip], f.root);
  const expectedCheckout = await captureRebaseCheckout(f.root);
  const tree = (await runGit(["rev-parse", "HEAD^{tree}"], f.root)).trim();
  const order = mode === "reorder" ? [5, 0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5];
  const actions: RebaseItem["action"][] = ["reword", "fixup", "squash", "pick", "reword", "fixup"];
  const messages = ["rewritten start", undefined, "combined", undefined, "rewritten final", undefined];
  const items: RebaseItem[] = order.map(index => ({ hash: f.topics[index],
    action: mode === "reorder" ? "pick" : actions[index], message: mode === "reorder" ? undefined : messages[index] }));
  const calls: string[][] = [];
  const spawn = childProcess.spawn;
  mock.method(childProcess, "spawn", (...args: any[]) => {
    if (path.basename(args[0]) === "git") calls.push([...args[1]]);
    return (spawn as Function)(...args);
  });
  const rss = process.memoryUsage.rss(), cpu = process.cpuUsage(), started = performance.now();
  let result;
  try { result = await new RebaseService(f.root).start(f.base, false, items, path.resolve("media/rebase/rebaseEditor.js"), undefined, expectedCheckout); }
  finally { mock.restoreAll(); }
  const elapsedMs = Math.round(performance.now() - started), used = process.cpuUsage(cpu), rssDeltaMiB = Math.round((process.memoryUsage.rss() - rss) / 1024 / 1024);
  assert.equal(result.status, "completed", result.message);
  assert.equal(gitProcesses.isBusy(f.root), false, "Start must release its owned processes before returning");
  assert.equal((await runGit(["rev-parse", "HEAD^{tree}"], f.root)).trim(), tree);
  assert.equal((await runGit(["status", "--porcelain=v1"], f.root)).trim(), "");
  const subjects = (await runGit(["log", "--reverse", "--format=%s", `${f.base}..HEAD`], f.root)).trim().split("\n");
  assert.deepEqual(subjects, mode === "reorder" ? order.map(index => `topic ${index}`) : ["combined", "topic 3", "rewritten final"]);
  const gitDir = expectedCheckout.gitDir;
  await assert.rejects(readFile(path.join(gitDir, "gitsimplecompare/rebase-message-queue-state.json")), { code: "ENOENT" });
  return { mode, sample, elapsedMs, directGitCalls: calls.length,
    directoryReads: calls.filter(args => (args.includes("--absolute-git-dir") || args.includes("--git-dir")) && !args.includes("--symbolic-full-name")).length,
    statePathReads: calls.filter(args => args.includes("--git-path")).length,
    checkoutGuards: calls.filter(args => args.includes("--symbolic-full-name")).length,
    nodeCpuMs: Math.round((used.user + used.system) / 1000), rssDeltaMiB,
    exactTreeAndMessages: true, cleanWorkingTree: true, messageQueueRemoved: true, ownedProcessesIdle: true };
}

/** 두 가지 실제 재작성 계획을 번갈아 세 번씩 실행하고 원본 표본과 실행 source를 남긴다. */
async function main() {
  const output = process.argv[2]; assert.ok(output, "Output JSON path is required");
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-rebase-start-benchmark-"));
  try {
    const f = await fixture(directory), results = [];
    for (let sample = 1; sample <= 3; sample++) for (const mode of ["messages-and-squash", "reorder"] as const) {
      console.error(`Measuring ${mode} ${sample}...`); results.push(await measure(f, mode, sample));
    }
    const report = { source: JSON.parse(process.env.GSC_BENCH_SOURCE!), fixture: { files: f.files, commits: f.commits, todo: 6 },
      cpuScope: "benchmark Node process only; Git and editor helper CPU excluded", graphIncluded: false, results };
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
