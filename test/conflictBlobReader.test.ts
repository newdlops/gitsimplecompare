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

/** Git 응답을 한 바이트씩 분할해도 빈 blob·UTF-8·본문 안의 가짜 헤더를 정확히 구분한다. */
test("one batch preserves byte framing, UTF-8 and empty blobs across every stream boundary", async t => {
  const { root } = await safetyFixture(t, "conflict-blob-batch");
  const file = join(root, "blob.txt"), reader = new ConflictBlobReader();
  const contents = ["", "한글🙂\n" + "a".repeat(40) + " blob 5\nhello\n", "third stage\n"];
  const oids: string[] = [];
  for (const content of contents) { await writeFile(file, content); oids.push(await git(root, "hash-object", "-w", file)); }
  const original = childProcess.spawn; let calls = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    calls++;
    const child = (original as Function)(...args), emit = child.stdout.emit;
    child.stdout.emit = function (event: string, ...values: any[]) {
      if (event !== "data" || !Buffer.isBuffer(values[0])) return emit.call(this, event, ...values);
      for (const byte of values[0]) emit.call(this, event, Buffer.from([byte]));
      return true;
    };
    return child;
  });
  const values = await reader.readMany(root, [...oids, oids[1]]);
  for (let index = 0; index < oids.length; index++) assert.equal(values.get(oids[index])?.content, contents[index]);
  assert.equal(calls, 1);
  values.get(oids[1])!.content = "consumer edit";
  assert.equal((await reader.readMany(root, oids)).get(oids[1])?.content, contents[1]);
  assert.equal(calls, 1);
});

/** 한 stage의 다른 소비자가 남아 있으면 문서 전체 취소도 같은 배치를 중단하지 않는다. */
test("cancelling a batch consumer preserves another editor reading a different stage", async t => {
  const { root, head } = await safetyFixture(t, "conflict-blob-batch-cancel");
  const first = await git(root, "rev-parse", `${head}:tracked.txt`), file = join(root, "other.txt");
  await writeFile(file, "other stage\n"); const second = await git(root, "hash-object", "-w", file);
  const reader = new ConflictBlobReader(), controller = new AbortController();
  const cancelled = reader.readMany(root, [first, second], controller.signal);
  const retained = reader.read(root, second);
  const rejection = assert.rejects(cancelled, { name: "AbortError" }); controller.abort();
  await rejection;
  assert.equal((await retained).content, "other stage\n");
  assert.equal((await reader.read(root, first)).content, "base\n");
});

/** 배치 뒤쪽의 missing 객체가 있으면 앞쪽 미리보기도 완료된 cache로 게시하지 않는다. */
test("a partial batch failure cannot publish a cache entry or leak an unhandled rejection", async t => {
  const { root, head } = await safetyFixture(t, "conflict-blob-batch-missing");
  const oid = await git(root, "rev-parse", `${head}:tracked.txt`), reader = new ConflictBlobReader();
  const original = childProcess.spawn; let calls = 0;
  t.mock.method(childProcess, "spawn", (...args: any[]) => { calls++; return (original as Function)(...args); });
  await assert.rejects(reader.readMany(root, [oid, "f".repeat(40)]));
  assert.equal(calls, 1);
  assert.equal((await reader.read(root, oid)).content, "base\n");
  assert.equal(calls, 2);
});
