import assert from "node:assert/strict";
import test from "node:test";
import { summarizeFileBlame } from "../src/git/blockBlameBatch";
import { summarizeBlockBlame, type SourceBlock } from "../src/git/blockBlameModel";
import type { GitBlameLine } from "../src/git/blameService";

/** 범위 탐색과 기존 집계 결과를 비교할 실제 형태의 blame 레코드를 만든다. */
function blame(line: number): GitBlameLine {
  return { line, commit: String(line % 2).repeat(40), authorName: line % 2 ? "Alice" : "Bob",
    authorMail: line % 2 ? "alice@example.test" : "bob@example.test", authorTime: line,
    summary: `change ${line}`, filename: "example.ts", content: line % 3 ? `code ${line}` : " " };
}

/** 부모와 중첩 함수 등 서로 다른 inclusive 범위를 가진 블록을 만든다. */
function block(startLine: number, endLine: number): SourceBlock {
  return { id: `${startLine}:${endLine}`, name: "example", kind: "function", declarationLine: startLine, startLine, endLine };
}

test("indexed batch matches existing summaries for shuffled, sparse and overlapping blame", () => {
  const lines = [blame(8), blame(2), blame(5), blame(1), blame(2), blame(10)];
  const blocks = [block(1, 10), block(2, 5), block(3, 4), block(8, 8), block(12, 15), block(2.9, 1), block(-1, 2)];
  const before = [...lines];
  assert.deepEqual(summarizeFileBlame(blocks, lines), blocks.map(value => summarizeBlockBlame(value, lines)));
  assert.deepEqual(lines, before, "indexing must not reorder the caller's blame array");
});

test("empty and whitespace-only files preserve the existing contributor rules", () => {
  const blocks = [block(1, 3), block(1, 1)];
  for (const lines of [[], [blame(3), blame(6)]]) {
    assert.deepEqual(summarizeFileBlame(blocks, lines), blocks.map(value => summarizeBlockBlame(value, lines)));
  }
});

test("400 small blocks index a 50,000-line file once rather than scanning it per block", () => {
  let reads = 0;
  const lines = Array.from({ length: 50_000 }, (_, index) => {
    const value = blame(index + 1);
    Object.defineProperty(value, "line", { get: () => { reads++; return index + 1; } });
    return value;
  });
  const blocks = Array.from({ length: 400 }, (_, index) => block(index * 100 + 1, index * 100 + 20));
  const result = summarizeFileBlame(blocks, lines);
  assert.equal(result.length, 400);
  assert.equal(result[399].lines.length, 20);
  assert.ok(reads < 200_000, `expected one index pass and bounded block lookups, received ${reads} line reads`);
});
