import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { FileHistoryReadCache } from "../src/git/fileHistoryReadCache";
import { FileHistoryDiskStorage } from "../src/git/fileHistoryStorage";
import { FileHistoryService } from "../src/git/fileHistoryService";
import { readFileHistoryContext } from "../src/git/fileHistoryContext";

const execute = promisify(execFile);
/** 초 단위로 변하는 표시 시각만 제외하고 모든 불변 커밋/rename/통계 필드를 대조한다. */
function immutable(entries: Awaited<ReturnType<FileHistoryService["listFileHistory"]>>) {
  return entries.map(({ relativeDate, ...entry }) => entry);
}
/** 실제 Git만 전역 설정에서 격리해 rename·HEAD·index 의미를 검증할 임시 저장소를 준비한다. */
async function repository(t: TestContext, sha256 = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "gsc-history-integration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "repo"); await mkdir(root);
  const saved = new Map(["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"].map(name => [name, process.env[name]]));
  process.env.GIT_CONFIG_NOSYSTEM = "1"; process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  t.after(() => { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const git = async (args: string[], cwd = root) => (await execute("git", args, { cwd, env: process.env })).stdout.trimEnd();
  await git(["init", "-q", ...(sha256 ? ["--object-format=sha256"] : [])]);
  await git(["config", "user.name", "History Cache Test"]); await git(["config", "user.email", "history@example.com"]);
  await git(["config", "core.fsmonitor", "false"]);
  await writeFile(path.join(root, "old name.ts"), "first\nsecond\n"); await git(["add", "--", "old name.ts"]); await git(["commit", "-qm", "Create file"]);
  await git(["mv", "--", "old name.ts", "new name.ts"]); await git(["commit", "-qm", "Rename file"]);
  await writeFile(path.join(root, "new name.ts"), "first\nsecond\nthird\n"); await git(["add", "--", "new name.ts"]); await git(["commit", "-qm", "Update file"]);
  return { root, directory, git };
}

for (const sha256 of [false, true]) {
  test(`cached ${sha256 ? "SHA-256" : "SHA-1"} history preserves rename, stats and index bytes across stage-only changes and HEAD updates`, async t => {
    const f = await repository(t, sha256), cache = new FileHistoryReadCache(); t.after(() => cache.dispose());
    const expected = await new FileHistoryService(f.root).listFileHistory("new name.ts");
    const index = path.join(f.root, ".git/index"), before = await readFile(index);
    const initial = await cache.read(f.root, "new name.ts");
    assert.deepEqual(immutable(initial.commits), immutable(expected)); assert.deepEqual(await readFile(index), before);
    assert.deepEqual(initial.commits.map(entry => entry.status), ["M", "R", "A"]);
    assert.equal(initial.commits[1].oldPath, "old name.ts");
    await writeFile(path.join(f.root, "new name.ts"), "first\nsecond\nthird\nstaged\n"); await f.git(["add", "--", "new name.ts"]);
    const stagedIndex = await readFile(index);
    const reused = await cache.read(f.root, "new name.ts"); assert.equal(reused.source, "memory");
    assert.deepEqual(immutable(reused.commits), immutable(await new FileHistoryService(f.root).listFileHistory("new name.ts")));
    assert.deepEqual(await readFile(index), stagedIndex);
    await f.git(["commit", "-qm", "Commit staged update"]);
    const changed = await cache.read(f.root, "new name.ts"); assert.equal(changed.source, "git");
    assert.equal(changed.commits.length, 4); assert.equal(changed.commits[0].title, "Commit staged update");
  });
}

test("configuration/include, attributes and replace refs change the context while index refresh does not", async t => {
  const f = await repository(t), file = "new name.ts";
  const initial = await readFileHistoryContext(f.root, file);
  await f.git(["update-index", "--refresh"]); assert.equal((await readFileHistoryContext(f.root, file)).key, initial.key);
  const included = path.join(f.directory, "included.cfg"); await writeFile(included, "[diff]\n  algorithm = minimal\n");
  await f.git(["config", "include.path", included]); const configured = await readFileHistoryContext(f.root, file);
  assert.notEqual(configured.key, initial.key); assert.equal(configured.revision, initial.revision);
  await writeFile(included, "[diff]\n  algorithm = patience\n"); const replacedConfig = await readFileHistoryContext(f.root, file);
  assert.notEqual(replacedConfig.key, configured.key);
  await writeFile(path.join(f.root, ".gitattributes"), "*.ts binary\n"); const attributes = await readFileHistoryContext(f.root, file);
  assert.notEqual(attributes.key, replacedConfig.key);
  await f.git(["replace", initial.revision, await f.git(["rev-parse", "HEAD~1"])]);
  assert.notEqual((await readFileHistoryContext(f.root, file)).key, attributes.key);
});

test("linked worktree histories are bound to their Git directory and persisted snapshots keep all rename entries", async t => {
  const f = await repository(t), linked = path.join(f.directory, "linked"), store = new FileHistoryDiskStorage(path.join(f.directory, "cache"));
  await f.git(["worktree", "add", "-q", "-b", "linked-history", linked]);
  let cache = new FileHistoryReadCache(undefined, undefined, undefined, store); t.after(() => cache.dispose());
  const first = await cache.read(linked, "new name.ts"); assert.equal(first.commits.length, 3);
  assert.notEqual((await readFileHistoryContext(linked, "new name.ts")).key, (await readFileHistoryContext(f.root, "new name.ts")).key);
  await cache.dispose(); cache = new FileHistoryReadCache(undefined, undefined, undefined, store);
  const restored = await cache.read(linked, "new name.ts"); assert.equal(restored.source, "disk"); assert.deepEqual(immutable(restored.commits), immutable(first.commits));
});

test("an immutable revision keeps original history when HEAD moves and relative-date refresh does not walk older commits", async t => {
  const f = await repository(t), context = await readFileHistoryContext(f.root, "new name.ts"), service = new FileHistoryService(f.root);
  const original = await service.listFileHistory("new name.ts", 60, { revision: context.revision });
  await writeFile(path.join(f.root, "new name.ts"), "another\n"); await f.git(["add", "--", "new name.ts"]); await f.git(["commit", "-qm", "Move HEAD"]);
  const pinned = await service.listFileHistory("new name.ts", 60, { revision: context.revision }); assert.deepEqual(immutable(pinned), immutable(original));
  const dates = await service.refreshRelativeDates(pinned); assert.deepEqual(immutable(dates), immutable(original));
  assert.ok(dates.every(entry => /ago$/.test(entry.relativeDate)));
  assert.equal((await service.listFileHistory("new name.ts")).length, 4);
});
