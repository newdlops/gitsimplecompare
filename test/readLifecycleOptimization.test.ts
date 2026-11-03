import assert from "node:assert/strict";
import test from "node:test";
import fileIO, { appendFile, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TopK } from "../src/utils/topK";
import { FileReadLimitError, readBoundedHandle } from "../src/utils/boundedFileRead";
import { countUntrackedLines, clearUntrackedStatsCache } from "../src/git/untrackedStats";
import { readWorkingContentWithoutStaged } from "../src/git/fileContentReader";
import { readUnreachableCommitRecords } from "../src/git/unreachableCommitService";
import { readReflogEntries } from "../src/git/reflogService";
import { gitCommandPolicy } from "../src/git/gitCommandPolicy";
import { runGit } from "../src/git/gitExec";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { setGitProcessPreparation } from "../src/git/gitProcessRunner";
import { StaleBranchService } from "../src/git/staleBranchService";
import { GraphReflogSender } from "../src/webview/graphReflog";
import { loadStashFilesForView, refreshStashes } from "../src/commands/stash";
import { GitService } from "../src/git/gitService";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 파일 I/O가 시작할 수 있는 한 event-loop 차례를 기다린다. */
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("bounded top K matches a complete sort including timestamp ties and out-of-order arrivals", () => {
  const values = Array.from({ length: 10000 }, (_, i) => ({ timestamp: i * 7919 % 113, hash: String(i).padStart(6, "0") }));
  const compare = (a: typeof values[number], b: typeof values[number]) => b.timestamp - a.timestamp || a.hash.localeCompare(b.hash);
  for (const limit of [0, 1, 80, 20000]) {
    const top = new TopK(limit, compare); for (const value of values) top.add(value);
    assert.deepEqual(top.values(), [...values].sort(compare).slice(0, limit));
  }
});

test("bounded file reads preserve UTF-8 bytes and reject growth after the caller's size check", async t => {
  const { root } = await safetyFixture(t, "bounded-file-growth"), file = join(root, "text.txt");
  const content = Buffer.from("한글🙂\n".repeat(10000)); await writeFile(file, content);
  const handle = await open(file, "r");
  try { assert.deepEqual(await readBoundedHandle(handle, content.length), content); } finally { await handle.close(); }
  const growing = await open(file, "r");
  try {
    const { size } = await growing.stat(); await appendFile(file, "extra");
    await assert.rejects(readBoundedHandle(growing, size), FileReadLimitError);
  } finally { await growing.close(); }
  const cancelled = await open(file, "r"), controller = new AbortController(); controller.abort();
  try { await assert.rejects(readBoundedHandle(cancelled, content.length, controller.signal), { name: "AbortError" }); }
  finally { await cancelled.close(); }
});

test("parallel unstaged content preserves missing files, exact bytes, and cancellation", async t => {
  const { root } = await safetyFixture(t, "parallel-content");
  assert.equal(await readWorkingContentWithoutStaged(root, "missing.txt", { maxBytes: 100 }), "");
  await writeFile(join(root, "tracked.txt"), "head\n"); await git(root, "add", "."); await git(root, "commit", "-qm", "head");
  await writeFile(join(root, "tracked.txt"), "head\nstaged\n"); await git(root, "add", ".");
  await writeFile(join(root, "tracked.txt"), "head\nstaged\nworking 한글\n");
  assert.equal(await readWorkingContentWithoutStaged(root, "tracked.txt", { maxBytes: 100 }), "head\nworking 한글\n");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readWorkingContentWithoutStaged(root, "tracked.txt", { signal: controller.signal }), { name: "AbortError" });
});

