import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { readRebaseContinueDiagnostics } from "../src/git/rebaseContinueDiagnostics";
import { commitText, git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 같은 실제 rebase 충돌 파일들에 파일당 20ms 읽기 지연을 주고 진단의 직렬 대기를 측정한다. */
test("diagnostics share directory lookup and bound reads for twenty-four unresolved files", { timeout: 45_000 }, async t => {
  const { root } = await safetyFixture(t, "rebase-diagnostics-performance");
  const paths = Array.from({ length: 24 }, (_, index) => `conflict-${index}.txt`);
  for (const rel of paths) await writeFile(join(root, rel), "base\n");
  await git(root, "add", "-A"); await git(root, "commit", "-qm", "base files");
  const base = await git(root, "rev-parse", "HEAD");
  for (const rel of paths) await writeFile(join(root, rel), "main\n");
  await git(root, "add", "-A"); await git(root, "commit", "-qm", "main files");
  await git(root, "switch", "-qc", "side", base);
  for (const rel of paths) await writeFile(join(root, rel), "side\n");
  await git(root, "add", "-A"); await git(root, "commit", "-qm", "side files");
  await assert.rejects(git(root, "rebase", "main"));
  const targets = new Set(paths.map(rel => resolve(root, rel)));
  const spawn = childProcess.spawn, readFile = fs.promises.readFile, open = fs.promises.open;
  let calls = 0, active = 0, peak = 0, reads = 0;
  /** readFile과 FD read 양쪽에 동일한 파일 단위의 저장장치 지연을 주입한다. */
  async function observedRead<T>(task: () => Promise<T>): Promise<T> {
    reads++; active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 20)); return await task(); }
    finally { active--; }
  }
  t.mock.method(childProcess, "spawn", (...args: any[]) => { if (args[0] === "git") calls++; return (spawn as Function)(...args); });
  t.mock.method(fs.promises, "readFile", ((...args: any[]) => targets.has(String(args[0]))
    ? observedRead(() => (readFile as Function)(...args)) : (readFile as Function)(...args)) as typeof readFile);
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (targets.has(String(args[0]))) {
      const read = handle.read.bind(handle); let first = true;
      t.mock.method(handle, "read", ((...values: any[]) => {
        if (!first) return (read as Function)(...values);
        first = false; return observedRead(() => (read as Function)(...values));
      }) as typeof read);
    }
    return handle;
  });
  const started = performance.now();
  const diagnostics = await readRebaseContinueDiagnostics(root);
  t.diagnostic(JSON.stringify({ files: paths.length, calls, reads, peak, injectedDelayMs: 20,
    elapsedMs: +(performance.now() - started).toFixed(1) }));
  assert.equal(calls, 3);
  assert.equal(reads, paths.length);
  assert.equal(peak, 4);
  assert.equal(diagnostics.operation, "rebase");
  assert.deepEqual(diagnostics.unmergedFiles, [...paths].sort());
  assert.deepEqual(diagnostics.markerFiles, [...paths].sort());
  assert.deepEqual(diagnostics.stagedFiles, [...paths].sort());
  assert.deepEqual(diagnostics.unstagedFiles, [...paths].sort());
  assert.equal(diagnostics.rebaseMessageConflicts.length, paths.length);
  // marker 본문 하나를 의도적으로 stage해도 index 충돌이 해소된 뒤에는 다시 검사하지 않는다.
  for (const rel of paths.slice(1)) await writeFile(join(root, rel), "resolved\n");
  await git(root, "add", "-A");
  const staged = await readRebaseContinueDiagnostics(root);
  assert.deepEqual(staged.unmergedFiles, []);
  assert.deepEqual(staged.markerFiles, []);
  assert.equal(staged.stagedFiles.length, paths.length);
  assert.deepEqual(staged.unstagedFiles, []);
  assert.equal(staged.rebaseMessageConflicts.length, paths.length);
  assert.equal(reads, paths.length, "Staged paths must not be scanned again, including intentionally staged marker text");
  await git(root, "-c", "core.editor=true", "rebase", "--continue");
  const completed = await readRebaseContinueDiagnostics(root);
  assert.equal(completed.operation, "none");
  assert.deepEqual(completed.unmergedFiles, []);
  assert.deepEqual(completed.markerFiles, []);
  assert.deepEqual(completed.rebaseMessageConflicts, []);
  assert.equal((await git(root, "show", `HEAD:${paths[0]}`)).includes("<<<<<<<"), true);
});

test("shared diagnostic directory lookup preserves separate Git directory names and observes native Abort", {
  skip: process.platform === "win32", timeout: 45_000,
}, async t => {
  const { root, directory, head } = await safetyFixture(t, "rebase-diagnostic-directory");
  await git(root, "init", "-q", "--separate-git-dir", join(directory, "metadata\n "));
  await commitText(root, "main\n", "main");
  await git(root, "switch", "-qc", "side", head);
  await commitText(root, "side\n", "side");
  await assert.rejects(git(root, "rebase", "main"));
  const spawn = childProcess.spawn;
  let calls = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => { if (args[0] === "git") calls++; return (spawn as Function)(...args); });
  const diagnostics = await readRebaseContinueDiagnostics(root);
  assert.equal(calls, 3);
  assert.equal(diagnostics.operation, "rebase");
  assert.deepEqual(diagnostics.markerFiles, ["tracked.txt"]);
  assert.deepEqual(diagnostics.rebaseMessageConflicts, ["tracked.txt"]);
  await git(root, "rebase", "--abort"); calls = 0;
  const aborted = await readRebaseContinueDiagnostics(root);
  assert.equal(calls, 3);
  assert.equal(aborted.operation, "none");
  assert.deepEqual(aborted.unmergedFiles, []);
  assert.deepEqual(aborted.markerFiles, []);
  assert.deepEqual(aborted.rebaseMessageConflicts, []);
});
