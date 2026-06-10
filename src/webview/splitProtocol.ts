// 변경 분할(부분 커밋) 웹뷰와 확장 사이의 메시지 타입.
import { DiffFile, HunkSelection } from "../git/diffHunkService";

/** 확장 → 웹뷰 */
export type SplitToWebview =
  | { type: "changes"; files: DiffFile[] }
  | { type: "committed"; message: string }
  | { type: "error"; message: string };

/** 웹뷰 → 확장 */
export type SplitFromWebview =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "commit"; selections: HunkSelection[]; message: string };
