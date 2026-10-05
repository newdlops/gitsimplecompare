// panel별 레이아웃 checkpoint와 transport revision을 소유해 누적 Graph 페이지를 증분 게시한다.
import { IncrementalGraphLayout } from "../graph/graphIncrementalLayout";
import { compactRow, compactEdge, DEFAULT_COMPACT_MAX_LANES } from "../graph/graphCompact";
import type { GraphData, GraphDataDelta, GraphRow, GraphEdge } from "../graph/graphTypes";
import { graphCommits } from "./graphLayoutData";
import type { GraphRenderRequest } from "./graphPanelRendering";
import { createGraphRenderPerformance, logGraphPerformancePhase } from "./graphPerformance";
import type { ToWebviewMessage } from "./graphProtocol";

/** GraphPanel 하나의 renderer 모델이며 전역 저장소/패널 사이에 결과를 공유하지 않는다. */
export class GraphRenderCache {
  private readonly layout = new IncrementalGraphLayout();
  private previous?: GraphData;
  private revision = 0;
  private rowCompact = new WeakMap<GraphRow, GraphRow>();
  private edgeCompact = new WeakMap<GraphEdge, GraphEdge>();

  /**
   * 같은 topo prefix는 checkpoint에서 재개하고 revision이 붙은 추가/변경 데이터만 게시한다.
   * @param request 현재 commit/virtual/load/filter 상태, post 패널의 transport 함수
   * @returns 없음. reset/순서 변경은 전체 snapshot으로 안전하게 다시 동기화한다.
   */
  publish(request: GraphRenderRequest, post: (message: ToWebviewMessage) => void): void {
    const started = Date.now();
    const result = this.layout.update(graphCommits(request.commits, request.virtualCommits));
    const compact = request.compact && result.data.laneCount > DEFAULT_COMPACT_MAX_LANES;
    const data: GraphData = compact ? {
      rows: result.data.rows.map(row => {
        let value = this.rowCompact.get(row);
        if (!value) { value = compactRow(row, DEFAULT_COMPACT_MAX_LANES); this.rowCompact.set(row, value); }
        return value;
      }),
      edges: result.data.edges.map(edge => {
        let value = this.edgeCompact.get(edge);
        if (!value) { value = compactEdge(edge, DEFAULT_COMPACT_MAX_LANES); this.edgeCompact.set(edge, value); }
        return value;
      }), laneCount: DEFAULT_COMPACT_MAX_LANES,
    } : result.data;
    const previousRevision = this.revision++;
    const delta = !request.state.reset && this.previous ?
      graphDelta(this.previous, data, previousRevision, this.revision) : undefined;
    this.previous = data;
    logGraphPerformancePhase(request.trace, "layout", Date.now() - started, {
      kind: request.kind, rows: data.rows.length, edges: data.edges.length,
      calculatedRows: result.calculatedRows, reusedRows: result.reusedRows,
      transport: delta ? "delta" : "snapshot", sentRows: delta?.rows.length ?? data.rows.length,
      updatedRows: delta?.rowUpdates.length ?? 0, updatedEdges: delta?.edgeUpdates.length ?? 0,
    });
    const performance = createGraphRenderPerformance(request.trace, request.kind);
    post(delta ? { type: "graphDelta", delta, state: request.state, performance } :
      { type: "graph", data, revision: this.revision, state: request.state, performance });
  }

  /** 누락된 post/recreated webview는 Git을 다시 읽지 않고 다음 게시에서 전체 모델로 동기화한다. */
  resetTransport(): void { this.previous = undefined; }

  /** panel 폐기 시 checkpoint와 마지막 전송 모델을 해제한다. */
  clear(): void {
    this.layout.clear(); this.previous = undefined;
    this.rowCompact = new WeakMap(); this.edgeCompact = new WeakMap();
  }
}

/** 순서·부모가 같은 prefix는 추가 요소와 변경 객체만 보내고 재배치는 전체 snapshot으로 돌린다. */
function graphDelta(previous: GraphData, next: GraphData, baseRevision: number, revision: number): GraphDataDelta | undefined {
  if (previous.rows.length > next.rows.length || previous.edges.length > next.edges.length) return undefined;
  for (let index = 0; index < previous.rows.length; index++) {
    const left = previous.rows[index], right = next.rows[index];
    if (left.hash !== right.hash || left.parents.length !== right.parents.length || left.parents.some((parent, n) => parent !== right.parents[n])) return undefined;
  }
  const rowUpdates: GraphDataDelta["rowUpdates"] = [], edgeUpdates: GraphDataDelta["edgeUpdates"] = [];
  for (let index = 0; index < previous.rows.length; index++) {
    if (previous.rows[index] !== next.rows[index]) rowUpdates.push({ index, row: next.rows[index] });
  }
  for (let index = 0; index < previous.edges.length; index++) {
    if (previous.edges[index] !== next.edges[index]) edgeUpdates.push({ index, edge: next.edges[index] });
  }
  const rows = next.rows.slice(previous.rows.length), edges = next.edges.slice(previous.edges.length);
  if ((rowUpdates.length + rows.length) > Math.max(1, next.rows.length * 0.75)) return undefined;
  return { baseRevision, revision, rowStart: previous.rows.length, rows, rowUpdates,
    edgeStart: previous.edges.length, edges, edgeUpdates, laneCount: next.laneCount };
}
