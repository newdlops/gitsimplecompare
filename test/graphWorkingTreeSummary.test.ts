import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { GitLogService } from "../src/git/gitLogService";
import { GitService } from "../src/git/gitService";
import { PrivateStatusIndex } from "../src/git/privateStatusIndex";
import { setGitExecutionObserver } from "../src/git/gitExecutionDiagnostics";
import { disposeWorkingTreeSnapshots, invalidateWorkingTreeSnapshot, readWorkingTreeSnapshot, readWorkingTreeSummary } from "../src/git/workingTreeSnapshot";
import { workingTreeSnapshot, type WorkingTreeSummary } from "../src/git/workingTreeStatusFormat";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실행 시작·완료를 별도로 해제해 시간 지연 없이 소비자 순서와 취소를 검증한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

/** 파일별 전체 목록을 요약과 구분하고 반환 값의 사본 격리를 확인할 고정 Native 의미 값이다. */
function fullSnapshot(root: string) {
  return workingTreeSnapshot(root, { head: "a".repeat(40), branch: "main", entries: [
    { xy: "??", path: "new folder/one.txt" }, { xy: "??", path: "new folder/two.txt" },
  ] });
}

/** 원본 index의 내용과 파일 identity를 함께 보존해 읽기 경로의 숨은 쓰기를 검출한다. */
async function indexState(root: string) {
  const file = path.join(root, ".git/index"), info = await stat(file);
  return { bytes: await readFile(file), ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs };
}

test("Graph virtual commits do not enumerate every file in an untracked directory", async t => {
  const f = await safetyFixture(t, "graph-summary-untracked"); t.after(disposeWorkingTreeSnapshots);
  const folder = path.join(f.root, "bulk untracked"); await mkdir(folder);
  await Promise.all(Array.from({ length: 200 }, (_, i) => writeFile(path.join(folder, `file-${i}.txt`), "user work\n")));
  const before = await indexState(f.root), commands: string[] = [];
  const stop = setGitExecutionObserver(row => commands.push(row.command)); t.after(stop);
  const commits = await new GitLogService(f.root).getVirtualCommits();
  assert.deepEqual(commits.map(commit => commit.kind), ["ongoing", "staged"]);
  assert.deepEqual(commits[1].parents, [f.head]);
  assert.equal(commands.filter(command => command === "status").length, 1);
  assert.equal(commands.filter(command => command === "ls-files").length, 0,
    "Graph needs presence of changes, not a complete untracked file list");
  assert.deepEqual(await indexState(f.root), before);
  const groups = await new GitService(f.root).getStatusGroups({ includeStats: false });
  assert.equal(groups.unstaged.filter(change => change.path.startsWith("bulk untracked/")).length, 200,
    "Changes must retain every untracked file even after a Graph summary read");
  assert.deepEqual(await indexState(f.root), before);
});

test("Graph reuses a fresh complete Changes snapshot without another Git read", async t => {
  const f = await safetyFixture(t, "graph-summary-full-reuse"); t.after(disposeWorkingTreeSnapshots);
  await writeFile(path.join(f.root, "tracked.txt"), "edit\n");
  const service = new GitService(f.root); await service.getStatusGroups({ includeStats: false });
  const commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command)); t.after(stop);
  const commits = await new GitLogService(f.root).getVirtualCommits();
  assert.equal(commits.length, 2); assert.deepEqual(commands, []);
  invalidateWorkingTreeSnapshot(f.root);
  await git(f.root, "checkout", "--", "tracked.txt");
  assert.deepEqual(await new GitLogService(f.root).getVirtualCommits(), []);
});

test("simultaneous Graph and Changes consumers share one complete read and receive isolated values", async t => {
  t.after(disposeWorkingTreeSnapshots);
  const root = `/private/tmp/gsc-summary-shared-${process.pid}`, started = deferred<void>(), done = deferred<void>();
  let fullReads = 0, summaryReads = 0;
  t.mock.method(PrivateStatusIndex.prototype, "read", async () => {
    fullReads++; started.resolve(); await done.promise; return fullSnapshot(root);
  });
  t.mock.method(PrivateStatusIndex.prototype, "readSummary", async () => { summaryReads++; return { hasChanges: false }; });
  const full = readWorkingTreeSnapshot(root), summary = readWorkingTreeSummary(root);
  await started.promise; done.resolve();
  const [snapshot, result] = await Promise.all([full, summary]);
  assert.deepEqual(result, { head: "a".repeat(40), hasChanges: true });
  snapshot.groups.unstaged.length = 0; result.hasChanges = false;
  assert.equal((await readWorkingTreeSnapshot(root)).groups.unstaged.length, 2);
  assert.equal((await readWorkingTreeSummary(root)).hasChanges, true);
  assert.equal(fullReads, 1); assert.equal(summaryReads, 0);
});

