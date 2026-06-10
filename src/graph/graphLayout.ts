// 커밋 DAG 를 그래프(레인/간선)로 배치하는 순수 레이아웃 모듈.
// - 입력은 "자식이 부모보다 먼저 오는" 순서의 커밋 배열(git log --topo-order 결과).
// - 레인 스윕(lane sweep) 방식으로 각 커밋의 열과 간선을 계산한다. vscode 비의존.
import { Commit, GraphData, GraphEdge, GraphRow } from "./graphTypes";

/**
 * 커밋 배열을 그래프 레이아웃(행/간선/레인 수)으로 변환한다.
 * - 위에서 아래로 훑으며 각 레인이 "도달을 기다리는 부모 해시"를 들고 있게 한다.
 * - 어떤 커밋에 도달하면 그 커밋을 기다리던 레인들이 합쳐지고(머지 입력),
 *   그 커밋의 부모들이 레인을 이어받거나(첫 부모) 새 레인으로 분기한다(추가 부모).
 * @param commits 자식→부모 순으로 정렬된 커밋 배열
 * @returns 웹뷰가 그릴 수 있는 GraphData
 */
export function layoutGraph(commits: Commit[]): GraphData {
  const indexByHash = new Map<string, number>();
  commits.forEach((c, i) => indexByHash.set(c.hash, i));

  const lanes: (string | null)[] = []; // 각 레인이 기다리는 부모 해시
  const laneColor: number[] = []; // 각 레인의 색상 인덱스
  let nextColor = 0;

  const rows: GraphRow[] = [];
  const edges: GraphEdge[] = [];
  let maxLanes = 0;

  for (let r = 0; r < commits.length; r++) {
    const commit = commits[r];

    // 1) 이 커밋을 기다리던 레인들(자식에서 내려온 간선의 도착점)을 찾는다.
    const incoming: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) {
        incoming.push(i);
      }
    }

    // 2) 노드의 열과 색을 정한다.
    let column: number;
    let color: number;
    if (incoming.length > 0) {
      column = incoming[0];
      color = laneColor[column];
      // 합쳐진 나머지 레인은 비운다(여러 자식이 이 커밋으로 모인 경우).
      for (let k = 1; k < incoming.length; k++) {
        lanes[incoming[k]] = null;
      }
    } else {
      column = firstFreeLane(lanes);
      color = nextColor++;
      laneColor[column] = color;
      lanes[column] = commit.hash; // 일단 점유(아래에서 부모로 교체)
    }

    rows.push(toRow(commit, column, color));

    // 3) 부모들에게 레인을 배정하고 간선을 만든다.
    assignParents(commit, column, color, {
      lanes,
      laneColor,
      edges,
      indexByHash,
      rowIndex: r,
      totalRows: commits.length,
      newColor: () => nextColor++,
    });

    maxLanes = Math.max(maxLanes, lanes.length);
  }

  // 부모가 로드된 경우, 간선의 도착 열을 부모 노드의 실제 열로 보정한다.
  for (const edge of edges) {
    if (edge.toRow < rows.length) {
      edge.toColumn = rows[edge.toRow].column;
    }
  }

  return { rows, edges, laneCount: Math.max(maxLanes, 1) };
}

/** assignParents 가 공유하는 스윕 상태 묶음 */
interface SweepState {
  lanes: (string | null)[];
  laneColor: number[];
  edges: GraphEdge[];
  indexByHash: Map<string, number>;
  rowIndex: number;
  totalRows: number;
  newColor: () => number;
}

/**
 * 커밋의 부모들에게 레인을 배정하고, 각 부모로 향하는 간선을 기록한다.
 * - 첫 부모: 현재 노드 레인을 그대로 이어받는다(직선).
 * - 추가 부모: 이미 그 부모를 기다리는 레인이 있으면 재사용, 없으면 새 레인으로 분기.
 * @param commit 처리 중인 커밋
 * @param column 노드가 놓인 열
 * @param color  노드 레인 색상
 * @param s      스윕 상태
 */
function assignParents(
  commit: Commit,
  column: number,
  color: number,
  s: SweepState
): void {
  if (commit.parents.length === 0) {
    s.lanes[column] = null; // 루트 커밋: 레인 종료
    return;
  }

  for (let k = 0; k < commit.parents.length; k++) {
    const parent = commit.parents[k];
    let parentLane: number;

    if (k === 0) {
      // 첫 부모는 노드 레인을 그대로 사용한다.
      parentLane = column;
      s.lanes[column] = parent;
      s.laneColor[column] = color;
    } else {
      // 추가 부모: 기존에 기다리는 레인이 있으면 재사용, 없으면 새 레인.
      const existing = s.lanes.indexOf(parent);
      if (existing >= 0) {
        parentLane = existing;
      } else {
        parentLane = firstFreeLane(s.lanes);
        s.lanes[parentLane] = parent;
        s.laneColor[parentLane] = s.newColor();
      }
    }

    const parentRow = s.indexByHash.get(parent);
    const toRow = parentRow ?? s.totalRows; // 로드 밖이면 바닥까지
    if (parentRow === undefined && k > 0) {
      // 분기했지만 부모가 로드 밖이면 레인을 비워 열 낭비를 막는다.
      s.lanes[parentLane] = null;
    }
    s.edges.push({
      fromRow: s.rowIndex,
      toRow,
      column: parentLane,
      fromColumn: column,
      toColumn: parentLane,
      color: s.laneColor[parentLane],
    });
  }
}

/**
 * 비어 있는(null) 첫 레인 인덱스를 찾는다. 없으면 배열을 늘려 새 인덱스를 만든다.
 * @param lanes 현재 레인 배열
 */
function firstFreeLane(lanes: (string | null)[]): number {
  const idx = lanes.indexOf(null);
  if (idx >= 0) {
    return idx;
  }
  lanes.push(null);
  return lanes.length - 1;
}

/**
 * Commit 을 GraphRow 로 변환한다(열/색 부여).
 * @param commit 변환할 커밋
 * @param column 노드 열
 * @param color  레인 색상
 */
function toRow(commit: Commit, column: number, color: number): GraphRow {
  return {
    hash: commit.hash,
    parents: commit.parents,
    refs: commit.refs,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    dateIso: commit.dateIso,
    subject: commit.subject,
    column,
    color,
  };
}
