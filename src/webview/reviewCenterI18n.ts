// Review Center webview가 host의 vscode.l10n 번역을 그대로 쓰게 하는 문자열 묶음.
// - media JavaScript는 locale API에 접근할 수 없으므로 locale 적용은 extension host에서 끝낸다.
import * as vscode from "vscode";

/** Review Center renderer가 필요한 지역화된 정적 문구. */
export interface ReviewCenterI18n {
  reviewCenter: string;
  overview: string;
  files: string;
  activity: string;
  commits: string;
  checks: string;
  refresh: string;
  openGitHub: string;
  openGitHubTitle: string;
  draft: string;
  reviewDecisionSummary: string;
  mergeStateSummary: string;
  readyForReview: string;
  baseUnavailable: string;
  headUnavailable: string;
  showTab: string;
  contentTabs: string;
  skipToContent: string;
  loading: string;
  unavailable: string;
  reviewWritesDisabled: string;
  retry: string;
  retryTitle: string;
  description: string;
  noDescription: string;
  reviewState: string;
  metadata: string;
  assignees: string;
  labels: string;
  milestone: string;
  reviewers: string;
  draftStage: string;
  none: string;
  manageMetadata: string;
  managementOperation: string;
  metadataValues: string;
  metadataValuesHint: string;
  addAssignees: string;
  removeAssignees: string;
  addLabels: string;
  removeLabels: string;
  requestReviewers: string;
  removeReviewers: string;
  convertToDraft: string;
  markReadyForReview: string;
  setMilestone: string;
  clearMilestone: string;
  milestoneValues: string;
  milestoneValuesHint: string;
  clearMilestoneHint: string;
  reviewerValues: string;
  reviewerValuesHint: string;
  stageChangeHint: string;
  previewChanges: string;
  previewingChanges: string;
  valuesRequired: string;
  willApply: string;
  alreadyRequestedState: string;
  noManagementChanges: string;
  confirmChanges: string;
  applyingChanges: string;
  cancel: string;
  metadataUpdated: string;
  metadataPartiallyUpdated: string;
  metadataPermissionDenied: string;
  reviewDraft: string;
  reviewSummary: string;
  reviewSummaryHint: string;
  reviewEvent: string;
  commentReview: string;
  approveReview: string;
  requestChangesReview: string;
  startReview: string;
  startingReview: string;
  submitReview: string;
  submittingReview: string;
  submitReviewConfirm: string;
  confirmSubmitReview: string;
  keepEditingReview: string;
  pendingReview: string;
  draftHeadChanged: string;
  draftConflict: string;
  discardReviewDraft: string;
  discardReviewDraftConfirm: string;
  keepReviewDraft: string;
  draftUnavailable: string;
  changedFilesAndThreads: string;
  additionalResultsAvailable: string;
  filesTitle: string;
  noFiles: string;
  loadMoreFiles: string;
  loadingMoreFiles: string;
  loadMoreFilesFailed: string;
  openFileDiff: string;
  nativeDiffUnavailable: string;
  renamedFrom: string;
  viewed: string;
  unviewed: string;
  markViewed: string;
  markUnviewed: string;
  viewedUnavailable: string;
  addFileComment: string;
  newFileComment: string;
  fileComment: string;
  fileCommentHint: string;
  addToPendingReview: string;
  addingFileComment: string;
  fileCommentAdded: string;
  addLineComment: string;
  newLineComment: string;
  commentFile: string;
  commentLine: string;
  commentLineHint: string;
  commentStartLine: string;
  commentStartLineHint: string;
  lineComment: string;
  commentMessage: string;
  lineCommentHint: string;
  lineCommentInvalidAnchor: string;
  addLineToPendingReview: string;
  addingLineComment: string;
  lineCommentAdded: string;
  addSuggestion: string;
  suggestionCode: string;
  suggestionCodeHint: string;
  previewSuggestion: string;
  suggestionUnavailable: string;
  suggestionPreview: string;
  suggestionBefore: string;
  suggestionAfter: string;
  suggestionDelete: string;
  suggestionApplyHint: string;
  applySuggestion: string;
  suggestionApplied: string;
  reply: string;
  replyToThread: string;
  threadReply: string;
  threadReplyHint: string;
  addReplyToPendingReview: string;
  addingThreadReply: string;
  threadReplyAdded: string;
  editComment: string;
  deleteComment: string;
  saveComment: string;
  savingComment: string;
  deleteCommentConfirm: string;
  confirmDeleteComment: string;
  commentUpdated: string;
  commentDeleted: string;
  reviewThreads: string;
  checksTitle: string;
  commitsTitle: string;
  loadingCommits: string;
  commitsUnavailable: string;
  noCommits: string;
  commitsTruncated: string;
  activityTimeline: string;
  activityFilter: string;
  activityAll: string;
  activityComments: string;
  activityReviews: string;
  activityCommits: string;
  activityEvents: string;
  loadingActivity: string;
  activityUnavailable: string;
  noActivity: string;
  activityTruncated: string;
  activityEventsUnavailable: string;
  activityEventForcePush: string;
  activityEventReviewRequested: string;
  activityEventAssigned: string;
  activityEventLabeled: string;
  activityEventMilestoned: string;
  activityEventDraft: string;
  activityEventReady: string;
  activityEventUnknown: string;
  loadingChecks: string;
  checksUnavailable: string;
  requiredChecksUnknown: string;
  requiredChecks: string;
  allChecks: string;
  noRequiredChecks: string;
  requiredChecksSummary: string;
  requiredChecksStrict: string;
  requiredChecksNotStrict: string;
  noChecks: string;
  openCheckDetails: string;
  noThreads: string;
  loadMoreThreads: string;
  loadingMoreThreads: string;
  loadMoreThreadsFailed: string;
  locationUnavailable: string;
  outdated: string;
  resolved: string;
  resolveThread: string;
  unresolveThread: string;
  resolvingThread: string;
  threadUpdateFailed: string;
  noCommentBody: string;
  updatedUnavailable: string;
  updatedPrefix: string;
  unknownError: string;
}

