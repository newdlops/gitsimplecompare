// 동일한 fixture를 변경 전·후의 실제 서비스로 읽는다. 외부 경계 모형은 결과에 명시한다.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { buildWorkingContentWithoutStaged, buildWorkingContentWithoutStagedView } from "@source/git/unstagedView";
import { DiffHunkService } from "@source/git/diffHunkService";
import { countUntrackedLines, clearUntrackedStatsCache } from "@source/git/untrackedStats";
import { StashService } from "@source/git/stashService";
import { StaleBranchService } from "@source/git/staleBranchService";
import { readUnreachableCommitRecords } from "@source/git/unreachableCommitService";
import { readReflogEntries } from "@source/git/reflogService";
import { readWorkingContentWithoutStaged } from "@source/git/fileContentReader";
import { setGitExecutionObserver } from "@source/git/gitExecutionDiagnostics";
import { GitService } from "@source/git/gitService";
import { refreshStashes, loadStashFilesForView } from "@source/commands/stash";

const root = process.argv[3], name = process.argv[2];
const fixture = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8"));
const counts = { stat: 0, open: 0, readFile: 0, fileRead: 0, bytes: 0 };
const commands: Record<string, number> = {};

/** 임시 fixture의 파일만 계측한다. 제품 데이터나 Git 실행의 결과는 변경하지 않는다. */
function observeFiles() {
  const original = { stat: fs.stat, open: fs.open, readFile: fs.readFile };
  const tracked = (file: unknown) => typeof file === "string" && file.startsWith(root + "/");
  fs.stat = (async (...args: any[]) => {
    if (tracked(args[0])) counts.stat++;
    return (original.stat as any)(...args);
  }) as typeof fs.stat;
  fs.readFile = (async (...args: any[]) => {
    const value = await (original.readFile as any)(...args);
    if (tracked(args[0])) { counts.readFile++; counts.bytes += Buffer.byteLength(value); }
    return value;
  }) as typeof fs.readFile;
  fs.open = (async (...args: any[]) => {
    const handle = await (original.open as any)(...args);
    if (tracked(args[0])) {
      counts.open++;
      const read = handle.read.bind(handle);
      handle.read = async (...parameters: any[]) => {
        const result = await read(...parameters); counts.fileRead++; counts.bytes += result.bytesRead; return result;
      };
    }
    return handle;
  }) as typeof fs.open;
  return () => { Object.assign(fs, original); };
}

/** 내용이 동등한 결과의 digest를 반환한다. 큰 결과를 IPC와 측정 보고서에 복사하지 않는다. */
function digest(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return createHash("sha256").update(canonical).digest("hex");
}

/** 정렬한 표본의 중앙값을 구한다. 준비·워밍업 비용은 별도로 제외한다. */
function median(values: number[]): number { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]; }

/** setup 뒤부터 Node CPU·RSS·파일 I/O·Git 프로세스 수를 함께 관찰한다. 자식 Git RSS는 포함하지 않는다. */
async function measure(run: () => Promise<unknown> | unknown) {
  const restore = observeFiles(), release = setGitExecutionObserver(event => {
    commands[event.command] = (commands[event.command] ?? 0) + 1;
  });
  global.gc?.();
  const rssStart = process.memoryUsage().rss, cpuStart = process.cpuUsage(), started = performance.now();
  let peakRss = rssStart;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 2);
  try {
    const result = await run(), elapsedMs = performance.now() - started, cpu = process.cpuUsage(cpuStart);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    return { elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, rssStartMiB: rssStart / 2 ** 20,
      sampledPeakRssMiB: peakRss / 2 ** 20, maxRssMiB: process.resourceUsage().maxRSS / 1024,
      io: counts, commands, result };
  } finally { clearInterval(sampler); restore(); release(); }
}

/** CPU 사례는 동일 입력을 두 번 워밍업하고 15회 측정한다. 매번 결과가 같아야 한다. */
async function lcsCase() {
  const lines = Array.from({ length: 1800 }, (_, i) => `line ${i}`), head = lines.join("\n") + "\n";
  const changed = [...lines];
  const index = name.endsWith("start") ? 0 : name.endsWith("middle") ? 900 : 1790;
  if (!name.endsWith("equal")) changed[index] = "modified line";
  const working = changed.join("\n") + "\n", textOnly = name.includes("text");
  const execute = () => textOnly ? buildWorkingContentWithoutStaged(head, head, working)
    : buildWorkingContentWithoutStagedView(head, head, working);
  execute(); execute();
  return measure(() => {
    const samples: number[] = []; let value: unknown;
    for (let i = 0; i < 15; i++) { const start = performance.now(); value = execute(); samples.push(performance.now() - start); }
    return { innerMedianMs: median(samples), samplesMs: samples, digest: digest(value), lines: lines.length };
  });
}

