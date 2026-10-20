// UI의 실행 버튼이 호출하는 실제 RebaseService.start를 깨끗한 임시 저장소에서 대조한다.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mock } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit, runGitWithInput, setGitExecutableResolver } from "../../src/git/gitExec";
import { gitCommandPolicy } from "../../src/git/gitCommandPolicy";
import { gitProcesses } from "../../src/git/gitProcessRegistry";
import { captureRebaseCheckout } from "../../src/git/rebasePlanSafety";
import { RebaseService, type RebaseItem } from "../../src/git/rebaseService";

const PROFILE = process.env.GSC_BENCH_REBASE_PROFILE === "1";

/** Trace2의 editor child_start/exit를 같은 Git session과 child ID로 묶어 실제 헬퍼 대기를 읽는다. */
async function editorProfile(file: string) {
  const events = (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const starts = new Map<string, any>(), editors: { kind: string; elapsedMs: number; argv: string[] }[] = [];
  for (const event of events) {
    const key = `${event.sid}:${event.child_id}`;
    if (event.event === "child_start" && event.child_class === "editor") starts.set(key, event);
    if (event.event === "child_exit" && starts.has(key)) {
      const entry = starts.get(key), argv = entry.argv as string[];
      editors.push({ kind: argv.some(value => value.includes("git-rebase-todo")) ? "sequence" : "message", elapsedMs: Math.round(event.t_rel * 1000), argv });
    }
  }
  return { events: events.length, editors, editorWallMs: editors.reduce((sum, editor) => sum + editor.elapsedMs, 0),
    nodeEditors: editors.filter(editor => editor.argv.some(arg => arg.includes("rebaseEditor.js") && / (?:seq|msg)$/.test(arg))).length,
    nativeMessageEditors: editors.filter(editor => editor.argv.some(arg => arg.includes("rebase-message-editor.sh") && / msg$/.test(arg))).length,
    copySequenceEditors: editors.filter(editor => editor.argv.some(arg => arg.startsWith("gsc_seq()"))).length };
}

/** macOS time의 누적 자식 CPU와 단일 명령의 max RSS를 읽는다. 동시 프로세스 RSS 합계로 해석하지 않는다. */
async function nativeProfile(directory: string, calls: { args: string[]; pid?: number; elapsedMs?: number }[]) {
  const timings = [];
  for (const file of (await readdir(directory)).filter(file => file.endsWith(".time"))) {
    const pid = Number(file.replace(/\.time$/, "")), call = calls.find(call => call.pid === pid);
    assert.ok(call, "Every native timing must belong to this measured Start");
    const text = await readFile(path.join(directory, file), "utf8");
    const user = Number(/^user\s+([\d.]+)$/m.exec(text)?.[1]), system = Number(/^sys\s+([\d.]+)$/m.exec(text)?.[1]);
    const maxRssBytes = Number(/^\s*(\d+)\s+maximum resident set size$/m.exec(text)?.[1]);
    assert.ok([user, system, maxRssBytes].every(Number.isFinite));
    timings.push({ command: gitCommandPolicy(call.args).command, pid, nativeCpuMs: Math.round((user + system) * 1000), maxRssBytes, elapsedMs: call.elapsedMs });
  }
  assert.equal(timings.length, calls.length, "All host Git processes must have native timings");
  return { gitAndDescendantCpuMs: timings.reduce((sum, timing) => sum + timing.nativeCpuMs, 0),
    maxCommandRssBytes: Math.max(...timings.map(timing => timing.maxRssBytes)), calls: timings };
}

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
  const calls: string[][] = [], callTimings: { args: string[]; pid?: number; elapsedMs?: number }[] = [];
  const profileDirectory = path.join(path.dirname(f.root), `native-${mode}-${sample}`);
  const traceFile = path.join(path.dirname(f.root), `trace-${mode}-${sample}.jsonl`);
  let resetExecutable: (() => void) | undefined;
  const oldTrace = process.env.GIT_TRACE2_EVENT, oldDirectory = process.env.GSC_REBASE_CPU_DIRECTORY;
  if (PROFILE) {
    assert.equal(process.platform, "darwin", "Native CPU profiling currently requires macOS /usr/bin/time");
    await mkdir(profileDirectory);
    const wrapperDirectory = path.join(profileDirectory, "wrapper"); await mkdir(wrapperDirectory);
    const wrapper = path.join(wrapperDirectory, "git");
    await writeFile(wrapper, '#!/bin/sh\nexec /usr/bin/time -lp -o "$GSC_REBASE_CPU_DIRECTORY/$$.time" git "$@"\n', { mode: 0o755 });
    // 새 script 실행 파일의 첫 OS 검증 비용은 실제 Start가 아니므로 공통 warmup에서 제외한다.
    const warmup = path.join(profileDirectory, "warmup"); await mkdir(warmup);
    childProcess.execFileSync(wrapper, ["--version"], { stdio: "ignore", env: { ...process.env, GSC_REBASE_CPU_DIRECTORY: warmup } });
    process.env.GIT_TRACE2_EVENT = traceFile; process.env.GSC_REBASE_CPU_DIRECTORY = profileDirectory;
    resetExecutable = setGitExecutableResolver(() => wrapper);
  }
  const spawn = childProcess.spawn;
  mock.method(childProcess, "spawn", (...args: any[]) => {
    const child = (spawn as Function)(...args);
    if (path.basename(args[0]) === "git") {
      const call = { args: [...args[1]], pid: child.pid, elapsedMs: undefined as number | undefined }, started = performance.now();
      calls.push(call.args); callTimings.push(call); child.once("close", () => { call.elapsedMs = Math.round(performance.now() - started); });
    }
    return child;
  });
  const rss = process.memoryUsage.rss(), cpu = process.cpuUsage(), started = performance.now();
  let result;
  try { result = await new RebaseService(f.root, { nativeEditors: true }).start(f.base, false, items, path.resolve("media/rebase/rebaseEditor.js"), undefined, expectedCheckout); }
  finally {
    mock.restoreAll(); resetExecutable?.();
    if (oldTrace === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = oldTrace;
    if (oldDirectory === undefined) delete process.env.GSC_REBASE_CPU_DIRECTORY; else process.env.GSC_REBASE_CPU_DIRECTORY = oldDirectory;
  }
  const elapsedMs = Math.round(performance.now() - started), used = process.cpuUsage(cpu), rssDeltaMiB = Math.round((process.memoryUsage.rss() - rss) / 1024 / 1024);
  assert.equal(result.status, "completed", result.message);
  assert.equal(gitProcesses.isBusy(f.root), false, "Start must release its owned processes before returning");
  assert.equal(calls.filter(args => args.includes("--symbolic-full-name")).length, 2, "Both fresh checkout guards must remain");
  assert.equal((await runGit(["rev-parse", "HEAD^{tree}"], f.root)).trim(), tree);
  assert.equal((await runGit(["status", "--porcelain=v1"], f.root)).trim(), "");
  const subjects = (await runGit(["log", "--reverse", "--format=%s", `${f.base}..HEAD`], f.root)).trim().split("\n");
  assert.deepEqual(subjects, mode === "reorder" ? order.map(index => `topic ${index}`) : ["combined", "topic 3", "rewritten final"]);
  const gitDir = expectedCheckout.gitDir;
  await assert.rejects(readFile(path.join(gitDir, "gitsimplecompare/rebase-message-queue-state.json")), { code: "ENOENT" });
  const trace = PROFILE ? await editorProfile(traceFile) : undefined;
  if (trace) {
    assert.equal(trace.editors.filter(editor => editor.kind === "sequence").length, 1);
    assert.equal(trace.editors.filter(editor => editor.kind === "message").length, mode === "reorder" ? 0 : 3);
  }
  return { mode, sample, elapsedMs, directGitCalls: calls.length,
    directoryReads: calls.filter(args => (args.includes("--absolute-git-dir") || args.includes("--git-dir")) && !args.includes("--symbolic-full-name")).length,
    statePathReads: calls.filter(args => args.includes("--git-path")).length,
    checkoutGuards: calls.filter(args => args.includes("--symbolic-full-name")).length,
    nodeCpuMs: Math.round((used.user + used.system) / 1000), rssDeltaMiB,
    exactTreeAndMessages: true, cleanWorkingTree: true, messageQueueRemoved: true, ownedProcessesIdle: true,
    ...(PROFILE ? { native: await nativeProfile(profileDirectory, callTimings), trace } : {}) };
}

/** 두 가지 실제 재작성 계획을 번갈아 세 번씩 실행하고 원본 표본과 실행 source를 남긴다. */
async function main() {
  const output = process.argv[2]; assert.ok(output, "Output JSON path is required");
  const directory = await mkdtemp(path.join(os.tmpdir(), "gsc-rebase-start-benchmark-"));
  try {
    const f = await fixture(directory), results = [];
    const samples = Number(process.env.GSC_BENCH_REBASE_SAMPLES || 3);
    assert.ok(Number.isSafeInteger(samples) && samples > 0 && samples <= 10);
    for (let sample = 1; sample <= samples; sample++) for (const mode of ["messages-and-squash", "reorder"] as const) {
      console.error(`Measuring ${mode} ${sample}...`); results.push(await measure(f, mode, sample));
    }
    const report = { source: JSON.parse(process.env.GSC_BENCH_SOURCE!), fixture: { files: f.files, commits: f.commits, todo: 6 },
      cpuScope: PROFILE ? "Node CPU is benchmark parent only. Native time profiles separately sum all host Git commands and their waited descendants; not whole-OS CPU. Max RSS is time-reported per-command maximum, not concurrent total. Trace2 editors are wall time." : "benchmark Node process only; Git and editor helper CPU excluded",
      profiling: PROFILE, graphIncluded: false, results };
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