test("Changes upgrades an already running Graph summary once without concurrent private-index writes", async t => {
  t.after(disposeWorkingTreeSnapshots);
  const root = `/private/tmp/gsc-summary-upgrade-${process.pid}`, started = deferred<void>(), done = deferred<WorkingTreeSummary>();
  const fullStarted = deferred<void>(), fullDone = deferred<void>();
  let active = false, fullReads = 0, summaryReads = 0, fullSignal!: AbortSignal;
  t.mock.method(PrivateStatusIndex.prototype, "readSummary", async () => {
    active = true; summaryReads++; started.resolve(); const value = await done.promise; active = false; return value;
  });
  t.mock.method(PrivateStatusIndex.prototype, "read", async signal => {
    assert.equal(active, false); fullReads++; fullSignal = signal; fullStarted.resolve(); await fullDone.promise;
    return fullSnapshot(root);
  });
  const summary = readWorkingTreeSummary(root); await started.promise;
  const cancelled = new AbortController();
  const first = readWorkingTreeSnapshot(root, { signal: cancelled.signal });
  const second = readWorkingTreeSnapshot(root);
  assert.equal(fullReads, 0); done.resolve({ head: "a".repeat(40), hasChanges: true });
  await fullStarted.promise;
  cancelled.abort(); await assert.rejects(first, { name: "AbortError" });
  assert.equal(fullSignal.aborted, false, "one consumer cannot cancel the remaining complete read");
  fullDone.resolve();
  assert.equal((await second).groups.unstaged.length, 2);
  assert.equal((await summary).hasChanges, true);
  assert.equal(fullReads, 1); assert.equal(summaryReads, 1);
});

test("a changed generation replaces a late Graph summary instead of caching its old HEAD", async t => {
  t.after(disposeWorkingTreeSnapshots);
  const root = `/private/tmp/gsc-summary-generation-${process.pid}`, started = deferred<void>(), done = deferred<WorkingTreeSummary>();
  let reads = 0;
  t.mock.method(PrivateStatusIndex.prototype, "readSummary", async () => {
    if (++reads === 1) { started.resolve(); return done.promise; }
    return { head: "b".repeat(40), hasChanges: true };
  });
  const first = readWorkingTreeSummary(root); await started.promise;
  invalidateWorkingTreeSnapshot(root);
  const second = readWorkingTreeSummary(root); done.resolve({ head: "a".repeat(40), hasChanges: false });
  for (const result of await Promise.all([first, second])) assert.deepEqual(result, { head: "b".repeat(40), hasChanges: true });
  assert.equal(reads, 2);
});

test("Graph summaries keep ignored-only, staged, committed and unborn states accurate without changing the source index", async t => {
  const f = await safetyFixture(t, "graph-summary-states"); t.after(disposeWorkingTreeSnapshots);
  const service = new GitLogService(f.root);
  assert.deepEqual(await service.getVirtualCommits(), []);
  await writeFile(path.join(f.root, ".git/info/exclude"), "ignored/\n");
  await mkdir(path.join(f.root, "ignored")); await writeFile(path.join(f.root, "ignored/local.txt"), "ignored\n");
  invalidateWorkingTreeSnapshot(f.root); assert.deepEqual(await service.getVirtualCommits(), []);
  await writeFile(path.join(f.root, "tracked.txt"), "staged\n"); await git(f.root, "add", "tracked.txt");
  const staged = await indexState(f.root);
  assert.equal((await service.getVirtualCommits()).length, 2); assert.deepEqual(await indexState(f.root), staged);
  await git(f.root, "commit", "-qm", "updated"); assert.deepEqual(await service.getVirtualCommits(), []);
  await git(f.root, "checkout", "--orphan", "unborn");
  const unborn = await indexState(f.root), commits = await service.getVirtualCommits();
  assert.equal(commits.length, 2); assert.deepEqual(commits[1].parents, []);
  assert.deepEqual(await indexState(f.root), unborn);
});

test("a conflicted index still produces virtual rows anchored to the Native HEAD and remains byte-identical", async t => {
  const f = await safetyFixture(t, "graph-summary-unmerged"); t.after(disposeWorkingTreeSnapshots);
  await git(f.root, "checkout", "-qb", "topic"); await commitText(f.root, "topic\n", "topic");
  await git(f.root, "checkout", "main"); const head = await commitText(f.root, "main\n", "main");
  await assert.rejects(git(f.root, "merge", "topic"), /conflict/i);
  const before = await indexState(f.root), commits = await new GitLogService(f.root).getVirtualCommits();
  assert.equal(commits.length, 2); assert.deepEqual(commits[1].parents, [head]);
  assert.deepEqual(await indexState(f.root), before);
});

test("an already cancelled Graph summary starts no Native read", async t => {
  t.after(disposeWorkingTreeSnapshots);
  const controller = new AbortController(); controller.abort();
  const commands: string[] = [], stop = setGitExecutionObserver(row => commands.push(row.command)); t.after(stop);
  await assert.rejects(new GitLogService(`/private/tmp/gsc-summary-cancelled-${process.pid}`).getVirtualCommits(controller.signal), { name: "AbortError" });
  assert.deepEqual(commands, []);
});