/** 실제 변경 diff의 전체 목록과 본문 보관량을 읽는다. 지연 항목은 별도로 세어 동등한 완료 작업으로 오해하지 않는다. */
async function diffCase() {
  const repo = join(root, name === "synthetic-large" || name === "synthetic-expanded" ? "large" : name === "synthetic-small" ? "small" : "tracked");
  return measure(async () => {
    const service = new DiffHunkService(repo);
    let files = await service.getWorkingDiff();
    if (name === "synthetic-expanded") {
      for (const file of [...files]) {
        if (!(file as any).deferred) continue;
        const detailed = await ((service as any).getDeferredFileWorkingDiff
          ? (service as any).getDeferredFileWorkingDiff(file.path) : service.getFileWorkingDiff(file.path));
        files = files.flatMap(item => item.path === file.path ? detailed : [item]);
      }
    }
    return { files: files.length, deferred: files.filter((file: any) => file.deferred).length,
      hunkCharacters: files.reduce((sum: number, file: any) => sum + file.hunks.reduce((n: number, hunk: any) => n + hunk.text.length, 0), 0),
      digest: digest(files), pathsDigest: digest(files.map((file: any) => file.path).sort()) };
  });
}

/** index가 같은 fixture의 바이너리 선택만 바꾼다. 각 worker 뒤에는 runner가 fixture를 복원한다. */
async function binaryCase() {
  const repo = join(root, "binary"), service = new DiffHunkService(repo), files = await service.getWorkingDiff();
  const selections = files.map((file: any) => ({ stage: "unstaged", path: file.path, binary: true, hunkIds: [] }));
  return measure(async () => {
    if (name === "binary-stage") await service.stageSelections(files, selections);
    else if (name === "binary-discard") await service.discardSelections(files, selections);
    else await service.commit(files, selections, "benchmark selected files");
    // 벽시계 측정은 Git 상태 재확인 이전까지 반환한다. runner는 측정 밖에서 byte 결과를 검증한다.
    return { selectedFiles: selections.length };
  });
}

/** 같은 불변 stash의 다른 파일을 차례로 연다. 전체 hash를 사용하므로 선택 검증 비용은 비교에서 제외한다. */
async function stashFilesCase() {
  const repo = join(root, "stash"), service = new StashService(repo);
  return measure(async () => {
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await service.fileComparison(fixture.stashHash, { path: `new-${i}.txt`, status: "A" }));
    return { files: results.length, digest: digest(results) };
  });
}

/** 같은 파일의 동시 소비자가 각각 독립적인 결과를 얻는지 확인한다. 캐시는 매 worker에서 cold다. */
async function statsCase() {
  const repo = join(root, "small"); clearUntrackedStatsCache();
  return measure(async () => {
    const values = [];
    if (name === "stats-sequential") {
      for (let i = 0; i < 100; i++) values.push(await countUntrackedLines(repo, "large-stat.txt"));
    } else values.push(...await Promise.all(Array.from({ length: 8 }, () => countUntrackedLines(repo, "large-stat.txt"))));
    assert.equal(new Set(values).size, 1);
    return { consumers: values.length, digest: digest(values), lines: values[0] };
  });
}

/** 표시용 명령의 실제 Git 목록 조회를 비교한다. 현재 구현은 첫 50개만 표시하며 이후 조회는 사용자 요청이다. */
async function stashListCase() {
  const service = new GitService(join(root, "stash-list")); let shown: any[] = [], pagination: unknown;
  const deps: any = { registry: { get: () => service }, changesView: { getActiveRepo: () => service.repoRoot,
    setStashes: (items: any[], page?: unknown) => { if (items) shown = items; pagination = page; } } };
  return measure(async () => {
    await refreshStashes(deps);
    if (name === "stash-list-expanded") {
      while ((pagination as any)?.hasMore) await refreshStashes(deps, true, service.repoRoot);
    }
    return { shown: shown.length, pagination, payloadBytes: Buffer.byteLength(JSON.stringify(shown)),
      first50Digest: digest(shown.slice(0, 50).map(item => [item.ref, item.hash, item.message])),
      allDigest: digest(shown.map(item => [item.ref, item.hash, item.message])) };
  });
}

