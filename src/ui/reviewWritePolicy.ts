// Review webview의 쓰기 의도를 순수하게 분류하는 release 정책.
// - VS Code API와 분리해 host guard의 범위를 빠른 node test로 검증할 수 있게 한다.

/** Review Center에서 원격 또는 작업 트리 상태를 바꿀 수 있는 webview 메시지 종류. */
const reviewCenterWriteMessageTypes = new Set([
  "toggleViewed", "toggleThreadResolved", "previewManagement", "applyManagement", "cancelManagementPreview",
  "saveReviewDraft", "startReviewDraft", "submitReviewDraft", "discardReviewDraft", "addFileReviewComment",
  "addLineReviewComment", "addReviewThreadReply", "updateReviewComment", "deleteReviewComment",
  "previewSuggestionApply", "applySuggestion",
]);

/** Reviews queue에서 metadata write 흐름을 시작하거나 재시도하는 webview 메시지 종류. */
const reviewQueueWriteMessageTypes = new Set([
  "previewBulkManagement", "applyBulkManagement", "cancelBulkManagement", "retryFailedBulkManagement",
]);

/** 알 수 없는 webview payload도 안전하게 Review Center write 메시지인지 판별한다. */
export function isReviewCenterWriteMessage(message: { type?: unknown }): boolean {
  return typeof message.type === "string" && reviewCenterWriteMessageTypes.has(message.type);
}

/** 알 수 없는 webview payload도 안전하게 Reviews queue write 메시지인지 판별한다. */
export function isReviewQueueWriteMessage(message: { type?: unknown }): boolean {
  return typeof message.type === "string" && reviewQueueWriteMessageTypes.has(message.type);
}
