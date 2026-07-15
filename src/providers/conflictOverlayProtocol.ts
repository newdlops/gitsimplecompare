// extension host의 conflict session과 renderer overlay 사이에서 공유하는 직렬화 프로토콜.
// - renderer가 repo/path/version을 임의로 정하지 못하게 opaque session 식별자와 UI snapshot만 전달한다.
import type { ConflictOverlayPresentation } from "../ui/conflictOverlayPresentation";
import type { ConflictMarkerBlock } from "../utils/conflictMarkerModel";

/** native editor 위에 표시할 현재 conflict session snapshot이다. */
export interface ConflictOverlaySnapshot {
  uri: string;
  sessionId: string;
  revision: number;
  editorVersion: number;
  busy: boolean;
  virtual: boolean;
  canEditBlocks: boolean;
  canAcceptBoth: boolean;
  canMarkResolved: boolean;
  canOpenMergeEditor: boolean;
  blocks: ConflictMarkerBlock[];
  presentation: ConflictOverlayPresentation;
}

/** renderer overlay에서 host로 요청할 수 있는 versioned action 종류다. */
export type ConflictOverlayAction =
  | "acceptCurrent"
  | "acceptIncoming"
  | "acceptBoth"
  | "markResolved"
  | "openMergeEditor"
  | "reload"
  | "showDetails";

/** renderer button 이벤트의 신뢰하지 않는 wire payload다. */
export interface ConflictOverlayActionPayload {
  type: "conflictAction";
  action: ConflictOverlayAction;
  uri: string;
  sessionId: string;
  revision: number;
  editorVersion: number;
}

/** CodeLens에서 한 marker block을 현재 native Result buffer에 적용하는 인자다. */
export interface ConflictBlockActionArgs {
  uri: string;
  sessionId: string;
  revision: number;
  editorVersion: number;
  blockId: string;
  choice: "current" | "incoming" | "both";
}

/** native renderer bridge가 의존할 host-side conflict action 최소 계약이다. */
export interface ConflictOverlayActionHandler {
  /** renderer payload를 검증·직렬화한 뒤 대응하는 host action을 실행한다. */
  handleRendererAction(payload: ConflictOverlayActionPayload): void;
}
