// rebase 계획 편집 웹뷰와 확장 사이의 메시지 타입.
import { RebaseCommit, RebaseItem } from "../git/rebaseService";

/** 확장 → 웹뷰 */
export type RebaseToWebview =
  | { type: "plan"; base: string; commits: RebaseCommit[] }
  | { type: "operation"; state: "loading" | "running" | "error"; message: string };

/** 웹뷰 → 확장 */
export type RebaseFromWebview =
  | { type: "ready" }
  | { type: "retry" }
  | { type: "start"; items: RebaseItem[] }
  | { type: "cancel" };
