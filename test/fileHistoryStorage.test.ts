import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { FileHistoryDiskStorage } from "../src/git/fileHistoryStorage";
import type { FileHistoryEntry } from "../src/git/fileHistoryService";

/** 저장공간 검사에서 쓰는 전체/유효 이력 하나다. */
function commits(message = "Commit"): FileHistoryEntry[] {
  return [{ hash: "a".repeat(40), shortHash: "aaaaaaa", baseRef: "b".repeat(40), title: "Commit", message,
    author: "Author", dateIso: "2026-10-06T00:00:00Z", relativeDate: "1 hour ago", status: "M", path: "file.ts", additions: 1, deletions: 0 }];
}

/** 다른 파일을 침범하지 않는 전용 임시 디렉터리와 실제 저장 구현을 만든다. */
async function storage(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "gsc-history-storage-")); t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new FileHistoryDiskStorage(directory) };
}

test("persistent history requires the exact version, hash, schema and valid commit metadata", async t => {
  const f = await storage(t), original = commits();
  await f.store.store("/repo", "file.ts", "v1", original, Date.now());
  assert.equal((await f.store.load("/repo", "file.ts", "v1"))!.commits[0].message, "Commit");
  assert.equal(await f.store.load("/repo", "file.ts", "v2"), undefined);
  const saved = path.join(f.directory, (await readdir(f.directory))[0]), bytes = await readFile(saved);
  const corrupted = JSON.parse(bytes.toString()); corrupted.commits[0].message = "Corrupt";
  await writeFile(saved, JSON.stringify(corrupted)); assert.equal(await f.store.load("/repo", "file.ts", "v1"), undefined);
  corrupted.commits[0].hash = "not-a-git-object";
  corrupted.digest = createHash("sha256").update(JSON.stringify(corrupted.commits)).digest("hex");
  await writeFile(saved, JSON.stringify(corrupted)); assert.equal(await f.store.load("/repo", "file.ts", "v1"), undefined);
});

test("publication stays within forty files and eight MiB and rejects an oversized history", async t => {
  const f = await storage(t);
  for (let file = 0; file < 45; file++) await f.store.store("/repo", `file-${file}`, "v1", commits("x".repeat(260_000)), Date.now());
  const names = await readdir(f.directory); assert.ok(names.length <= 40);
  const sizes = await Promise.all(names.map(name => stat(path.join(f.directory, name))));
  assert.ok(sizes.reduce((total, info) => total + info.size, 0) <= 8 * 1024 * 1024);
  await f.store.store("/repo", "too-big", "v1", commits("x".repeat(1024 * 1024)), Date.now());
  assert.equal(await f.store.load("/repo", "too-big", "v1"), undefined);
  assert.ok(await f.store.load("/repo", "file-44", "v1"));
});

test("concurrent writers publish complete snapshots without retaining temporary publication files", async t => {
  const f = await storage(t), other = new FileHistoryDiskStorage(f.directory);
  await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? f.store : other).store("/repo", "file", "v1", commits(`Version ${index}`), Date.now())));
  const saved = await f.store.load("/repo", "file", "v1"); assert.match(saved!.commits[0].message, /^Version \d+$/);
  assert.equal((await readdir(f.directory)).length, 1);
  if (process.platform !== "win32") assert.equal((await stat(path.join(f.directory, (await readdir(f.directory))[0]))).mode & 0o777, 0o600);
});

test("only expired owned publication files are removed while fresh and unrelated files are retained", async t => {
  const f = await storage(t), prefix = "a".repeat(64);
  const old = `${prefix}.history.00000000-0000-0000-0000-000000000000.tmp`;
  const active = `${prefix}.history.11111111-1111-1111-1111-111111111111.tmp`;
  for (const file of [old, active, "unrelated.tmp"]) await writeFile(path.join(f.directory, file), "Keep unrelated data");
  const when = new Date(Date.now() - 2 * 3600_000); await utimes(path.join(f.directory, old), when, when);
  await f.store.store("/repo", "file", "v1", commits(), Date.now());
  const names = await readdir(f.directory); assert.ok(!names.includes(old)); assert.ok(names.includes(active)); assert.ok(names.includes("unrelated.tmp"));
});

test("leaf symlinks cannot restore or overwrite another file and storage symlinks cannot redirect cleanup", { skip: process.platform === "win32" }, async t => {
  const f = await storage(t); await f.store.store("/repo", "file", "v1", commits(), Date.now());
  const saved = path.join(f.directory, (await readdir(f.directory))[0]), outside = path.join(f.directory, "other-data");
  await writeFile(outside, "Unrelated data"); await rm(saved); await symlink(outside, saved);
  assert.equal(await f.store.load("/repo", "file", "v1"), undefined);
  await f.store.store("/repo", "file", "v1", commits(), Date.now()); assert.equal(await readFile(outside, "utf8"), "Unrelated data");
  const redirected = path.join(f.directory, "redirected"); await symlink(f.directory, redirected);
  const store = new FileHistoryDiskStorage(redirected); await store.store("/repo", "another", "v1", commits(), Date.now());
  assert.equal(await store.load("/repo", "file", "v1"), undefined);
});