/** vscode.l10n을 webview 초기 상태로 직렬화할 Review Center 문구 묶음으로 만든다. */
export function reviewCenterI18n(): ReviewCenterI18n {
  return {
    reviewCenter: vscode.l10n.t("Review Center"),
    overview: vscode.l10n.t("Overview"),
    files: vscode.l10n.t("Files"),
    activity: vscode.l10n.t("Activity"),
    commits: vscode.l10n.t("Commits"),
    checks: vscode.l10n.t("Checks"),
    refresh: vscode.l10n.t("Refresh pull request review"),
    openGitHub: vscode.l10n.t("Open GitHub"),
    openGitHubTitle: vscode.l10n.t("Open pull request on GitHub"),
    draft: vscode.l10n.t("Draft"),
    reviewDecisionSummary: vscode.l10n.t("Review: {0}"),
    mergeStateSummary: vscode.l10n.t("Merge: {0}"),
    readyForReview: vscode.l10n.t("Ready for review"),
    baseUnavailable: vscode.l10n.t("base unavailable"),
    headUnavailable: vscode.l10n.t("head unavailable"),
    showTab: vscode.l10n.t("Show {0} tab"),
    contentTabs: vscode.l10n.t("Review Center content tabs"),
    skipToContent: vscode.l10n.t("Skip to main content"),
    loading: vscode.l10n.t("Loading pull request review"),
    unavailable: vscode.l10n.t("Review Center is unavailable"),
    reviewWritesDisabled: vscode.l10n.t("Review write actions are disabled in this release. Enable Experimental Review Writes only after validating them in a disposable repository."),
    retry: vscode.l10n.t("Retry"),
    retryTitle: vscode.l10n.t("Retry loading Review Center"),
    description: vscode.l10n.t("Description"),
    noDescription: vscode.l10n.t("No pull request description was provided."),
    reviewState: vscode.l10n.t("Review state"),
    metadata: vscode.l10n.t("Metadata"),
    assignees: vscode.l10n.t("Assignees"),
    labels: vscode.l10n.t("Labels"),
    milestone: vscode.l10n.t("Milestone"),
    reviewers: vscode.l10n.t("Review requests"),
    draftStage: vscode.l10n.t("Pull request stage"),
    none: vscode.l10n.t("None"),
    manageMetadata: vscode.l10n.t("Manage metadata"),
    managementOperation: vscode.l10n.t("Operation"),
    metadataValues: vscode.l10n.t("Assignee or label names"),
    metadataValuesHint: vscode.l10n.t("Separate multiple names with commas."),
    addAssignees: vscode.l10n.t("Add assignees"),
    removeAssignees: vscode.l10n.t("Remove assignees"),
    addLabels: vscode.l10n.t("Add labels"),
    removeLabels: vscode.l10n.t("Remove labels"),
    requestReviewers: vscode.l10n.t("Request reviewers"),
    removeReviewers: vscode.l10n.t("Remove review requests"),
    convertToDraft: vscode.l10n.t("Convert to draft"),
    markReadyForReview: vscode.l10n.t("Mark ready for review"),
    setMilestone: vscode.l10n.t("Set milestone"),
    clearMilestone: vscode.l10n.t("Clear milestone"),
    milestoneValues: vscode.l10n.t("Milestone number"),
    milestoneValuesHint: vscode.l10n.t("Enter the positive milestone number for this repository."),
    clearMilestoneHint: vscode.l10n.t("This action removes the current milestone without additional input."),
    reviewerValues: vscode.l10n.t("Reviewer names"),
    reviewerValuesHint: vscode.l10n.t("Separate names with commas. Use team:slug for a team."),
    stageChangeHint: vscode.l10n.t("This action changes the pull request stage without additional input."),
    previewChanges: vscode.l10n.t("Preview changes"),
    previewingChanges: vscode.l10n.t("Preparing preview…"),
    valuesRequired: vscode.l10n.t("Enter at least one assignee or label name."),
    willApply: vscode.l10n.t("Will apply: {0}"),
    alreadyRequestedState: vscode.l10n.t("Already in requested state: {0}"),
    noManagementChanges: vscode.l10n.t("No metadata changes are needed."),
    confirmChanges: vscode.l10n.t("Apply {0} changes"),
    applyingChanges: vscode.l10n.t("Applying changes…"),
    cancel: vscode.l10n.t("Cancel"),
    metadataUpdated: vscode.l10n.t("Metadata updated and verified."),
    metadataPartiallyUpdated: vscode.l10n.t("Metadata was updated, but GitHub did not confirm: {0}"),
    metadataPermissionDenied: vscode.l10n.t("You do not have permission to update this pull request metadata."),
    reviewDraft: vscode.l10n.t("Review draft"),
    reviewSummary: vscode.l10n.t("Review summary"),
    reviewSummaryHint: vscode.l10n.t("Describe the feedback you want to submit with this review."),
    reviewEvent: vscode.l10n.t("Review event"),
    commentReview: vscode.l10n.t("Comment"),
    approveReview: vscode.l10n.t("Approve"),
    requestChangesReview: vscode.l10n.t("Request changes"),
    startReview: vscode.l10n.t("Start review"),
    startingReview: vscode.l10n.t("Starting review…"),
    submitReview: vscode.l10n.t("Submit review"),
    submittingReview: vscode.l10n.t("Submitting review…"),
    submitReviewConfirm: vscode.l10n.t("Submit this review as {0}?"),
    confirmSubmitReview: vscode.l10n.t("Confirm submit review"),
    keepEditingReview: vscode.l10n.t("Keep editing"),
    pendingReview: vscode.l10n.t("Pending review"),
    draftHeadChanged: vscode.l10n.t("New commits changed this pull request. Keep the draft, then reload before writing more review comments."),
    draftConflict: vscode.l10n.t("A different pending review exists on GitHub. Your local draft is preserved; choose which draft to continue before writing."),
    discardReviewDraft: vscode.l10n.t("Discard review draft"),
    discardReviewDraftConfirm: vscode.l10n.t("Discard this pending review and its local draft?"),
    keepReviewDraft: vscode.l10n.t("Keep draft"),
    draftUnavailable: vscode.l10n.t("A pull request id and current head are required before starting a review."),
    changedFilesAndThreads: vscode.l10n.t("{0} changed files · {1} review threads"),
    additionalResultsAvailable: vscode.l10n.t("Additional files or review threads are available in their tabs."),
    filesTitle: vscode.l10n.t("Files ({0})"),
    noFiles: vscode.l10n.t("This pull request has no changed files."),
    loadMoreFiles: vscode.l10n.t("Load more files"),
    loadingMoreFiles: vscode.l10n.t("Loading more files…"),
    loadMoreFilesFailed: vscode.l10n.t("Unable to load more files. Try again."),
    openFileDiff: vscode.l10n.t("Open {0} diff"),
    nativeDiffUnavailable: vscode.l10n.t("Native diff is unavailable for a pull request from another repository."),
    renamedFrom: vscode.l10n.t("renamed from {0}"),
    viewed: vscode.l10n.t("Viewed"),
    unviewed: vscode.l10n.t("Not viewed"),
    markViewed: vscode.l10n.t("Mark {0} as viewed"),
    markUnviewed: vscode.l10n.t("Mark {0} as not viewed"),
    viewedUnavailable: vscode.l10n.t("Unable to update Viewed state because the pull request id is unavailable."),
    addFileComment: vscode.l10n.t("Add file comment"),
    newFileComment: vscode.l10n.t("New file comment"),
    fileComment: vscode.l10n.t("File comment"),
    fileCommentHint: vscode.l10n.t("This comment is attached to the whole file and added to the pending review."),
    addToPendingReview: vscode.l10n.t("Add to pending review"),
    addingFileComment: vscode.l10n.t("Adding file comment…"),
    fileCommentAdded: vscode.l10n.t("File comment added to the pending review."),
    addLineComment: vscode.l10n.t("Add line comment"),
    newLineComment: vscode.l10n.t("New line comment"),
    commentFile: vscode.l10n.t("Changed file"),
    commentLine: vscode.l10n.t("End line"),
    commentLineHint: vscode.l10n.t("Use the changed line number on the pull request head."),
    commentStartLine: vscode.l10n.t("Start line (optional)"),
    commentStartLineHint: vscode.l10n.t("Set this only for a continuous range before the end line."),
    lineComment: vscode.l10n.t("Line comment"),
    commentMessage: vscode.l10n.t("Comment message (optional for a suggestion)"),
    lineCommentHint: vscode.l10n.t("GitHub will validate that this anchor belongs to the changed diff hunk."),
    lineCommentInvalidAnchor: vscode.l10n.t("Enter a positive end line and, for a range, an earlier positive start line."),
    addLineToPendingReview: vscode.l10n.t("Add line comment to pending review"),
    addingLineComment: vscode.l10n.t("Adding line comment…"),
    lineCommentAdded: vscode.l10n.t("Line comment added to the pending review."),
    addSuggestion: vscode.l10n.t("Add suggestion"),
    suggestionCode: vscode.l10n.t("Suggested replacement code"),
    suggestionCodeHint: vscode.l10n.t("This code is sent as a GitHub suggestion for the selected line or range."),
    previewSuggestion: vscode.l10n.t("Preview apply suggestion"),
    suggestionUnavailable: vscode.l10n.t("Suggestion cannot be applied safely"),
    suggestionPreview: vscode.l10n.t("Suggestion preview"),
    suggestionBefore: vscode.l10n.t("Current local text"),
    suggestionAfter: vscode.l10n.t("Suggested replacement"),
    suggestionDelete: vscode.l10n.t("(delete selected lines)"),
    suggestionApplyHint: vscode.l10n.t("Apply changes the open working document only. It does not save, stage, commit, or push; use VS Code Undo to revert."),
    applySuggestion: vscode.l10n.t("Apply suggestion"),
    suggestionApplied: vscode.l10n.t("Suggestion applied to the working document. Use VS Code Undo to revert it."),
    reply: vscode.l10n.t("Reply"),
    replyToThread: vscode.l10n.t("Reply to review thread"),
    threadReply: vscode.l10n.t("Reply"),
    threadReplyHint: vscode.l10n.t("This reply is added to the pending review and submitted with it."),
    addReplyToPendingReview: vscode.l10n.t("Add reply to pending review"),
    addingThreadReply: vscode.l10n.t("Adding reply…"),
    threadReplyAdded: vscode.l10n.t("Reply added to the pending review."),
    editComment: vscode.l10n.t("Edit comment"),
    deleteComment: vscode.l10n.t("Delete comment"),
    saveComment: vscode.l10n.t("Save comment"),
    savingComment: vscode.l10n.t("Saving comment…"),
    deleteCommentConfirm: vscode.l10n.t("Delete this review comment? This cannot be undone."),
    confirmDeleteComment: vscode.l10n.t("Delete comment"),
    commentUpdated: vscode.l10n.t("Review comment updated. Refreshing from GitHub…"),
    commentDeleted: vscode.l10n.t("Review comment deleted. Refreshing from GitHub…"),
    reviewThreads: vscode.l10n.t("Review threads ({0})"),
    checksTitle: vscode.l10n.t("Checks"),
    commitsTitle: vscode.l10n.t("Commits"),
    loadingCommits: vscode.l10n.t("Loading pull request commits"),
    commitsUnavailable: vscode.l10n.t("Unable to load pull request commits. Try again."),
    noCommits: vscode.l10n.t("No commits were found for this pull request."),
    commitsTruncated: vscode.l10n.t("Only the first 100 commits are shown in Review Center."),
    activityTimeline: vscode.l10n.t("Pull request activity"),
    activityFilter: vscode.l10n.t("Activity type"),
    activityAll: vscode.l10n.t("All activity"),
    activityComments: vscode.l10n.t("Comments"),
    activityReviews: vscode.l10n.t("Reviews"),
    activityCommits: vscode.l10n.t("Commits"),
    activityEvents: vscode.l10n.t("Events"),
    loadingActivity: vscode.l10n.t("Loading pull request activity"),
    activityUnavailable: vscode.l10n.t("Unable to load pull request activity. Try again."),
    noActivity: vscode.l10n.t("No activity matches this filter."),
    activityTruncated: vscode.l10n.t("Only the first 100 comments, reviews, and commits are shown in this activity timeline."),
    activityEventsUnavailable: vscode.l10n.t("Repository timeline events are unavailable in this GitHub environment. Comments, reviews, and commits are still shown."),
    activityEventForcePush: vscode.l10n.t("Force-pushed {0}"),
    activityEventReviewRequested: vscode.l10n.t("Requested review from {0}"),
    activityEventAssigned: vscode.l10n.t("Assigned {0}"),
    activityEventLabeled: vscode.l10n.t("Added label {0}"),
    activityEventMilestoned: vscode.l10n.t("Set milestone {0}"),
    activityEventDraft: vscode.l10n.t("Converted this pull request to draft"),
    activityEventReady: vscode.l10n.t("Marked this pull request ready for review"),
    activityEventUnknown: vscode.l10n.t("Pull request event"),
    loadingChecks: vscode.l10n.t("Loading pull request checks"),
    checksUnavailable: vscode.l10n.t("Unable to load pull request checks. Try again."),
    requiredChecksUnknown: vscode.l10n.t("All checks are shown. Required checks are unavailable because repository policy was not queried."),
    requiredChecks: vscode.l10n.t("Required checks"),
    allChecks: vscode.l10n.t("All checks"),
    noRequiredChecks: vscode.l10n.t("This branch protection policy does not require a reported status check."),
    requiredChecksSummary: vscode.l10n.t("{0} required checks from branch protection"),
    requiredChecksStrict: vscode.l10n.t("Branch protection requires the branch to be up to date before merging."),
    requiredChecksNotStrict: vscode.l10n.t("Branch protection does not require the branch to be up to date before merging."),
    noChecks: vscode.l10n.t("No checks were reported for the latest pull request commit."),
    openCheckDetails: vscode.l10n.t("Open check details on GitHub"),
    noThreads: vscode.l10n.t("No file review threads were found."),
    loadMoreThreads: vscode.l10n.t("Load more review threads"),
    loadingMoreThreads: vscode.l10n.t("Loading more review threads…"),
    loadMoreThreadsFailed: vscode.l10n.t("Unable to load more review threads. Try again."),
    locationUnavailable: vscode.l10n.t("Location unavailable"),
    outdated: vscode.l10n.t("Outdated"),
    resolved: vscode.l10n.t("Resolved"),
    resolveThread: vscode.l10n.t("Resolve review thread"),
    unresolveThread: vscode.l10n.t("Reopen review thread"),
    resolvingThread: vscode.l10n.t("Updating review thread…"),
    threadUpdateFailed: vscode.l10n.t("Unable to update the review thread. Try again."),
    noCommentBody: vscode.l10n.t("(No comment body)"),
    updatedUnavailable: vscode.l10n.t("Updated time unavailable"),
    updatedPrefix: vscode.l10n.t("Updated"),
    unknownError: vscode.l10n.t("Unable to load the pull request review."),
  };
}