/** 번호가 이동한 뒤 표시 갱신과 같은 stash의 재열기를 잰다. 사전 열기·새 stash 생성은 측정 밖이다. */
async function stashReorderCase() {
  const repo = join(root, "stash"), service = new GitService(repo), [entry] = await service.listStashes();
  const deps: any = { registry: { get: () => service }, changesView: { getActiveRepo: () => repo, setStashes() {} } };
  const selection = { repoRoot: repo, ref: entry.ref, hash: entry.hash };
  await loadStashFilesForView(deps, selection);
  await fs.writeFile(join(repo, "base.txt"), "newer change\n");
  execFileSync("git", ["stash", "push", "-qm", "newer change"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  return measure(async () => {
    await refreshStashes(deps);
    const result = await loadStashFilesForView(deps, selection);
    assert.equal(result.ref, "stash@{1}");
    return { files: result.files.length, digest: digest(result) };
  });
}

/** 실제 HEAD/index/working 읽기 전체를 잰다. Git 프로세스 수는 같아 병렬화의 단독 효과로 해석하지 않는다. */
async function contentCase() {
  return measure(async () => {
    const result = await readWorkingContentWithoutStaged(join(root, "tracked"), "tracked.txt", { maxBytes: 5 * 1024 * 1024 });
    return { characters: result.length, digest: digest(result) };
  });
}

/** 실제 fsck가 찾는 동일한 2,400개 객체를 최신 80개로 줄인다. 전체 결과 identity도 검사한다. */
async function recoveryCase() {
  return measure(async () => {
    const result = name === "recovery-panel" ? await readReflogEntries(join(root, "recovery"), { includeUnreachable: true })
      : await readUnreachableCommitRecords(join(root, "recovery"), 80);
    assert.ok(result.length >= 80);
    return { returned: result.length, digest: digest(result) };
  });
}

/** 외부 접속 대신 정확히 같은 원격 지연을 주입한다. 실제 인터넷 성능 측정과 구별한다. */
async function remoteQueueCase() {
  const delays = [120, 10, 10, 10, 10, 10, 10, 120]; let active = 0, peak = 0;
  const service = new StaleBranchService("/fixture/remote-queue", async (args: string[]) => {
    if (args[0] === "remote") return delays.map((_, i) => `r${i}`).join("\n");
    if (args[0] === "config") return "fixed remote configuration";
    if (args[0] === "ls-remote") {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, delays[Number(args.at(-1)!.slice(1))])); active--;
      return "a".repeat(40) + "\trefs/heads/main\n";
    }
    return "";
  });
  return measure(async () => { const result = await service.inspect(); return { peakConcurrency: peak, digest: digest(result), model: "injected delays, not a network measurement" }; });
}

/** 브랜치·worktree Map의 변환 비용만 비교한다. Git 대기 시간을 0으로 둔 합성 경계다. */
async function branchMapsCase() {
  const count = 5000, hash = "a".repeat(40), names = Array.from({ length: count }, (_, i) => `branch-${String(i).padStart(5, "0")}`);
  const locals = names.map(name => `refs/heads/${name}\0${hash}\0\0 \0subject`).join("\n");
  const worktrees = name === "worktree-map" ? names.slice(0, 300).map((branch, i) => `worktree /fixture/${i}\nHEAD ${hash}\nbranch refs/heads/${branch}\n`).join("\n") : "";
  const service = new StaleBranchService("/fixture/branch-maps", async (args: string[]) => {
    if (args[0] === "remote") return "origin";
    if (args[0] === "config") return "fixed";
    if (args[0] === "ls-remote") return "";
    if (args[0] === "worktree") return worktrees;
    if (args[0] === "for-each-ref") return args.includes("--merged=HEAD") ? names.map(name => `refs/heads/${name}`).join("\n") : locals;
    if (args[0] === "rev-parse") return hash;
    return "";
  });
  const inspection = name === "selection-map" ? await service.inspect() : undefined;
  return measure(async () => {
    const result = inspection ? await service.cleanup(inspection, names) : await service.inspect();
    return { branches: count, worktrees: name === "worktree-map" ? 300 : 0, digest: digest(result), model: "injected Git outputs" };
  });
}

/** 현재 프로세스에 지정한 단일 사례만 실행해 RSS high-water가 다른 사례로 오염되지 않게 한다. */
async function run() {
  if (name.startsWith("lcs-")) return lcsCase();
  if (["synthetic-large", "synthetic-expanded", "synthetic-small", "tracked-diff"].includes(name)) return diffCase();
  if (name.startsWith("binary-")) return binaryCase();
  if (name === "stash-files") return stashFilesCase();
  if (name === "stats-shared" || name === "stats-sequential") return statsCase();
  if (name === "stash-list" || name === "stash-list-expanded") return stashListCase();
  if (name === "stash-reorder") return stashReorderCase();
  if (name === "working-content") return contentCase();
  if (name === "recovery" || name === "recovery-panel") return recoveryCase();
  if (name === "remote-queue") return remoteQueueCase();
  if (name === "worktree-map" || name === "selection-map") return branchMapsCase();
  throw new Error(`Unknown benchmark case: ${name}`);
}

run().then(result => process.stdout.write(JSON.stringify(result) + "\n"), error => { console.error(error); process.exitCode = 1; });
