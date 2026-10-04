import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GitBlameService, type GitBlameLine } from "../src/git/blameService";
import { setGitExecutableResolver } from "../src/git/gitExec";
import { readSharedBlame, disposeSharedBlameReads, invalidateSharedBlameReads } from "../src/git/sharedBlameReads";
import { readBlameCacheIdentity } from "../src/git/blameCacheIdentity";

const line: GitBlameLine = { line: 1, commit: "a".repeat(40), authorName: "A", authorMail: "a@example.test", summary: "first", filename: "code.ts", content: "first" };

test("unchanged blame survives the one-second refresh gap and invalidation still reads current data", async t => {
  t.after(disposeSharedBlameReads); let now = Date.now(), reads = 0;
  t.mock.method(Date, "now", () => now);
  const load = async () => { reads++; return [{ ...line, summary: String(reads) }]; };
  const first = await readSharedBlame("/repo", "same-file-head", load);
  first[0].summary = "mutated by UI";
  now += 2000;
  assert.equal((await readSharedBlame("/repo", "same-file-head", load))[0].summary, "1");
  assert.equal(reads, 1);
  invalidateSharedBlameReads("/repo");
  assert.equal((await readSharedBlame("/repo", "same-file-head", load))[0].summary, "2");
  now += 60_001; await readSharedBlame("/repo", "same-file-head", load); assert.equal(reads, 3);
});

test("large completed blame results are returned without keeping an oversized cache", async t => {
  t.after(disposeSharedBlameReads); let reads = 0;
  const load = async () => { reads++; return [{ ...line, content: "x".repeat(9 * 1024 * 1024) }]; };
  assert.equal((await readSharedBlame("/large", "huge", load))[0].content.length, 9 * 1024 * 1024);
  await readSharedBlame("/large", "huge", load); assert.equal(reads, 2);
});

/** Git 프로세스만 임시 실행 파일로 대체하고 서비스의 metadata/key/캐시/파서는 그대로 검사한다. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-blame-cache-test-")), gitDir = path.join(root, ".git"), file = path.join(root, "code.ts");
  await mkdir(path.join(gitDir, "refs", "heads"), { recursive: true });
  await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(path.join(gitDir, "refs", "heads", "main"), `${"a".repeat(40)}\n`);
  await writeFile(file, "first\n");
  const calls = path.join(root, "calls"), executable = path.join(root, "git-fixture");
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]!=='blame')throw Error('extra Git process: '+args[0]);
fs.appendFileSync(${JSON.stringify(calls)},'blame\\n');
process.stdout.write('${"a".repeat(40)} 1 1 1\\nauthor A\\nauthor-mail <a@example.test>\\nsummary first\\nfilename code.ts\\n\\t'+fs.readFileSync(${JSON.stringify(file)},'utf8'));
`, { mode: 0o755 });
  t.after(setGitExecutableResolver(() => executable));
  t.after(async () => { await disposeSharedBlameReads(); await rm(root, { recursive: true, force: true }); });
  return { root, gitDir, file, service: new GitBlameService(root), count: async () => (await readFile(calls, "utf8")).trim().split("\n").length };
}

test("file and HEAD changes produce fresh blame even within the shared cache period", async t => {
  const f = await fixture(t);
  await f.service.getFileBlame(f.file); await f.service.getFileBlame(f.file); assert.equal(await f.count(), 1);
  await writeFile(path.join(f.gitDir, "refs", "heads", "main"), `${"b".repeat(40)}\n`);
  await f.service.getFileBlame(f.file); assert.equal(await f.count(), 2);
  await writeFile(f.file, "second\n");
  assert.equal((await f.service.getFileBlame(f.file))[0].content, "second"); assert.equal(await f.count(), 3);
  await writeFile(path.join(f.gitDir, "index"), "changed-index");
  await f.service.getFileBlame(f.file); assert.equal(await f.count(), 4);
});

test("packed, detached and unborn HEAD metadata changes invalidate completed blame", async t => {
  const f = await fixture(t);
  await rm(path.join(f.gitDir, "refs", "heads", "main"));
  await writeFile(path.join(f.gitDir, "packed-refs"), `${"a".repeat(40)} refs/heads/main\n`);
  await f.service.getFileBlame(f.file);
  await writeFile(path.join(f.gitDir, "packed-refs"), `${"b".repeat(40)} refs/heads/main\n`);
  await f.service.getFileBlame(f.file); assert.equal(await f.count(), 2);
  await writeFile(path.join(f.gitDir, "HEAD"), `${"c".repeat(40)}\n`);
  await f.service.getFileBlame(f.file); assert.equal(await f.count(), 3);
  await writeFile(path.join(f.gitDir, "HEAD"), "ref: refs/heads/unborn\n");
  await f.service.getFileBlame(f.file); assert.equal(await f.count(), 4);
  await writeFile(path.join(f.gitDir, "refs", "heads", "unborn"), `${"d".repeat(40)}\n`);
  await f.service.getFileBlame(f.file); assert.equal(await f.count(), 5);
});

test("linked worktree blame tracks its own HEAD/index and the common branch refs", async t => {
  const f = await fixture(t), common = path.join(f.root, "common.git"), linked = path.join(common, "worktrees", "one");
  await mkdir(path.join(common, "refs", "heads"), { recursive: true }); await mkdir(linked, { recursive: true });
  await writeFile(path.join(linked, "HEAD"), "ref: refs/heads/main\n"); await writeFile(path.join(linked, "commondir"), "../..\n");
  await rm(f.gitDir, { recursive: true }); await writeFile(f.gitDir, `gitdir: ${linked}\n`);
  await writeFile(path.join(common, "refs", "heads", "main"), `${"a".repeat(40)}\n`);
  await f.service.getFileBlame(f.file);
  await writeFile(path.join(common, "refs", "heads", "main"), `${"b".repeat(40)}\n`);
  await f.service.getFileBlame(f.file); assert.equal(await f.count(), 2);
  await writeFile(path.join(linked, "index"), "new-index");
  await f.service.getFileBlame(f.file); assert.equal(await f.count(), 3);
});

test("unreadable repository identity does not reuse a completed blame result", async t => {
  const f = await fixture(t); await rm(path.join(f.gitDir, "HEAD"));
  await f.service.getFileBlame(f.file); await f.service.getFileBlame(f.file);
  assert.equal(await f.count(), 2);
});

test("a repository with reftable metadata bypasses the unsupported file-ref identity cache", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.gitDir, "reftable"));
  await writeFile(path.join(f.gitDir, "reftable", "tables.list"), "one.ref\n");
  await f.service.getFileBlame(f.file);
  await writeFile(path.join(f.gitDir, "reftable", "tables.list"), "two.ref\n");
  await f.service.getFileBlame(f.file); assert.equal(await f.count(), 2);
});

test("a null global config stays stable when another process writes to the null device", { skip: process.platform === "win32" }, async t => {
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; });
  const f = await fixture(t), before = await readBlameCacheIdentity(f.root, f.file);
  assert.equal(typeof before, "string");
  await writeFile("/dev/null", "unrelated command output\n");
  assert.equal(await readBlameCacheIdentity(f.root, f.file), before);
});
