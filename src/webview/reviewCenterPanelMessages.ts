// Review Center panel이 webview로 보내는 결과 메시지의 공통 계약.
// - panel lifecycle과 각 write/lazy coordinator의 결과 타입을 한 모듈에서 조합해 host 파일의 책임을 작게 유지한다.
import type { ReviewCenterSnapshot } from "../git/pullRequestReviewCenterModel";
import type { PullRequestManagementPreview } from "../git/pullRequestManagementService";
import type { ReviewCenterActivityCoordinatorMessage } from "./reviewCenterActivityCoordinator";
import type { ReviewCenterChecksCoordinatorMessage } from "./reviewCenterChecksCoordinator";
import type { ReviewCenterCommentCoordinatorMessage } from "./reviewCenterCommentCoordinator";
import type { ReviewCenterCommitsCoordinatorMessage } from "./reviewCenterCommitsCoordinator";
import type { ReviewCenterDraftCoordinatorMessage } from "./reviewCenterDraftCoordinator";
import type { ReviewCenterFileCommentCoordinatorMessage } from "./reviewCenterFileCommentCoordinator";
import type { ReviewCenterLineCommentCoordinatorMessage } from "./reviewCenterLineCommentCoordinator";
import type { ReviewCenterSuggestionApplyCoordinatorMessage } from "./reviewCenterSuggestionApplyCoordinator";
import type { ReviewCenterThreadReplyCoordinatorMessage } from "./reviewCenterThreadReplyCoordinator";

/** Review Center UI에 전달하는 snapshot·page·mutation·lazy 결과 메시지. */
export type ReviewCenterRenderMessage =
  | { type: "loading" }
  | { type: "snapshot"; snapshot: ReviewCenterSnapshot }
  | { type: "pageLoaded"; scope: "files" | "threads"; snapshot: ReviewCenterSnapshot }
  | { type: "error"; message: string }
  | { type: "pageError"; scope: "files" | "threads"; message: string }
  | { type: "viewUpdate"; path: string; viewed: boolean }
  | { type: "viewError"; path: string; viewed: boolean; message: string }
  | { type: "threadUpdate"; threadId: string; resolved: boolean }
  | { type: "threadError"; threadId: string; resolved: boolean; message: string }
  | { type: "managementPreview"; previewId: string; preview: PullRequestManagementPreview }
  | { type: "managementResult"; snapshot: ReviewCenterSnapshot; verified: boolean; mismatches: string[] }
  | { type: "managementError"; message: string }
  | ReviewCenterActivityCoordinatorMessage
  | ReviewCenterFileCommentCoordinatorMessage
  | ReviewCenterCommentCoordinatorMessage
  | ReviewCenterCommitsCoordinatorMessage
  | ReviewCenterSuggestionApplyCoordinatorMessage
  | ReviewCenterChecksCoordinatorMessage
  | ReviewCenterLineCommentCoordinatorMessage
  | ReviewCenterThreadReplyCoordinatorMessage
  | ReviewCenterDraftCoordinatorMessage;
