import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GitLogService } from "../src/git/gitLogService";
import { hasWorkingTreeChanges } from "../src/git/workingTreeChanges";
import { disposeWorkingTreeSnapshots } from "../src/git/workingTreeSnapshot";
import { setGitExecutableResolver } from "../src/git/gitExec";
import { forgetWorkingTreeChangeHints, recentWorkingTreeChangeHints, rememberWorkingTreeChangeHints } from "../src/git/workingTreeChangeHints";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 측정 구간의 Native status 인자만 보관하며 stdout·실행·종료 정책은 바꾸지 않는다. */
function statuses(t: TestContext) {
  const spawn = childProcess.spawn, calls: string[][] = [];
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[1]?.includes("status")) calls.push([...args[1]]);
    return (spawn as Function)(...args);
  });
  return calls;
}

/** 원본 index의 바이트와 파일 metadata를 함께 기록해 사전 확인의 숨은 쓰기를 검출한다. */
async function sourceIndex(root: string) {
  const file = path.join(root, ".git/index"), info = await stat(file);
  return { bytes: await readFile(file), ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs };
}

test("a recent Graph change is rechecked with one literal Native path probe before running an operation", async t => {
  const f = await safetyFixture(t, "positive-change-hint"); t.after(disposeWorkingTreeSnapshots);
  await writeFile(path.join(f.root, "tracked.txt"), "user edit\n");
  assert.equal((await new GitLogService(f.root).getVirtualCommits()).length, 2);
  const before = await sourceIndex(f.root), calls = statuses(t);
  assert.equal(await hasWorkingTreeChanges(f.root, true), true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("--literal-pathspecs"));
  assert.deepEqual(calls[0].slice(calls[0].indexOf("--") + 1), ["tracked.txt"]);
  assert.ok(calls[0].includes("core.fsmonitor=false"));
  assert.deepEqual(await sourceIndex(f.root), before);
});

test("a stale changed path can never prove clean or hide an edit outside its old scope", async t => {
  const f = await safetyFixture(t, "stale-change-hint"); t.after(disposeWorkingTreeSnapshots);
  await writeFile(path.join(f.root, "old.txt"), "old\n");
  await new GitLogService(f.root).getVirtualCommits();
  await rm(path.join(f.root, "old.txt")); await writeFile(path.join(f.root, "elsewhere.txt"), "new\n");
  const before = await sourceIndex(f.root), calls = statuses(t);
  assert.equal(await hasWorkingTreeChanges(f.root), true);
  assert.equal(calls.length, 2, "a negative scoped probe must fall back to the original whole-tree check");
  assert.equal(calls[1].includes("--"), false);
  assert.deepEqual(await sourceIndex(f.root), before);
  await rm(path.join(f.root, "elsewhere.txt")); calls.length = 0;
  assert.equal(await hasWorkingTreeChanges(f.root), false);
  assert.equal(calls.length, 1, "discard a missed hint instead of adding a permanent scan to clean operations");
});

test("same-count untracked replacement with restored directory mtime still requires a full fresh check after a miss", async t => {
  const f = await safetyFixture(t, "hint-untracked-layout"); t.after(disposeWorkingTreeSnapshots);
  await writeFile(path.join(f.root, "previous.txt"), "old\n"); await new GitLogService(f.root).getVirtualCommits();
  const info = await stat(f.root); await rm(path.join(f.root, "previous.txt"));
  await mkdir(path.join(f.root, "new dir")); await writeFile(path.join(f.root, "new dir/file.txt"), "new\n");
  await utimes(f.root, info.atime, info.mtime);
  const calls = statuses(t);
  assert.equal(await hasWorkingTreeChanges(f.root), true);
  assert.equal(calls.length, 2);
  assert.ok((await git(f.root, "status", "--porcelain=v1", "--untracked-files=all")).includes("new dir/file.txt"));
});

test("an ignored old path cannot hide new files and magic-looking names remain literal", async t => {
  const f = await safetyFixture(t, "hint-ignore-literal"); t.after(disposeWorkingTreeSnapshots);
  const file = process.platform === "win32" ? "literal[0].txt" : ":(glob)literal[0].txt";
  await writeFile(path.join(f.root, file), "untracked\n"); await new GitLogService(f.root).getVirtualCommits();
  const calls = statuses(t); assert.equal(await hasWorkingTreeChanges(f.root), true);
  assert.deepEqual(calls[0].slice(calls[0].indexOf("--") + 1), [file]);
  await writeFile(path.join(f.root, ".git/info/exclude"), `${file.replace(/\[/g, "\\[").replace(/\]/g, "\\]")}\n`);
  await writeFile(path.join(f.root, "outside.txt"), "other edit\n"); calls.length = 0;
  assert.equal(await hasWorkingTreeChanges(f.root), true); assert.equal(calls.length, 2);
});

test("a scoped Native failure after partial dirty output remains a failure", { skip: process.platform === "win32" }, async t => {
  const f = await safetyFixture(t, "hint-failed-native"); t.after(disposeWorkingTreeSnapshots);
  await writeFile(path.join(f.root, "tracked.txt"), "edit\n"); await new GitLogService(f.root).getVirtualCommits();
  const executable = path.join(f.directory, "git-fixture");
  await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(' M tracked.txt\\0');process.stderr.write('native failed');process.exitCode=7;\n`, { mode: 0o755 });
  const restore = setGitExecutableResolver(() => executable); t.after(restore);
  const before = await sourceIndex(f.root);
  await assert.rejects(hasWorkingTreeChanges(f.root), error => (error as { code?: number }).code === 7);
  assert.deepEqual(await sourceIndex(f.root), before);
});

test("owned UTF-8 path copies preserve Unicode, whitespace and supported newline names in the Native probe", async t => {
  const f = await safetyFixture(t, "hint-unicode-path"); t.after(disposeWorkingTreeSnapshots);
  const file = process.platform === "win32" ? "한글 α 공백.txt" : "한글 α\n 공백.txt";
  await writeFile(path.join(f.root, file), "local\n"); await new GitLogService(f.root).getVirtualCommits();
  const calls = statuses(t);
  assert.equal(await hasWorkingTreeChanges(f.root), true);
  assert.deepEqual(calls[0].slice(calls[0].indexOf("--") + 1), [file]);
});

test("recent path candidates are bounded, reject traversal and NUL input, and expose no mutable internal collection", t => {
  const roots = Array.from({ length: 64 }, (_, i) => `/private/tmp/gsc-hint-bound-${process.pid}-${i}`);
  t.after(() => roots.forEach(forgetWorkingTreeChangeHints));
  const invalid = ["../outside", "dir/../../outside", "/absolute", "bad\0path", ".", "가".repeat(1024)];
  for (const root of roots) rememberWorkingTreeChangeHints(root, [...invalid, ...Array.from({ length: 100 }, (_, i) => `changed-${i}.txt`)]
    .map(file => ({ xy: "??", path: file })));
  const stored = roots.map(recentWorkingTreeChangeHints);
  assert.ok(stored.filter(paths => paths.length).length <= 32);
  assert.ok(stored.every(paths => paths.length <= 8 && paths.every(file => !invalid.includes(file))));
  const last = recentWorkingTreeChangeHints(roots.at(-1)!); last.length = 0;
  assert.ok(recentWorkingTreeChangeHints(roots.at(-1)!).length > 0);
  rememberWorkingTreeChangeHints(roots.at(-1)!, []);
  assert.deepEqual(recentWorkingTreeChangeHints(roots.at(-1)!), []);
});
