import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ConflictBlobReader, MAX_CONFLICT_TEXT_BYTES } from "../src/git/conflictBlobReader";
import { git, safetyFixture } from "./helpers/gitSafetyFixture";

/** 실제 immutable blob을 만들어 조회 공유, 캐시 격리, replace ref 영향을 함께 검증한다. */
test("immutable conflict previews share a read, return isolated values and ignore replacement refs", async t => {
  const { root } = await safetyFixture(t, "conflict-blob-cache");
  const file = join(root, "blob.txt"); await writeFile(file, "original\n");
  const oid = await git(root, "hash-object", "-w", file);
  await writeFile(file, "replacement\n");
  const other = await git(root, "hash-object", "-w", file);
  await git(root, "replace", oid, other);
  const spawn = childProcess.spawn; let reads = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => { reads++; return (spawn as Function)(...args); });
  const reader = new ConflictBlobReader();
  const [first, second] = await Promise.all([reader.read(root, oid), reader.read(root, oid)]);
  assert.equal(first.content, "original\n");
  first.content = "edited by consumer";
  assert.equal(second.content, "original\n");
  assert.equal((await reader.read(root, oid)).content, "original\n");
  assert.equal(reads, 1);
  assert.equal((await reader.read(root, other)).content, "replacement\n");
  assert.equal(reads, 2);
});

/** 미리보기 한도 밖의 NUL/invalid UTF-8도 검사하고 실패한 blob 조회는 재사용하지 않는다. */
test("binary bytes beyond the preview and missing objects cannot become cached text", async t => {
  const { root } = await safetyFixture(t, "conflict-blob-binary");
  const file = join(root, "blob.txt"), reader = new ConflictBlobReader();
  for (const tail of [Buffer.from([0]), Buffer.from([0xff]), Buffer.from([0xe3, 0x81])]) {
    await writeFile(file, Buffer.concat([Buffer.alloc(MAX_CONFLICT_TEXT_BYTES + 30, 97), tail]));
    const oid = await git(root, "hash-object", "-w", file);
    assert.deepEqual(await reader.read(root, oid), { kind: "binary", content: "" });
  }
  const missing = "f".repeat(40);
  await assert.rejects(reader.read(root, missing));
  await assert.rejects(reader.read(root, missing));
});

/** 기존 128MiB stdout 상한보다 큰 text도 512KiB 미리보기만 보존하며 읽을 수 있어야 한다. */
test("a 129 MiB blob is previewed without the buffered Git output limit", async t => {
  const { root } = await safetyFixture(t, "conflict-blob-large");
  const file = join(root, "large.txt"), handle = await open(file, "w");
  const chunk = Buffer.alloc(1024 * 1024, 97);
  try { for (let index = 0; index < 129; index++) await handle.write(chunk); }
  finally { await handle.close(); }
  const oid = await git(root, "hash-object", "-w", file);
  const preview = await new ConflictBlobReader().read(root, oid);
  assert.equal(preview.kind, "text"); assert.equal(preview.truncated, true);
  assert.equal(preview.content.length, MAX_CONFLICT_TEXT_BYTES);
});

/** 한 소비자가 취소돼도 다른 편집기가 공유하는 원본 조회는 완료되어야 한다. */
test("cancelling one blob consumer preserves the other consumer", async t => {
  const { root, head } = await safetyFixture(t, "conflict-blob-cancel");
  const oid = await git(root, "rev-parse", `${head}:tracked.txt`);
  const reader = new ConflictBlobReader(), controller = new AbortController();
  const cancelled = reader.read(root, oid, controller.signal), retained = reader.read(root, oid);
  const rejected = assert.rejects(cancelled, { name: "AbortError" }); controller.abort();
  await rejected;
  assert.equal((await retained).content, "base\n");
  await assert.rejects(reader.read(root, oid, controller.signal), { name: "AbortError" });
});

/** 마지막 소비자의 취소가 실제 자식 Git을 종료하고 새 조회를 막지 않는지 확인한다. */
test("last-consumer cancellation closes the Git process and a later read succeeds", async t => {
  const { root, head } = await safetyFixture(t, "conflict-blob-last-cancel");
  const oid = await git(root, "rev-parse", `${head}:tracked.txt`);
  const original = childProcess.spawn; let closed!: Promise<void>;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const child = (original as Function)(...args);
    closed = new Promise(resolve => child.once("close", resolve));
    return child;
  });
  const reader = new ConflictBlobReader(), controller = new AbortController();
  const pending = reader.read(root, oid, controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" }); controller.abort();
  await rejected; await closed;
  assert.equal((await reader.read(root, oid)).content, "base\n");
});
