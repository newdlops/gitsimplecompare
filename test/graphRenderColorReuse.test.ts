import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

/** 실제 웹뷰의 색상 재사용 판정 함수를 DOM 없이 실행한다. @returns 테스트마다 독립적인 모듈 API */
function fixture() {
  const window: any = { addEventListener() {} };
  vm.runInNewContext(readFileSync(resolve("media/graph/graphDataUpdates.js"), "utf8"), { window });
  return window.GscGraphDataUpdates;
}

test("only metadata deltas with unchanged color inputs reuse the previous color resolver", () => {
  const api = fixture();
  const row = { hash: "one", refs: ["HEAD", "topic", "tag:v1"], parents: ["two"], localOnlyBranches: ["topic"], color: 1, column: 0 };
  const previous = { rows: [row], edges: [{ fromRow: 0, toRow: 1 }], laneCount: 1 };
  const nextRow = { ...row, refs: ["topic", "tag:v1"], subject: "updated" };
  const next = { ...previous, rows: [nextRow] };
  const delta = { rows: [], edges: [], rowUpdates: [{ index: 0, row: nextRow }], edgeUpdates: [] };
  assert.equal(api.reusableColors(delta, previous, next), true);
  assert.equal(api.reusableColors(undefined, previous, next), false);
  for (const patch of [{ hash: "new" }, { column: 2 }, { color: 3 }, { originalColumn: 7 }, { compacted: true }, { kind: "staged" },
    { parents: ["different"] }, { refs: ["other", "tag:v1"] }, { localOnlyBranches: ["other"] }]) {
    const changed = { ...nextRow, ...patch };
    assert.equal(api.reusableColors({ ...delta, rowUpdates: [{ index: 0, row: changed }] }, previous, { ...next, rows: [changed] }), false);
  }
  assert.equal(api.reusableColors(delta, previous, { ...next, laneCount: 2 }), false);
  assert.equal(api.reusableColors({ ...delta, rows: [row] }, previous, { ...next, rows: [nextRow, row] }), false);
  assert.equal(api.reusableColors({ ...delta, edges: [{}] }, previous, next), false);
  assert.equal(api.reusableColors({ ...delta, edgeUpdates: [{ index: 0, edge: {} }] }, previous, next), false);
});
