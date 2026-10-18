import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { buildRebaseTodoProgress } from "../src/git/rebaseTodoProgress";

/** 표시할 열 행을 만들 때 전체 대형 todo를 읽고 세는 비용을 측정한다. 시간 자체는 실패 조건으로 삼지 않는다. */
test("a hundred thousand todo lines retain exact counts and a ten-row progress window", t => {
  const hash = (index: number) => index.toString(16).padStart(40, "0");
  const current = "f".repeat(40);
  const done = Array.from({ length: 50_000 }, (_, index) => `pick ${hash(index + 1)} done  ${index}  한글`).join("\n")
    + `\nedit ${current} current heading\n`;
  const remaining = Array.from({ length: 50_000 }, (_, index) => `pick ${hash(index + 100_000)} next  ${index}  한글`).join("\n");
  const started = performance.now();
  for (let index = 0; index < 5; index++) {
    const progress = buildRebaseTodoProgress(done, remaining, current);
    assert.equal(progress.done, 50_001);
    assert.equal(progress.remaining, 50_000);
    assert.equal(progress.total, 100_001);
    assert.equal(progress.currentHash, current);
    assert.equal(progress.currentSubject, "current heading");
    assert.equal(progress.items.find(item => item.role === "current")?.action, "edit");
    assert.equal(progress.nextHash, hash(100_000));
    assert.equal(progress.items.length, 10);
    assert.deepEqual(progress.items.map(item => item.index), Array.from({ length: 10 }, (_, index) => 49_998 + index));
    assert.equal(progress.items[0].subject, "done 49997 한글");
    assert.equal(progress.omittedItemCount, 99_991);
  }
  t.diagnostic(`100,001 lines × 5: ${(performance.now() - started).toFixed(1)} ms`);
});

test("comments, CRLF, abbreviated actions and short commit hashes preserve their progress labels", () => {
  const p = buildRebaseTodoProgress("# comment\r\n p aaaa original  subject \r\n", "\r\ns bbbb next\tsubject\r\n", "aaaa" + "0".repeat(36));
  assert.equal(p.done, 1); assert.equal(p.remaining, 1); assert.equal(p.currentHash, "aaaa");
  assert.equal(p.currentSubject, "original subject"); assert.equal(p.nextSubject, "next subject");
  assert.deepEqual(p.items.map(item => [item.role, item.index, item.action, item.hash, item.subject]), [
    ["current", 1, "pick", "aaaa", "original subject"], ["remaining", 2, "squash", "bbbb", "next subject"],
  ]);
});

test("directive-only todo retains the final current action and the first remaining directive", () => {
  const p = buildRebaseTodoProgress("label first\nx echo keep  this\n", "label later\nbreak\n");
  assert.equal(p.currentHash, undefined); assert.equal(p.currentSubject, "keep this");
  assert.equal(p.nextHash, undefined); assert.equal(p.nextSubject, undefined);
  assert.deepEqual(p.items.map(item => [item.role, item.index, item.action, item.subject]), [
    ["done", 1, "label", undefined], ["current", 2, "exec", "keep this"],
    ["remaining", 3, "label", undefined], ["remaining", 4, "break", undefined],
  ]);
});

test("the first matching duplicate hash and later noncommit directives preserve the original current selection", () => {
  for (const suffix of ["p bbbb last copy\n", "x echo command\nt label\n"]) {
    const p = buildRebaseTodoProgress("p aaaa first\ne bbbb actual\n" + suffix, "");
    assert.equal(p.currentHash, "bbbb"); assert.equal(p.currentSubject, "actual");
    assert.equal(p.items.find(item => item.role === "current")?.action, "edit");
    assert.deepEqual(p.items.filter(item => item.role === "done").map(item => item.hash), ["aaaa"]);
    assert.equal(p.omittedItemCount, 0);
  }
});

test("an original hash absent from done keeps a synthetic current row and the preceding done window", () => {
  const p = buildRebaseTodoProgress("p aaaa earlier\ne bbbb previous\n", "", "cccc");
  assert.equal(p.currentHash, "cccc"); assert.equal(p.currentSubject, undefined);
  assert.deepEqual(p.items.map(item => [item.role, item.index, item.action, item.hash]), [
    ["done", 1, "pick", "aaaa"], ["current", 2, "pick", "cccc"],
  ]);
});

test("next commit lookup scans beyond the visible window without losing hidden directive counts", () => {
  const directives = Array.from({ length: 11 }, (_, index) => `label target${index}`).join("\n");
  const p = buildRebaseTodoProgress("", directives + "\np bbbb deep next\n", "cccc");
  assert.equal(p.nextHash, "bbbb"); assert.equal(p.nextSubject, "deep next");
  assert.equal(p.done, 0); assert.equal(p.remaining, 12); assert.equal(p.items.length, 10);
  assert.equal(p.omittedItemCount, 3);
});

test("empty and SHA-256 prefix progress keep the same source and item boundaries", () => {
  const empty = buildRebaseTodoProgress("# only comments\n", "\n");
  assert.equal(empty.total, 0); assert.deepEqual(empty.items, []); assert.equal(empty.omittedItemCount, 0);
  const short = "1234567890abcdef";
  const p = buildRebaseTodoProgress(`e ${short} original\n`, "", short + "0".repeat(48));
  assert.equal(p.currentHash, short); assert.equal(p.currentSubject, "original");
  assert.equal(p.items[0].action, "edit");
});

test("selected fields preserve all UTF-16 code units when detached from large input strings", () => {
  const subject = "한글🙂\uD800 value\u0000tail";
  const p = buildRebaseTodoProgress(`pick aaaa ${subject}\n`, "", "aaaa");
  assert.equal(p.currentSubject, subject);
});
