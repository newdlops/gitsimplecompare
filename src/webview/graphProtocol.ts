// 그래프 웹뷰와 확장 사이에 오가는 메시지 타입 정의.
// - 확장(Node)과 웹뷰(브라우저 컨텍스트)가 동일한 타입을 공유해 프로토콜 불일치를 막는다.
// - 새 상호작용(예: rebase 편집)을 추가할 때 이 합집합 타입에 한 줄만 더하면 된다(확장성).
import { CommitDetail, GraphData } from "../graph/graphTypes";

/** 확장 → 웹뷰 메시지 */
export type ToWebviewMessage =
  | { type: "graph"; data: GraphData }
  | { type: "commitDetail"; detail: CommitDetail }
  | { type: "error"; message: string };

/** 웹뷰 → 확장 메시지 */
export type FromWebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "selectCommit"; hash: string }
  | { type: "openFileDiff"; hash: string; parent: string; path: string }
  | { type: "rebaseFrom"; hash: string };
