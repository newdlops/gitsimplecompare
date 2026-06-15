// git 그래프 도메인 타입 정의 모듈.
// - git 로그를 표현하는 Commit, 커밋 상세 CommitDetail, 그리고 그래프 레이아웃 결과
//   (GraphData)를 담는다. vscode 에 의존하지 않는 순수 타입이다(경계 분리).
import { FileChangeStatus } from "../git/gitTypes";

/**
 * 그래프의 한 커밋(노드).
 * - parents: 부모 커밋 해시들(첫 번째가 첫 부모). 머지 커밋은 2개 이상.
 * - refs: 이 커밋을 가리키는 참조 이름들(브랜치/태그/HEAD).
 * - localOnlyBranches: upstream 보다 앞서 있어 로컬에만 있는 브랜치 이름들.
 */
export interface Commit {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  dateIso: string;
  refs: string[];
  localOnlyBranches?: string[];
  subject: string;
  kind?: GraphRowKind;
}

/** 커밋 상세에서 보여줄 파일 변경 한 건(증감 라인 수 포함) */
export interface CommitFileChange {
  status: FileChangeStatus;
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
}

/** 커밋 상세에서 보여줄 브랜치 한 건(커밋을 포함하는 local/remote ref) */
export interface CommitBranchInfo {
  name: string;
  tipHash?: string;
  kind: "local" | "remote";
  current: boolean;
}

/** 노드를 클릭했을 때 보여줄 커밋 상세 정보 */
export interface CommitDetail {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDateIso: string;
  message: string;
  branches: CommitBranchInfo[];
  files: CommitFileChange[];
  kind?: GraphRowKind;
  loading?: boolean;
}

/** Git graph 에 함께 표시할 로컬 브랜치 상태 */
export interface LocalBranchStatus {
  name: string;
  hash: string;
  upstream?: string;
  ahead: number;
  behind: number;
  gone: boolean;
  current: boolean;
  dateIso: string;
  subject: string;
}

/** 그래프 행의 종류. 실제 커밋 외에 작업 중 상태를 가상 커밋으로 표현한다. */
export type GraphRowKind = "commit" | "ongoing" | "staged";

/**
 * 레이아웃이 끝난 커밋 행.
 * - column: 노드가 그려질 레인(열) 인덱스.
 * - color: 레인 색상 인덱스(웹뷰에서 팔레트로 매핑).
 * - originalColumn/compacted: compact graph 에서 lane 이 접혔는지와 접히기 전 열.
 */
export interface GraphRow {
  hash: string;
  parents: string[];
  refs: string[];
  localOnlyBranches?: string[];
  authorName: string;
  authorEmail: string;
  dateIso: string;
  subject: string;
  kind?: GraphRowKind;
  column: number;
  originalColumn?: number;
  compacted?: boolean;
  color: number;
}

/**
 * 커밋과 부모를 잇는 간선.
 * - fromRow/toRow: 행 인덱스(자식→부모). 부모가 로드 범위 밖이면 toRow 는 행 개수(바닥).
 * - column: 간선이 세로로 흐르는 레인. fromColumn/toColumn: 양 끝 노드의 열.
 * - originalColumn/compacted: compact graph 에서 lane 이 접혔는지와 접히기 전 열.
 */
export interface GraphEdge {
  fromRow: number;
  toRow: number;
  column: number;
  fromColumn: number;
  toColumn: number;
  originalColumn?: number;
  originalFromColumn?: number;
  originalToColumn?: number;
  compacted?: boolean;
  color: number;
}

/** 웹뷰로 전달하는 전체 그래프 데이터 */
export interface GraphData {
  rows: GraphRow[];
  edges: GraphEdge[];
  laneCount: number;
}
