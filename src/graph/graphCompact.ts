// 그래프 레이아웃 결과의 폭을 제한하는 순수 유틸.
// - 원본 DAG 계산은 graphLayout 이 맡고, 이 파일은 웹뷰 표시 폭만 줄이기 위해 lane 좌표를 접는다.
import type { GraphData, GraphEdge, GraphRow } from "./graphTypes";

/** compact graph 에서 그대로 펼쳐 둘 최대 레인 수. 마지막 레인은 overflow 묶음으로 쓴다. */
export const DEFAULT_COMPACT_MAX_LANES = 10;

/**
 * 레이아웃 결과가 너무 넓을 때 overflow lane 을 마지막 lane 으로 접는다.
 * - 커밋 순서와 ref 정보는 유지한다.
 * - 폭만 줄이는 표시용 변환이므로 git 데이터나 실제 브랜치 관계는 바꾸지 않는다.
 * @param data graphLayout 이 만든 원본 레이아웃
 * @param maxLanes 표시할 최대 레인 수
 * @returns compact 적용된 GraphData
 */
export function compactGraphData(
  data: GraphData,
  maxLanes = DEFAULT_COMPACT_MAX_LANES
): GraphData {
  const safeMax = Math.max(2, Math.floor(maxLanes));
  if (data.laneCount <= safeMax) {
    return data;
  }
  return {
    rows: data.rows.map((row) => compactRow(row, safeMax)),
    edges: data.edges.map((edge) => compactEdge(edge, safeMax)),
    laneCount: safeMax,
  };
}

/**
 * GraphRow 의 column 만 compact lane 좌표로 변환한다.
 * @param row 변환할 row
 * @param maxLanes 표시할 최대 레인 수
 * @returns column 이 접힌 row
 */
function compactRow(row: GraphRow, maxLanes: number): GraphRow {
  const column = compactColumn(row.column, maxLanes);
  return {
    ...row,
    column,
    originalColumn: row.column,
    compacted: column !== row.column,
  };
}

/**
 * GraphEdge 의 모든 column 좌표를 compact lane 좌표로 변환한다.
 * @param edge 변환할 edge
 * @param maxLanes 표시할 최대 레인 수
 * @returns column 들이 접힌 edge
 */
function compactEdge(edge: GraphEdge, maxLanes: number): GraphEdge {
  const column = compactColumn(edge.column, maxLanes);
  const fromColumn = compactColumn(edge.fromColumn, maxLanes);
  const toColumn = compactColumn(edge.toColumn, maxLanes);
  return {
    ...edge,
    column,
    fromColumn,
    toColumn,
    originalColumn: edge.column,
    originalFromColumn: edge.fromColumn,
    originalToColumn: edge.toColumn,
    compacted:
      column !== edge.column ||
      fromColumn !== edge.fromColumn ||
      toColumn !== edge.toColumn,
  };
}

/**
 * overflow column 을 마지막 표시 lane 으로 접는다.
 * @param column 원본 lane column
 * @param maxLanes 표시할 최대 레인 수
 * @returns compact lane column
 */
function compactColumn(column: number, maxLanes: number): number {
  return column < maxLanes - 1 ? column : maxLanes - 1;
}
