// Review Center 편집기 웹뷰와 extension host 간 읽기 전용 메시지 계약.
// - 이후 comment/mutation 명령을 별도 protocol 확장으로 추가할 수 있게 초기 surface는 작게 유지한다.

/** Review Center 웹뷰가 host에 보내는 사용자 액션. */
export type ReviewCenterWebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "loadMoreFiles" }
  | { type: "loadMoreThreads" }
  | { type: "loadReviewCommits" }
  | { type: "loadReviewActivity" }
  | { type: "loadReviewChecks" }
  | { type: "toggleViewed"; path: string; viewed: boolean }
  | { type: "toggleThreadResolved"; threadId: string; resolved: boolean }
  | {
    type: "previewManagement";
    kind: "addAssignees" | "removeAssignees" | "addLabels" | "removeLabels" | "requestReviewers" | "removeReviewers" | "setDraft" | "setReady" | "setMilestone" | "clearMilestone";
    values: string[];
  }
  | { type: "applyManagement"; previewId: string }
  | { type: "cancelManagementPreview"; previewId: string }
  | { type: "saveReviewDraft"; body: string; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" }
  | { type: "startReviewDraft"; body: string; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" }
  | { type: "submitReviewDraft"; reviewId?: string; body: string; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" }
  | { type: "discardReviewDraft"; reviewId?: string }
  | { type: "addFileReviewComment"; path: string; body: string; reviewBody: string }
  | { type: "addLineReviewComment"; path: string; line: number; startLine?: number; body: string; suggestion?: string; reviewBody: string }
  | { type: "addReviewThreadReply"; threadId: string; body: string; reviewBody: string }
  | { type: "updateReviewComment"; commentId: string; body: string }
  | { type: "deleteReviewComment"; commentId: string }
  | { type: "previewSuggestionApply"; threadId: string; commentId: string; suggestionIndex: number }
  | { type: "applySuggestion"; previewId: string }
  | { type: "openFile"; path: string }
  | { type: "openCheckUrl"; url: string }
  | { type: "openGitHub" };