test("concurrent line statistics share file IO while one consumer can cancel independently", async t => {
  const { root } = await safetyFixture(t, "shared-untracked-stats"), file = join(root, "new.txt");
  await writeFile(file, "one\ntwo\n"); clearUntrackedStatsCache(); t.after(clearUntrackedStatsCache);
  let reads = 0, release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  const original = fileIO.readFile;
  t.mock.method(fileIO, "readFile", async (...args: Parameters<typeof fileIO.readFile>) => {
    if (args[0] === file) { reads++; started(); await gate; }
    return original(...args);
  });
  const controller = new AbortController();
  const first = countUntrackedLines(root, "new.txt", controller.signal), second = countUntrackedLines(root, "new.txt");
  const rejected = assert.rejects(first, { name: "AbortError" });
  await ready; await settle(); controller.abort(); await rejected;
  release(); assert.equal(await second, 2); assert.equal(reads, 1);
  assert.equal(await countUntrackedLines(root, "new.txt"), 2); assert.equal(reads, 1);
});

test("recovery fsck is a cancellable read while writing fsck options remain protected", () => {
  assert.equal(gitCommandPolicy(["fsck", "--no-reflogs", "--unreachable", "--no-progress"]).readOnly, true);
  for (const args of [["fsck", "--lost-found"], ["fsck", "--unreachable", "--lost-found"], ["fsck", "--unknown"]]) {
    assert.equal(gitCommandPolicy(args).readOnly, false);
  }
});

test("unreachable metadata uses one process and returns the exact latest limited commits", async t => {
  const { root } = await safetyFixture(t, "unreachable-stream-topk");
  const tree = await git(root, "rev-parse", "HEAD^{tree}"), expected = [];
  // 200개 경계를 넘겨도 metadata 프로세스가 하나인지 확인한다. 직접 ODB에 쓰지 않고 공통 실행기를 쓴다.
  for (let i = 0; i < 205; i++) {
    const date = `2020-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`;
    const hash = (await runGit(["commit-tree", tree, "-m", `복구 ${i}`], root,
      { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })).trim();
    expected.push({ hash, timestamp: Date.parse(date) / 1000 });
  }
  const commands: string[] = [], release = setGitExecutionObserver(call => commands.push(call.command));
  try {
    const actual = await readUnreachableCommitRecords(root, 7);
    assert.deepEqual(actual.map(({ hash, timestamp }) => ({ hash, timestamp })),
      expected.sort((a, b) => b.timestamp - a.timestamp || a.hash.localeCompare(b.hash)).slice(0, 7));
    assert.ok(actual.every(record => record.message.startsWith("복구 ")));
    assert.equal(commands.filter(command => command === "log").length, 1);
    assert.equal(commands.filter(command => command === "show").length, 0);
  } finally { release(); }
});

test("cancelled reflog and object scans reject instead of publishing an empty successful result", async t => {
  const { root } = await safetyFixture(t, "cancelled-recovery"), controller = new AbortController(); controller.abort();
  await assert.rejects(readUnreachableCommitRecords(root, 80, controller.signal), { name: "AbortError" });
  await assert.rejects(readReflogEntries(root, { includeUnreachable: true, signal: controller.signal }), { name: "AbortError" });
});

test("stash file metadata survives stash numbering changes and refresh pruning", async t => {
  const { root } = await safetyFixture(t, "stash-stable-cache");
  await writeFile(join(root, "tracked.txt"), "selected\n"); await git(root, "stash", "push", "-qm", "selected");
  const service = new GitService(root), [entry] = await service.listStashes(); let reads = 0;
  const original = service.stashShowFiles.bind(service);
  t.mock.method(service, "stashShowFiles", async hash => { reads++; return original(hash); });
  const deps: any = { registry: { get: () => service }, changesView: { getActiveRepo: () => root, setStashes: () => {} } };
  await loadStashFilesForView(deps, { repoRoot: root, ref: entry.ref, hash: entry.hash });
  await writeFile(join(root, "tracked.txt"), "newer\n"); await git(root, "stash", "push", "-qm", "newer");
  await refreshStashes(deps);
  await loadStashFilesForView(deps, { repoRoot: root, ref: entry.ref, hash: entry.hash });
  assert.equal(reads, 1);
});

