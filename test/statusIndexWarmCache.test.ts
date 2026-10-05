import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { StatusIndexWarmCache, type WarmCacheLimits } from "../src/git/statusIndexWarmCache";

/** 저장 공간만 검사하는 fixture이며 사용자 Git 디렉터리는 접근하지 않는다. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gsc-warm-cache-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "storage"), index = path.join(root, "index");
  const bytes = Buffer.alloc(96, 7); bytes.write("DIRC"); bytes.writeUInt32BE(2, 4); bytes.writeUInt32BE(0, 8);
  await writeFile(index, bytes);
  return { root, directory, index, bytes };
}

/** 저장소 경로 대신 해시만 포함하는 캐시 파일의 실제 내용을 검사한다. */
function cacheFile(directory: string, root: string): string {
  return path.join(directory, `${createHash("sha256").update(path.resolve(root)).digest("hex")}.cache`);
}

test("warm cache restores only a matching real index identity with private file permissions", async t => {
  const f = await fixture(t), cache = new StatusIndexWarmCache(f.directory);
  assert.equal(await cache.load(f.root, "source"), undefined);
  assert.equal(await cache.store(f.root, "source", f.index), true);
  const restored = await new StatusIndexWarmCache(f.directory).load(f.root, "source");
  assert.deepEqual(restored?.bytes, f.bytes);
  assert.equal(restored?.mtimeMs, (await lstat(f.index)).mtimeMs);
  assert.equal(await cache.load(f.root, "changed-source"), undefined);
  assert.equal(await cache.load(f.root + "-linked", "source"), undefined);
  if (process.platform !== "win32") {
    assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(cacheFile(f.directory, f.root))).mode & 0o777, 0o600);
  }
});

test("corrupted, oversized, malformed and expired envelopes are safe cache misses", async t => {
  const f = await fixture(t), cache = new StatusIndexWarmCache(f.directory);
  await cache.store(f.root, "source", f.index);
  const file = cacheFile(f.directory, f.root), valid = await readFile(file);
  const corrupt = Buffer.from(valid); corrupt[corrupt.length - 1] ^= 1;
  const excessiveHeader = Buffer.from(valid); excessiveHeader.writeUInt32BE(0xffffffff);
  for (const invalid of [Buffer.from("x"), corrupt, excessiveHeader, Buffer.concat([valid, Buffer.from("extra")])]) {
    await writeFile(file, invalid);
    assert.equal(await cache.load(f.root, "source"), undefined);
  }
  await writeFile(file, valid);
  const old = new Date(Date.now() - 8 * 86400 * 1000); await utimes(file, old, old);
  assert.equal(await cache.load(f.root, "source"), undefined);
});

test("cache failure and a disposed output logger cannot alter a successful Git result", async t => {
  const f = await fixture(t);
  const cache = new StatusIndexWarmCache(f.directory, () => { throw new Error("output disposed"); });
  assert.equal(await cache.store(f.root, "source", f.index), true);
  assert.deepEqual((await cache.load(f.root, "source"))?.bytes, f.bytes);
  await writeFile(cacheFile(f.directory, f.root), Buffer.from([0, 0, 0, 1, 0xff]));
  assert.equal(await cache.load(f.root, "source"), undefined);
  await writeFile(path.join(f.root, "not-a-directory"), "occupied");
  const unavailable = new StatusIndexWarmCache(path.join(f.root, "not-a-directory", "child"), () => { throw new Error("output disposed"); });
  assert.equal(await unavailable.store(f.root, "source", f.index), false);
  assert.equal(await unavailable.load(f.root, "source"), undefined);
});

test("simultaneous host publication exposes a complete old or new envelope and leaves no temporary files", async t => {
  const f = await fixture(t), other = path.join(f.root, "other-index");
  const next = Buffer.from(f.bytes); next[next.length - 1] = 9; await writeFile(other, next);
  const hosts = [new StatusIndexWarmCache(f.directory), new StatusIndexWarmCache(f.directory)];
  for (let round = 0; round < 8; round++) {
    await Promise.all([hosts[0].store(f.root, "source", f.index), hosts[1].store(f.root, "source", other)]);
    const loaded = await hosts[0].load(f.root, "source");
    assert.ok(loaded && (loaded.bytes.equals(f.bytes) || loaded.bytes.equals(next)));
  }
  assert.equal((await readdir(f.directory)).length, 1);
});

test("count, byte, age and entry limits bound persistent disk usage", async t => {
  const f = await fixture(t);
  const limits: WarmCacheLimits = { maxFiles: 2, maxBytes: 500, maxEntryBytes: 100, maxAgeMs: 60000 };
  const cache = new StatusIndexWarmCache(f.directory, undefined, limits);
  for (let round = 0; round < 8; round++) assert.equal(await cache.store(`${f.root}/${round}`, "source", f.index), true);
  const files = await readdir(f.directory), sizes = await Promise.all(files.map(file => lstat(path.join(f.directory, file))));
  assert.ok(files.length <= 2); assert.ok(sizes.reduce((sum, info) => sum + info.size, 0) <= limits.maxBytes);
  const expired = path.join(f.directory, files[0]), old = new Date(Date.now() - 120000); await utimes(expired, old, old);
  await cache.store(`${f.root}/latest`, "source", f.index);
  await assert.rejects(lstat(expired), { code: "ENOENT" });
  await writeFile(f.index, Buffer.alloc(101));
  assert.equal(await cache.store(f.root, "source", f.index), false);
  assert.equal(await cache.load(f.root, "source"), undefined);
});

test("cleanup removes abandoned owned publications and preserves fresh, unrelated and symlink files", async t => {
  const f = await fixture(t); await mkdir(f.directory);
  const ownedName = `${"a".repeat(64)}.cache.${randomUUID()}.tmp`;
  const freshName = `${"b".repeat(64)}.cache.${randomUUID()}.tmp`;
  const unrelated = "user-notes.tmp", link = `${"c".repeat(64)}.cache`;
  for (const name of [ownedName, freshName, unrelated]) await writeFile(path.join(f.directory, name), "keep or expire");
  await symlink(f.index, path.join(f.directory, link));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000); await utimes(path.join(f.directory, ownedName), old, old);
  assert.equal(await new StatusIndexWarmCache(f.directory).store(f.root, "source", f.index), true);
  await assert.rejects(lstat(path.join(f.directory, ownedName)), { code: "ENOENT" });
  for (const name of [freshName, unrelated, link]) assert.ok(await lstat(path.join(f.directory, name)));
  assert.deepEqual(await readFile(f.index), f.bytes);
});

test("symlink storage and cache entries are rejected without modifying the target", async t => {
  const f = await fixture(t), outside = path.join(f.root, "outside"); await mkdir(outside);
  await symlink(outside, f.directory);
  const cache = new StatusIndexWarmCache(f.directory);
  assert.equal(await cache.store(f.root, "source", f.index), false);
  assert.equal(await cache.load(f.root, "source"), undefined);
  assert.deepEqual(await readdir(outside), []);
  await rm(f.directory); await mkdir(f.directory);
  await symlink(f.index, cacheFile(f.directory, f.root));
  assert.equal(await cache.load(f.root, "source"), undefined);
  assert.deepEqual(await readFile(f.index), f.bytes);
});
