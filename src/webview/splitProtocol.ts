// 변경 분할(부분 커밋) 웹뷰와 확장 사이의 메시지 타입.
import { DiffFile, DiffStage, HunkSelection } from "../git/diffHunkService";

export interface SplitFocus {
  path?: string;
  stage?: DiffStage;
}

/** 확장 → 웹뷰 */
export type SplitToWebview =
  | {
      type: "changes";
      files: DiffFile[];
      focus?: SplitFocus;
      singleFile?: boolean;
      workingFile?: { path: string; baseText: string; text: string };
    }
  | { type: "staged"; message: string }
  | { type: "discarded"; message: string }
  | { type: "saved"; message: string }
  | { type: "error"; message: string };

/** 웹뷰 → 확장 */
export type SplitFromWebview =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "stage"; selections: HunkSelection[] }
  | { type: "discard"; selections: HunkSelection[] }
  | { type: "saveFile"; path: string; content: string }
  | { type: "openFile"; path: string };