test("remote inspection refills free slots while its first remote remains blocked", async () => {
  let release!: () => void, firstDone = false, refilled = false, active = 0, peak = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const safety = setTimeout(() => release(), 1500);
  const service = new StaleBranchService("/fixture", async args => {
    if (args[0] === "remote") return "r0\nr1\nr2\nr3\nr4\nr5\n";
    if (args[0] === "config") return "fixed remote configuration";
    if (args[0] === "ls-remote") {
      peak = Math.max(peak, ++active);
      if (args.at(-1) === "r0") { await gate; firstDone = true; }
      else if (args.at(-1) === "r4") { refilled = !firstDone; release(); }
      active--; return "a".repeat(40) + "\trefs/heads/main\n";
    }
    return "";
  });
  try { await service.inspect(); assert.equal(refilled, true); assert.ok(peak <= 4); }
  finally { clearTimeout(safety); release(); }
});

test("reflog object existence checks start before the independent fsck completes", async t => {
  const { root } = await safetyFixture(t, "reflog-independent-reads");
  let release!: () => void, blocked = false, overlapped = false, timeout: NodeJS.Timeout | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const restore = setGitProcessPreparation(async (args, cwd, options) => {
    if (cwd === root && args[0] === "fsck") {
      blocked = true; timeout = setTimeout(() => { blocked = false; release(); }, 1500); await gate;
    }
    if (cwd === root && args[0] === "cat-file") { overlapped = blocked; blocked = false; release(); }
    return { options };
  });
  try { await readReflogEntries(root, { includeUnreachable: true }); assert.equal(overlapped, true); }
  finally { restore(); clearTimeout(timeout); release(); }
});

test("closing or replacing reflog reads suppresses late publication and preserves the new request", async () => {
  const pending: Array<() => void> = [], posted: any[] = [];
  const sender = new GraphReflogSender((deps, options) => new Promise<void>(resolve => {
    pending.push(() => { deps.post({ type: "graphReflog", entries: [], requestId: options.requestId }); resolve(); });
  }));
  const deps = { repoRoot: "/fixture", post: (message: any) => posted.push(message) };
  const old = sender.send(deps, { requestId: 1 }), current = sender.send(deps, { requestId: 2 });
  sender.cancel("stale close", 1);
  pending[0](); await old; pending[1](); await current;
  assert.deepEqual(posted.map(message => [message.type, message.requestId]), [["graphReflogCancelled", 1], ["graphReflog", 2]]);
  const closing = sender.send(deps, { requestId: 3 }); sender.cancel("closed", 3); pending[2](); await closing;
  assert.equal(posted.some(message => message.type === "graphReflog" && message.requestId === 3), false);
});

test("stash presentation loads fifty entries at a time without changing full selection lookup", async t => {
  const service = new GitService("/fixture/stash-pagination"), entries = Array.from({ length: 60 }, (_, i) => ({
    ref: `stash@{${i}}`, index: i, hash: (i + 1).toString(16).padStart(40, "0"), branch: "main", message: `stash ${i}`, relativeDate: "now",
  }));
  const limits: Array<number | undefined> = []; let shown: any[] = [], page: any;
  t.mock.method(service, "listStashes", async limit => { limits.push(limit); return entries.slice(0, limit); });
  const deps: any = { registry: { get: () => service }, changesView: { getActiveRepo: () => service.repoRoot,
    setStashes: (items?: any[], state?: any) => { if (items) shown = items; page = state; } } };
  await refreshStashes(deps); assert.equal(shown.length, 50); assert.equal(page.hasMore, true);
  await refreshStashes(deps, true, service.repoRoot); assert.equal(shown.length, 60); assert.equal(page.hasMore, false);
  assert.deepEqual(limits, [51, 10000], "the initial prefix stays bounded and subsequent pages load the full metadata only once");
  const missing = limits.length;
  await refreshStashes(deps, true, "/stale/repository"); assert.equal(limits.length, missing);
  // 선택 검증용 기본 API에는 표시 limit을 저장하거나 암묵적으로 적용하지 않는다.
  assert.equal((await service.listStashes()).length, 60); assert.equal(limits.at(-1), undefined);
});
