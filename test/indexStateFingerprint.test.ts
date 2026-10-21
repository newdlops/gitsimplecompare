import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readIndexStateFingerprint } from "../src/git/indexStateFingerprint";

/** 이전 버전이 실제 저장하던 UTF-8 해시와 stage 판정을 독립 기준으로 재현한다. */
function legacy(bytes: Buffer) {
  const text = bytes.toString("utf8");
  return { index: createHash("sha256").update(text).digest("hex"), unmerged: text.split("\0").some(entry => /^\d+ [a-f0-9]+ [123]\t/.test(entry)) };
}
/** 주어진 바이트를 지정 경계로 전달해 Native chunk가 임의 위치에서 끊기는 경우를 검증한다. */
function read(bytes: Buffer, split: number) {
  return readIndexStateFingerprint("/unused", async (args, _root, create) => {
    const reader = create();
    assert.deepEqual(args, ["-c", "core.fsmonitor=false", "ls-files", "--stage", "-z"]);
    reader.onData(bytes.subarray(0, split)); reader.onData(bytes.subarray(split)); return reader.finish();
  });
}

test("index fingerprints preserve legacy UTF-8 bytes and all stage decisions at every chunk boundary", async () => {
  const bytes = Buffer.concat([Buffer.from(`100644 ${"a".repeat(40)} 0\t한글 😀\n\tfile\0`),
    ...[1, 2, 3].map(stage => Buffer.from(`100755 ${"b".repeat(64)} ${stage}\tconflict-${stage}\0`)),
    Buffer.from(`120000 ${"0".repeat(40)} 0\tinvalid-`), Buffer.from([0xc3, 0x28, 0xf0, 0x9f]), Buffer.from("\0")]);
  const expected = legacy(bytes);
  for (let split = 0; split <= bytes.length; split++) assert.deepEqual(await read(bytes, split), expected, `split ${split}`);
});

test("empty, sparse directory, intent-to-add and ordinary stage-0 indexes remain merged", async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from(`040000 ${"a".repeat(40)} 0\tsparse/\0`),
    Buffer.from(`100644 ${"0".repeat(40)} 0\tintent-to-add\0`)]) assert.deepEqual(await read(bytes, 5), legacy(bytes));
});

test("a large path is hashed without becoming header or record state", async () => {
  const header = Buffer.from(`100644 ${"b".repeat(40)} 0\t`), body = Buffer.alloc(1024 * 1024, 120);
  const bytes = Buffer.concat([header, body, Buffer.from("\0")]);
  const value = await readIndexStateFingerprint("/unused", async (_args, _root, create) => {
    const reader = create(); reader.onData(header);
    for (let offset = 0; offset < body.length; offset += 4096) reader.onData(body.subarray(offset, offset + 4096));
    reader.onData(Buffer.from("\0")); return reader.finish();
  });
  assert.deepEqual(value, legacy(bytes));
});

test("failed Native output never yields a partial fingerprint", async () => {
  const failure = new Error("Native read failed after output");
  await assert.rejects(() => readIndexStateFingerprint("/unused", async (_args, _root, create) => {
    create().onData(Buffer.from(`100644 ${"a".repeat(40)} 1\tconflict\0`)); throw failure;
  }), error => error === failure);
});

test("truncated, malformed and oversized headers cannot become a completed Undo state", async () => {
  for (const text of [`100644 ${"a".repeat(40)} 0\tfile`, `100644 ${"a".repeat(40)} 0\t\0`,
    `100644 ${"a".repeat(40)} 4\tfile\0`, `100644 ${"a".repeat(40)} 0\0`, "x".repeat(81)]) {
    await assert.rejects(() => read(Buffer.from(text), 15), /incomplete or invalid stage output/);
  }
  const highBit = Buffer.from(`100644 ${"a".repeat(40)} 0\tfile\0`); highBit[0] |= 128;
  await assert.rejects(() => read(highBit, 10), /incomplete or invalid stage output/);
});
