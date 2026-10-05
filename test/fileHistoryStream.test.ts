import assert from "node:assert/strict";
import test from "node:test";
import { FileHistoryStream } from "../src/git/fileHistoryStream";
import { parseFileHistoryLog, type FileHistoryEntry } from "../src/git/fileHistoryService";

const marker = "\x1eGSC_FILE_HISTORY_COMMIT_V1\x1e";
const file = "새 경로\t[1].ts";
const oldFile = marker;
/** 제어 문자가 든 실제 경로와 UTF-8 메시지를 포함한 NUL native 레코드를 만든다. */
function record(hash: string, parent: string, title: string, payload: string[]) {
  return `\0${marker}\0${[hash.repeat(40), hash.repeat(7), parent.repeat(40), "작성자", "2026-10-06T12:00:00Z", "1 minute ago", title, `${title}\n\n본문 한글`].join("\0")}\0\0${payload.join("\0")}\0`;
}
const raw = record("3", "2", "최신 변경", [`\n:100644 100644 aaaaaaa bbbbbbb M`, file, `2\t1\t${file}`])
  + record("2", "1", "이름 변경", [`\n:100644 100644 aaaaaaa bbbbbbb R100`, oldFile, file, "0\t0\t", oldFile, file])
  + record("1", "", "처음 추가", [`\n:000000 100644 0000000 aaaaaaa A`, oldFile, `4\t0\t${oldFile}`]);
const expected = parseFileHistoryLog(raw, file);

test("every possible byte split preserves complete UTF-8 metadata, rename paths and numstat before publication", () => {
  const bytes = Buffer.from(raw);
  for (let split = 0; split <= bytes.length; split++) {
    const snapshots: FileHistoryEntry[][] = [];
    const stream = new FileHistoryStream(text => parseFileHistoryLog(text, file), entries => snapshots.push(entries));
    stream.push(bytes.subarray(0, split)); stream.push(bytes.subarray(split));
    assert.deepEqual(stream.finish(), expected);
    assert.equal(snapshots.length, 1);
    assert.deepEqual(snapshots[0], expected.slice(0, snapshots[0].length));
    assert.ok(snapshots[0].length > 0 && snapshots[0].length < expected.length);
  }
});

test("one-byte chunks publish one completed prefix, never a partially received last commit", () => {
  const snapshots: FileHistoryEntry[][] = [];
  const stream = new FileHistoryStream(text => parseFileHistoryLog(text, file), entries => snapshots.push(entries));
  for (const byte of Buffer.from(raw)) stream.push(Buffer.from([byte]));
  assert.equal(snapshots.length, 1); assert.deepEqual(snapshots[0], expected.slice(0, 1));
  assert.deepEqual(stream.finish(), expected);
});

test("observer mutation and failure cannot corrupt or fail the final complete history", () => {
  const stream = new FileHistoryStream(text => parseFileHistoryLog(text, file), entries => {
    entries[0].title = "observer changed this"; throw new Error("renderer failed");
  });
  stream.push(Buffer.from(raw)); assert.deepEqual(stream.finish(), expected);
});

test("empty output and a single commit have no incomplete preview and still return their complete result", () => {
  for (const output of ["", record("1", "", "one", [`\n:000000 100644 0000000 aaaaaaa A`, file, `1\t0\t${file}`])]) {
    let previews = 0;
    const stream = new FileHistoryStream(text => parseFileHistoryLog(text, file), () => previews++);
    stream.push(Buffer.from(output)); assert.deepEqual(stream.finish(), parseFileHistoryLog(output, file)); assert.equal(previews, 0);
  }
});
