// 기존 레인 알고리즘의 checkpoint를 재개해 새 페이지와 실제로 영향받은 suffix만 계산한다.
import { layoutGraph, toGraphRow, type GraphLayoutCheckpoint } from "./graphLayout";
import type { Commit, GraphData, GraphEdge, GraphRow } from "./graphTypes";

/** 데이터 내용은 전체 layoutGraph와 같고 계산한/재사용한 행 수만 추가로 관찰한다. */
export interface IncrementalGraphResult { data: GraphData; calculatedRows: number; reusedRows: number; }

/** panel 하나가 누적한 topo 페이지의 레인 checkpoint와 immutable 표시 객체를 보관한다. */
export class IncrementalGraphLayout {
  private data: GraphData = { rows: [], edges: [], laneCount: 1 };
  private hashes = new Map<string, number>();
  private readonly checkpoints = new Map<number, GraphLayoutCheckpoint>();

  /**
   * append는 마지막 checkpoint에서, 부모 가시성/HEAD/순서 변경은 가장 이른 영향 지점에서 재개한다.
   * @param commits 전체 topo 입력. virtual staged/working 행도 이미 삽입한 순서다.
   * @returns 정확한 전체 데이터와 이번 호출에서 실제 스윕한 행 수
   */
  update(commits: Commit[]): IncrementalGraphResult {
    const index = new Map<string, number>();
    for (let row = 0; row < commits.length; row++) index.set(commits[row].hash, row);
    let changed = Math.min(this.data.rows.length, commits.length);
    for (let row = 0; row < changed; row++) {
      if (!sameStructure(this.data.rows[row], commits[row])) { changed = row; break; }
    }
    // 기존 알고리즘은 로드 밖의 추가 부모 lane을 비운다. 새 merge 부모가 보이면 그 자식부터 재계산한다.
    for (let row = 0; row < changed; row++) {
      const parents = commits[row].parents;
      for (let parent = 1; parent < parents.length; parent++) {
        if (!this.hashes.has(parents[parent]) && index.has(parents[parent])) { changed = row; break; }
      }
      if (changed === row) break;
    }
    const previous = this.data;
    let start = changed;
    let data: GraphData;
    if (changed === commits.length && changed === previous.rows.length) {
      data = { rows: [...previous.rows], edges: previous.edges, laneCount: previous.laneCount };
    } else {
      const checkpoint = this.checkpoints.get(Math.floor(changed / 128) * 128);
      start = checkpoint?.rowIndex ?? 0;
      for (const row of this.checkpoints.keys()) if (row >= start) this.checkpoints.delete(row);
      data = layoutGraph(commits, { indexByHash: index,
        resume: checkpoint && start > 0 ? { ...checkpoint, data: previous } : undefined,
        checkpoint: value => this.checkpoints.set(value.rowIndex, value) });
    }
    // ref/subject/local-only 배지 변경은 레인 재계산 없이 표시 값만 바꾸고 같은 객체는 재사용한다.
    for (let row = 0; row < data.rows.length; row++) {
      const original = data.rows[row];
      const candidate = equalCommitMetadata(original, commits[row]) ? original : toGraphRow(commits[row], original.column, original.color);
      data.rows[row] = previous.rows[row] && (previous.rows[row] === candidate || equalGraphRow(previous.rows[row], candidate)) ? previous.rows[row] : candidate;
    }
    if (data.edges !== previous.edges) {
      for (let edge = 0; edge < data.edges.length; edge++) {
        if (previous.edges[edge] && equalGraphEdge(previous.edges[edge], data.edges[edge])) data.edges[edge] = previous.edges[edge];
      }
    }
    this.data = data; this.hashes = index;
    return { data, calculatedRows: commits.length - start, reusedRows: start };
  }

  /** 저장소/패널 수명을 마칠 때 모델과 checkpoint를 모두 해제한다. */
  clear(): void {
    this.data = { rows: [], edges: [], laneCount: 1 }; this.hashes.clear(); this.checkpoints.clear();
  }
}

/** 문자열 직렬화 없이 기존 immutable 행의 HEAD 위치·부모·가상 종류만 비교한다. */
function sameStructure(row: GraphRow, commit: Commit): boolean {
  return row.hash === commit.hash && row.kind === commit.kind && row.refs.includes("HEAD") === commit.refs.includes("HEAD") &&
    equalArray(row.parents, commit.parents);
}

/** optional 배열의 부재와 빈 배열도 구분해 원본 DTO 표현을 정확히 유지한다. */
function equalArray(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return left === right || (!!left && !!right && left.length === right.length && left.every((value, index) => value === right[index]));
}

/** 이미 같은 표시 정보를 가진 prefix 행은 새 객체·배열을 만들지 않고 유지한다. */
function equalCommitMetadata(row: GraphRow, commit: Commit): boolean {
  return row.hash === commit.hash && row.authorName === commit.authorName && row.authorEmail === commit.authorEmail &&
    row.dateIso === commit.dateIso && row.subject === commit.subject && row.kind === commit.kind &&
    equalArray(row.parents, commit.parents) && equalArray(row.refs, commit.refs) && equalArray(row.localOnlyBranches, commit.localOnlyBranches);
}

/** 표시 값·부모·원본/compact 좌표가 같은 행만 그대로 재사용한다. */
export function equalGraphRow(left: GraphRow, right: GraphRow): boolean {
  return left.hash === right.hash && left.authorName === right.authorName && left.authorEmail === right.authorEmail &&
    left.dateIso === right.dateIso && left.subject === right.subject && left.kind === right.kind &&
    left.column === right.column && left.color === right.color && left.originalColumn === right.originalColumn && left.compacted === right.compacted &&
    equalArray(left.parents, right.parents) && equalArray(left.refs, right.refs) && equalArray(left.localOnlyBranches, right.localOnlyBranches);
}

/** 같은 위치·색·원본/compact 좌표의 간선만 재사용하며 바닥/부모 연결 갱신은 별도 객체로 보낸다. */
export function equalGraphEdge(left: GraphEdge, right: GraphEdge): boolean {
  return left.fromRow === right.fromRow && left.toRow === right.toRow && left.column === right.column &&
    left.fromColumn === right.fromColumn && left.toColumn === right.toColumn && left.color === right.color &&
    left.originalColumn === right.originalColumn && left.originalFromColumn === right.originalFromColumn &&
    left.originalToColumn === right.originalToColumn && left.compacted === right.compacted;
}
