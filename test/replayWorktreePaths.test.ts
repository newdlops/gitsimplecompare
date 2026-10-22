import assert from "node:assert/strict";
import test from "node:test";
import { ReplayWorktreePathReader } from "../src/git/replayWorktreePaths";

const oid = "a".repeat(40);

test("compact replay paths preserve Native bytes across every chunk boundary", () => {
  const names = [Buffer.from("공백\t줄\n바꿈.txt"), Buffer.from([0x62,0x61,0x64,0xff,0x2e,0x74,0x78,0x74])];
  const input = Buffer.concat(names.flatMap((name, index) => [Buffer.from(`${index ? "120000" : "100644"} ${oid} 0\t`), name, Buffer.from([0])]));
  const expected = Buffer.concat(names.flatMap(name => [name, Buffer.from([0])]));
  for (let at = 0; at <= input.length; at++) {
    const reader = new ReplayWorktreePathReader("stage");
    reader.onData(input.subarray(0, at)); reader.onData(input.subarray(at));
    assert.deepEqual(reader.finish(), { input: expected, count: 2 });
  }
});

test("only S paths are materialized while ordinary deletions and unmerged entries stay untouched", () => {
  const reader = new ReplayWorktreePathReader("skipped");
  for (const byte of Buffer.from("H removed-by-user\0M conflict\0M conflict\0S unchanged\0")) reader.onData(Buffer.from([byte]));
  assert.deepEqual(reader.finish(), { input: Buffer.from("unchanged\0"), count: 1 });
});

for (const row of [`160000 ${oid} 0\tmodule\0`, `040000 ${oid} 0\tsparse/\0`, `100644 ${oid} 2\tunmerged\0`])
  test(`unsupported compact index entries fall back as a whole: ${row.slice(0, 6)}`, () => {
    const reader = new ReplayWorktreePathReader("stage");
    reader.onData(Buffer.from(`100644 ${oid} 0\tvalid\0${row}`));
    assert.equal(reader.finish(), undefined);
  });

test("path count and byte bounds discard earlier valid paths instead of publishing a partial index", () => {
  for (const reader of [new ReplayWorktreePathReader("skipped", 5), new ReplayWorktreePathReader("skipped", 1024, 1)]) {
    reader.onData(Buffer.from("S one\0S two\0")); reader.onData(Buffer.from("S ignored\0"));
    assert.equal(reader.finish(), undefined);
  }
  const reader = new ReplayWorktreePathReader("stage"); reader.onData(Buffer.alloc(17 * 1024, 65));
  assert.equal(reader.finish(), undefined);
});

test("truncated or malformed Native records cannot become index update input", () => {
  for (const input of [`100644 ${oid} 0\tmissing-nul`, "broken\0", `100644 ${oid} 0\t\0`]) {
    const reader = new ReplayWorktreePathReader("stage");
    assert.throws(() => { reader.onData(Buffer.from(input)); reader.finish(); }, /incomplete or invalid/);
  }
});

test("retained paths own their bytes after the stdout buffer is reused", () => {
  const chunk = Buffer.from(`100644 ${oid} 0\tkeep\0`), reader = new ReplayWorktreePathReader("stage");
  reader.onData(chunk); chunk.fill(0);
  assert.deepEqual(reader.finish(), { input: Buffer.from("keep\0"), count: 1 });
});
