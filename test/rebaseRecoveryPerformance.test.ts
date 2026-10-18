import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { preserveOperationEdits } from "../src/git/operationRecoveryBackup";
import { BranchOperationService } from "../src/git/branchOperationService";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 Git은 실행하면서 복구 단계에서 추가된 프로세스 수와 인자만 기록한다. */
function recordGitCalls(t: TestContext): string[][] {
  const calls: string[][] = [];
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === "git") calls.push(args[1]);
    return (spawn as Function)(...args);
  });
  return calls;
}

test("rebase recovery batches index blobs while preserving binary, staged, deleted and symlink bytes", async t => {
  const { root } = await safetyFixture(t, "rebase-recovery-batch");
  const staged = new Map<string, Buffer>();
  for (let index = 0; index < 192; index++) {
    const name = index === 0 ? "한글\tline\nname.bin" : `file-${index}.bin`;
    const content = index === 1 ? Buffer.alloc(0) : Buffer.from([0, 255, index % 180, 10, 13]);
    staged.set(name, content);
    await writeFile(join(root, name), content);
  }
  await chmod(join(root, "file-2.bin"), 0o755);
  await symlink("../outside-config", join(root, "link"));
  await rm(join(root, "tracked.txt"));
  await git(root, "add", "-A");
  await writeFile(join(root, "한글\tline\nname.bin"), "newer working bytes\n");
  await writeFile(join(root, "untracked.txt"), "untracked work\n");
  const gitDir = await git(root, "rev-parse", "--absolute-git-dir");
  const index = (await git(root, "ls-files", "--stage", "-z")).split("\0").filter(Boolean);
  const calls = recordGitCalls(t);
  const started = performance.now();
  const directory = await preserveOperationEdits(root, gitDir, "skip");
  t.diagnostic(`Recovery: ${Math.round(performance.now() - started)}ms, ${calls.filter(args => args[0] === "cat-file").length} cat-file processes`);
  assert.ok(directory);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.files.length, 195);
  assert.deepEqual(manifest.index, index);
  for (const entry of manifest.files) {
    if (entry.path === "tracked.txt") { assert.equal(entry.kind, "absent"); continue; }
    const expected = entry.path === "link" ? Buffer.from("../outside-config")
      : entry.path === "untracked.txt" ? Buffer.from("untracked work\n")
        : entry.path === "한글\tline\nname.bin" ? Buffer.from("newer working bytes\n") : staged.get(entry.path);
    assert.deepEqual(await readFile(join(directory, entry.dataFile)), expected);
    if (entry.path === "link") assert.equal(entry.kind, "symlink");
    if (entry.path === "file-2.bin") assert.ok(entry.mode & 0o111);
  }
  for (const entry of index) {
    const [, , hash, , name] = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry)!;
    assert.deepEqual(await readFile(join(directory, `${hash}.blob`)), name === "link" ? Buffer.from("../outside-config") : staged.get(name));
  }
  const reads = calls.filter(args => args[0] === "cat-file");
  assert.ok(reads.length <= 3, `Expected at most three batched blob reads, got ${reads.length}`);
});

test("recovery limits batch bytes and preserves a single blob larger than the batch target", async t => {
  const { root } = await safetyFixture(t, "rebase-recovery-large");
  const contents = [Buffer.alloc(5 * 1024 * 1024, 0), Buffer.alloc(5 * 1024 * 1024, 255), Buffer.alloc(9 * 1024 * 1024, 10)];
  for (let index = 0; index < contents.length; index++) await writeFile(join(root, `${index}.bin`), contents[index]);
  await git(root, "add", "-A");
  const gitDir = await git(root, "rev-parse", "--absolute-git-dir");
  const index = (await git(root, "ls-files", "--stage", "-z")).split("\0").filter(entry => /\t\d.bin$/.test(entry));
  const calls = recordGitCalls(t);
  const directory = await preserveOperationEdits(root, gitDir, "skip");
  assert.ok(directory);
  for (const entry of index) {
    const [, , hash, , name] = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry)!;
    assert.deepEqual(await readFile(join(directory, `${hash}.blob`)), contents[Number(name[0])]);
  }
  assert.equal(calls.filter(args => args[0] === "cat-file").length, 4);
});

test("recovery stores actual index objects even when a replace ref points at different bytes", async t => {
  const { root } = await safetyFixture(t, "rebase-recovery-replace");
  await writeFile(join(root, "tracked.txt"), "real index bytes\n");
  await git(root, "add", "tracked.txt");
  const oid = await git(root, "rev-parse", ":tracked.txt");
  await writeFile(join(root, "replacement.txt"), "replacement bytes\n");
  const replacement = await git(root, "hash-object", "-w", "replacement.txt");
  await git(root, "replace", oid, replacement);
  const directory = await preserveOperationEdits(root, await git(root, "rev-parse", "--absolute-git-dir"), "skip");
  assert.ok(directory);
  assert.equal(await readFile(join(directory, `${oid}.blob`), "utf8"), "real index bytes\n");
});

test("recovery refuses missing index blobs without publishing a successful manifest", async t => {
  const { root } = await safetyFixture(t, "rebase-recovery-missing");
  await writeFile(join(root, "tracked.txt"), "index bytes\n");
  await git(root, "add", "tracked.txt");
  const oid = await git(root, "rev-parse", ":tracked.txt");
  const gitDir = await git(root, "rev-parse", "--absolute-git-dir");
  await rm(join(gitDir, "objects", oid.slice(0, 2), oid.slice(2)));
  await assert.rejects(preserveOperationEdits(root, gitDir, "skip"), /Cannot read index blob/);
  const recovery = join(gitDir, "gitsimplecompare/operation-recovery");
  for (const name of await readdir(recovery)) {
    await assert.rejects(readFile(join(recovery, name, "manifest.json")), { code: "ENOENT" });
  }
  assert.equal(await git(root, "rev-parse", ":tracked.txt"), oid);
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "index bytes\n");
});

test("recovery batch parsing supports SHA-256 index objects", async t => {
  const { directory } = await safetyFixture(t, "rebase-recovery-sha256");
  const root = join(directory, "sha256");
  await mkdir(root);
  await git(root, "init", "-q", "--object-format=sha256");
  for (const [key, value] of Object.entries({ "user.name": "Test", "user.email": "test@example.test", "commit.gpgsign": "false", "core.fsmonitor": "false", "core.hooksPath": join(directory, "hooks") })) {
    await git(root, "config", key, value);
  }
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "base");
  await writeFile(join(root, "tracked.txt"), Buffer.from([0, 255, 10]));
  await git(root, "add", ".");
  const oid = await git(root, "rev-parse", ":tracked.txt");
  const backup = await preserveOperationEdits(root, await git(root, "rev-parse", "--absolute-git-dir"), "skip");
  assert.ok(backup);
  assert.equal(oid.length, 64);
  assert.deepEqual(await readFile(join(backup, `${oid}.blob`)), Buffer.from([0, 255, 10]));
});

test("branch rebase checks index conflicts without rescanning worktree diffs", async t => {
  const { root } = await safetyFixture(t, "branch-rebase-index-probe");
  await git(root, "switch", "-qc", "source");
  await writeFile(join(root, "other.txt"), "source\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "source");
  await git(root, "switch", "main");
  const calls = recordGitCalls(t);
  assert.equal((await new BranchOperationService(root).rebaseMerge("source")).status, "completed");
  assert.ok(calls.some(args => args.includes("ls-files") && args.includes("--unmerged") && args.includes("core.fsmonitor=false")));
  assert.equal(calls.some(args => args[0] === "diff" && args.includes("--diff-filter=U")), false);
});
