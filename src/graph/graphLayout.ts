// 커밋 DAG 를 그래프(레인/간선)로 배치하는 순수 레이아웃 모듈.
// - 입력은 "자식이 부모보다 먼저 오는" 순서의 커밋 배열(git log --topo-order 결과).
// - 레인 스윕(lane sweep) 방식으로 각 커밋의 열과 간선을 계산한다. vscode 비의존.
import { Commit, GraphData, GraphEdge, GraphRow } from "./graphTypes";

/** 동시에 보이는 lane 끼리 같은 색상 계열을 피하기 위한 색상 family 수. */
const LANE_COLOR_FAMILY_COUNT = 16;

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
  let nextColorSeed = 0;
  const newColor = (targetLane?: number): number => {
    const color = chooseLaneColor(lanes, laneColor, nextColorSeed, targetLane);
    nextColorSeed = color + 1;
    return color;
  };

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
      const virtualLane = virtualIncomingLane(commits, rows, r, incoming);
      const realIncoming = incoming.filter((lane) => lane !== virtualLane);
      column = realIncoming[0] ?? firstFreeLaneExcept(lanes, virtualLane);
      color = laneColor[realIncoming[0] ?? virtualLane ?? column] ?? newColor(column);
      laneColor[column] = color;
      // 합쳐진 나머지 레인은 비운다(여러 자식이 이 커밋으로 모인 경우).
      for (const lane of incoming) {
        if (lane !== column) {
          lanes[lane] = null;
        }
      }
    } else {
      column = commit.kind ? firstFreeLaneFrom(lanes, 1) : firstFreeLane(lanes);
      color = newColor(column);
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
      newColor,
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
  newColor: (targetLane?: number) => number;
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
        s.laneColor[parentLane] = s.newColor(parentLane);
        s.lanes[parentLane] = parent;
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
 * 새 lane 에 배정할 색상 인덱스를 고른다.
 * - 현재 살아 있는 모든 lane 의 색상 family 를 우선 피한다.
 * - family 수보다 active lane 이 많은 경우에는 사용 빈도가 가장 낮고 target 양옆과 덜 겹치는
 *   family 를 고른다.
 * @param lanes 현재 lane 점유 상태
 * @param laneColor lane 별 색상 인덱스
 * @param seed 다음 색상 탐색 시작점
 * @param targetLane 색상을 넣을 lane 위치
 * @returns 선택된 색상 인덱스
 */
function chooseLaneColor(
  lanes: (string | null)[],
  laneColor: number[],
  seed: number,
  targetLane?: number
): number {
  const usedFamilies = activeColorFamilies(lanes, laneColor, targetLane);
  for (let offset = 0; offset < LANE_COLOR_FAMILY_COUNT * 4; offset++) {
    const candidate = seed + offset;
    if (!usedFamilies.has(colorFamily(candidate))) {
      return candidate;
    }
  }
  return leastConflictingColor(lanes, laneColor, seed, targetLane);
}

/**
 * active lane 들의 색상 family 집합을 만든다.
 * @param lanes 현재 lane 점유 상태
 * @param laneColor lane 별 색상 인덱스
 * @param targetLane 새 색을 넣을 lane. 비어 있는 과거 색은 제외한다.
 * @returns 현재 동시에 보이는 색상 family 집합
 */
function activeColorFamilies(
  lanes: (string | null)[],
  laneColor: number[],
  targetLane?: number
): Set<number> {
  const families = new Set<number>();
  for (let i = 0; i < lanes.length; i++) {
    if (i === targetLane || lanes[i] === null || laneColor[i] === undefined) {
      continue;
    }
    families.add(colorFamily(laneColor[i]));
  }
  return families;
}

/**
 * 모든 family 가 이미 쓰이는 과밀 상태에서 가장 덜 충돌하는 색상 인덱스를 고른다.
 * @param lanes 현재 lane 점유 상태
 * @param laneColor lane 별 색상 인덱스
 * @param seed 다음 색상 탐색 시작점
 * @param targetLane 색상을 넣을 lane 위치
 * @returns 충돌 점수가 가장 낮은 색상 인덱스
 */
function leastConflictingColor(
  lanes: (string | null)[],
  laneColor: number[],
  seed: number,
  targetLane?: number
): number {
  let best = seed;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < LANE_COLOR_FAMILY_COUNT * 4; offset++) {
    const candidate = seed + offset;
    const score = colorConflictScore(
      colorFamily(candidate),
      lanes,
      laneColor,
      targetLane
    );
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * 후보 색상 family 의 충돌 점수를 계산한다.
 * - 전체 active lane 에 같은 family 가 있으면 충돌로 보고,
 * - target 바로 양옆 lane 은 시각적으로 가장 가까우므로 높은 페널티를 준다.
 * @param family 후보 색상 family
 * @param lanes 현재 lane 점유 상태
 * @param laneColor lane 별 색상 인덱스
 * @param targetLane 색상을 넣을 lane 위치
 * @returns 낮을수록 좋은 충돌 점수
 */
function colorConflictScore(
  family: number,
  lanes: (string | null)[],
  laneColor: number[],
  targetLane?: number
): number {
  let score = 0;
  for (let i = 0; i < lanes.length; i++) {
    if (i === targetLane || lanes[i] === null || laneColor[i] === undefined) {
      continue;
    }
    if (colorFamily(laneColor[i]) !== family) {
      continue;
    }
    score += 10;
    if (targetLane !== undefined && Math.abs(i - targetLane) <= 1) {
      score += 100;
    }
  }
  return score;
}

/** 색상 인덱스를 시각적 계열 family 로 변환한다. */
function colorFamily(index: number): number {
  return Math.abs(Math.floor(index)) % LANE_COLOR_FAMILY_COUNT;
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

/** 지정 시작점 이후의 비어 있는 첫 레인을 찾는다. */
function firstFreeLaneFrom(lanes: (string | null)[], start: number): number {
  for (let i = start; i < lanes.length; i++) {
    if (lanes[i] === null) {
      return i;
    }
  }
  while (lanes.length < start) {
    lanes.push(null);
  }
  lanes.push(null);
  return lanes.length - 1;
}

/** 제외할 레인을 피해 비어 있는 첫 레인을 찾는다. */
function firstFreeLaneExcept(
  lanes: (string | null)[],
  except: number | undefined
): number {
  for (let i = 0; i < lanes.length; i++) {
    if (i !== except && lanes[i] === null) {
      return i;
    }
  }
  lanes.push(null);
  return lanes.length - 1;
}

/** staged 가상 커밋에서 HEAD 로 들어오는 레인을 찾는다. */
function virtualIncomingLane(
  commits: Commit[],
  rows: GraphRow[],
  rowIndex: number,
  incoming: number[]
): number | undefined {
  const commit = commits[rowIndex];
  const previous = commits[rowIndex - 1];
  const previousRow = rows[rowIndex - 1];
  if (!commit.refs.includes("HEAD") || previous?.kind !== "staged") {
    return undefined;
  }
  return incoming.includes(previousRow?.column) ? previousRow.column : undefined;
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
    localOnlyBranches: commit.localOnlyBranches,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    dateIso: commit.dateIso,
    subject: commit.subject,
    kind: commit.kind,
    column,
    color,
  };
}
