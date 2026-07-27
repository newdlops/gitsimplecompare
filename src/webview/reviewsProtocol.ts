// Reviews 사이드바와 extension host가 교환하는 작은 메시지 계약.
// - 실제 review workspace 프로토콜과 분리해 홈 화면의 진화가 상세 화면을 깨뜨리지 않게 한다.
import type { PullRequestManagementInputKind } from "./reviewManagementMutationInput";
import type { ReviewQueueLane } from "../git/pullRequestReviewModel";

/** Reviews 웹뷰가 extension host에 보내는 사용자 의도. */
export type ReviewsWebviewMessage =
  | { type: "ready" }
  | { type: "selectSidebarMode"; mode: "changes" | "reviews" }
  | { type: "startGitHubAuth" }
  | { type: "showOutputLog" }
  | { type: "refresh" }
  | { type: "loadMoreQueue"; lane: ReviewQueueLane }
  | { type: "selectSavedQueue"; id?: string }
  | { type: "selectManagementScope"; kind?: "repository" | "owner" | "team"; value?: string }
  | { type: "createSavedQueue"; name: string; query: string }
  | { type: "updateSavedQueue"; id: string; name: string; query: string }
  | { type: "moveSavedQueue"; id: string; direction: "up" | "down" }
  | { type: "deleteSavedQueue"; id: string }
  | { type: "previewBulkManagement"; keys: string[]; kind: PullRequestManagementInputKind; values: string[] }
  | { type: "applyBulkManagement"; previewId: string }
  | { type: "cancelBulkManagement"; previewId: string }
  | { type: "retryFailedBulkManagement" }
  | { type: "openReviewCenter"; number: number; repository?: string };
