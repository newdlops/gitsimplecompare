import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import test from "node:test";

/** 실제 행 의존성 모듈을 DOM 없이 읽는다. @returns graph payload마다 갱신할 독립 인덱스 */
function fixture() {
  const window: any = {};
  vm.runInNewContext(readFileSync(resolve("media/graph/graphRowSync.js"), "utf8"), { window });
  return window.GscGraphRowDependencies();
}

/** @param keys 변경된 표시 ref 키 @param hashes 원격 태그가 이동한 해시 @returns 실제 상태 모듈과 같은 영향 범위 */
function changes(keys: string[] = [], hashes: string[] = []) {
  return { keys: new Set(keys), hashes: new Set(hashes) };
}

test("unknown scopes keep full refresh and empty initialized scopes skip all rows", () => {
  const index = fixture();
  assert.equal(index.affected(changes()), undefined);
  index.update([]);
  assert.equal(index.affected(null), undefined);
  assert.equal(index.affected({ keys: new Set() }), undefined);
  assert.equal(index.affected(changes(["branch:absent"], ["absent"])).size, 0);
});

test("branch changes reach tips and local-only ancestors without matching similar branch names", () => {
  const index = fixture();
  index.update([
    { hash: "tip", refs: ["HEAD", "topic"] },
    { hash: "ancestor", localOnlyBranches: ["main", "topic"] },
    { hash: "other", refs: ["topic/child"] },
    { hash: "other-ancestor", localOnlyBranches: ["topic/child"] },
  ]);
  assert.deepEqual([...index.affected(changes(["branch:topic"]))], [0, 1]);
  assert.deepEqual([...index.affected(changes(["branch:topic/child"]))], [2, 3]);
});

test("tag names select explicit badges and old/new hashes select injected remote badges including duplicate hashes", () => {
  const index = fixture();
  index.update([
    { hash: "local", refs: ["tag:release/v1"] },
    { hash: "other", refs: ["remote-tag:origin/release/v1"] },
    { hash: "raw", refs: ["remote-tag:release"] },
    { hash: "old" }, { hash: "new" }, { hash: "new" },
    { hash: "collision", refs: ["release/v1"] },
  ]);
  assert.deepEqual([...index.affected(changes(["tag:release/v1"], ["old", "new"]))].sort(), [0, 1, 3, 4, 5]);
  assert.deepEqual([...index.affected(changes(["tag:release"]))], [2]);
  assert.deepEqual([...index.affected(changes(["branch:release/v1"]))], [6]);
});

test("every graph model replaces the dependency index after reorder, pagination and clearing", () => {
  const index = fixture(), first = { hash: "first", refs: ["topic"] }, second = { hash: "second" };
  index.update([first, second]);
  index.update([second, first, { hash: "third", localOnlyBranches: ["topic"] }]);
  assert.deepEqual([...index.affected(changes(["branch:topic"]))], [1, 2]);
  index.update([second]);
  assert.equal(index.affected(changes(["branch:topic"], ["first", "third"])).size, 0);
  index.update([]); assert.equal(index.affected(changes([], ["second"])).size, 0);
});

test("worktree and branch scopes combine while any unknown scope preserves a full refresh", () => {
  const index = fixture();
  index.update([{ hash: "a", refs: ["main"] }, { hash: "b", refs: ["topic"] }]);
  assert.deepEqual([...index.affected(changes(["branch:main"]), changes(["branch:topic"]))], [0, 1]);
  assert.equal(index.affected(changes(), changes(["branch:topic"])).size, 1);
  assert.equal(index.affected(changes(), undefined).size, 0);
  assert.equal(index.affected(changes(), null), undefined);
});

test("small deltas update only changed dependencies and remove obsolete branch, tag and hash entries", () => {
  const index = fixture(); let refReads = 0;
  const rows = Array.from({ length: 5000 }, (_, position) => ({ hash: `hash-${position}`,
    get refs() { refReads++; return position === 1 ? ["old", "tag:old"] : []; } }));
  index.update(rows); refReads = 0;
  const changed = { hash: "replacement", refs: ["new", "remote-tag:origin/new"], localOnlyBranches: ["ancestor"] };
  const next = rows.map((row, position) => position === 1 ? changed : row);
  index.update(next, { rowStart: rows.length, rows: [], rowUpdates: [{ index: 1, row: changed }] });
  assert.ok(refReads <= 2, `unchanged refs read ${refReads} times`);
  assert.equal(index.affected(changes(["branch:old", "tag:old"], ["hash-1"])).size, 0);
  assert.deepEqual([...index.affected(changes(["branch:new", "tag:new", "branch:ancestor"], ["replacement"]))], [1]);
  const appended = { hash: "appended", refs: ["new"] };
  index.update([...next, appended], { rowStart: next.length, rows: [appended], rowUpdates: [] });
  assert.deepEqual([...index.affected(changes(["branch:new"]))], [1, 5000]);
  index.update([appended]);
  assert.deepEqual([...index.affected(changes(["branch:new"]))], [0]);
  assert.equal(index.affected(changes([], ["replacement"])).size, 0);
});
