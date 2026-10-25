// lane 색상 집합 표현이 바뀌어도 기존의 16색 경계와 포화 시 색상 순서를 유지한다.
import assert from "node:assert/strict";
import test from "node:test";
import { layoutGraph } from "../src/graph/graphLayout";
import type { Commit } from "../src/graph/graphTypes";

/**
 * 한 merge에서 나뉜 형제 이력이 마지막 base에서 합쳐지는 실제 topo 순서를 만든다.
 * @param lanes 동시에 유지할 형제 lane 수. 16색 경계와 초과 상태를 함께 검사한다.
 * @returns 첫 merge·lane별 커밋·공통 base로 구성된 독립 합성 커밋 배열
 */
function parallelHistory(lanes: number): Commit[] {
  return Array.from({ length: lanes + 2 }, (_, row) => ({
    hash: `c${row}`,
    parents: row === 0 ? Array.from({ length: lanes }, (_, index) => `c${index + 1}`)
      : row <= lanes ? [`c${lanes + 1}`] : [],
    refs: row === 0 ? ["HEAD", "main"] : [],
    authorName: "Fixture", authorEmail: "fixture@example.test",
    dateIso: "2026-01-01T00:00:00Z", subject: `Commit ${row}`,
  }));
}

for (const lanes of [15, 16, 17, 32]) {
  test(`${lanes} parallel lanes preserve canonical colors across the 16-family boundary`, () => {
    const input = parallelHistory(lanes), data = layoutGraph(input);
    // 배포된 Set 기반 구현의 공개 결과다. mask 자체의 연산을 기대값으로 복제하지 않는다.
    const expected = [0, ...Array.from({ length: lanes }, (_, index) => index), 0];
    assert.deepEqual(data.rows.map(row => row.color), expected);
    assert.deepEqual(data.rows.map(row => row.column), expected);
    assert.equal(data.laneCount, lanes);
    assert.equal(data.edges.length, lanes * 2);
    assert.deepEqual(data.rows.map(row => row.hash), input.map(commit => commit.hash));
  });
}
