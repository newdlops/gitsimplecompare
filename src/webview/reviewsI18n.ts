// Reviews sidebar webview가 host의 vscode.l10n 번역을 재사용하는 문자열 계약.
// - media JavaScript는 vscode.l10n에 직접 접근할 수 없으므로 host가 직렬화해 전달한다.
import * as vscode from "vscode";

/** Reviews renderer가 필요로 하는 지역화된 정적 문구. */
export interface ReviewsI18n {
  title: string;
  changes: string;
  reviews: string;
  sidebarNavigation: string;
  refresh: string;
  scopeTabs: string;
  personal: string;
  management: string;
  showQueue: string;
  skipToContent: string;
  loading: string;
  cachedSummaryTitle: string;
  cachedSummaryCounts: string;
  cachedSummaryRefreshing: string;
  cachedSummaryStale: string;
  cachedSummaryError: string;
  unavailable: string;
  reviewWritesDisabled: string;
  authenticationRequired: string;
  permissionRequired: string;
  connectionUnavailable: string;
  rateLimited: string;
  retry: string;
  retryTitle: string;
  signInWithGh: string;
  signInWithGhTitle: string;
  openOutput: string;
  openOutputTitle: string;
  requestedForYou: string;
  noRequested: string;
  authoredByYou: string;
  noAuthored: string;
  assignedToYou: string;
  noAssigned: string;
  mentioned: string;
  noMentioned: string;
  participated: string;
  noParticipated: string;
  repositoryManagement: string;
  noManagement: string;
  managementScope: string;
  repositoryScope: string;
  ownerScope: string;
  ownerScopeHint: string;
  teamScope: string;
  teamScopeHint: string;
  applyManagementScope: string;
  savedQueues: string;
  openManagementQueue: string;
  savedQueuesLocalOnly: string;
  newSavedQueue: string;
  editSavedQueue: string;
  savedQueueName: string;
  savedQueueQuery: string;
  savedQueueQueryPreview: string;
  savedQueueQueryHint: string;
  createSavedQueue: string;
  updateSavedQueue: string;
  moveSavedQueueUp: string;
  moveSavedQueueDown: string;
  deleteSavedQueue: string;
  deleteSavedQueueConfirm: string;
  keepSavedQueue: string;
  openReviewCenter: string;
  draft: string;
  updated: string;
  reviewRequests: string;
  mergeState: string;
  assigned: string;
  labels: string;
  bulkManagement: string;
  bulkManagementHint: string;
  selectedPullRequests: string;
  selectedPullRequestsAcrossRepositories: string;
  selectAllPullRequests: string;
  clearPullRequestSelection: string;
  selectPullRequest: string;
  bulkOperation: string;
  bulkValues: string;
  bulkValuesHint: string;
  milestoneNumber: string;
  addAssignees: string;
  removeAssignees: string;
  addLabels: string;
  removeLabels: string;
  requestReviewers: string;
  removeReviewers: string;
  setMilestone: string;
  clearMilestone: string;
  previewBulkChanges: string;
  previewingBulkChanges: string;
  bulkPreview: string;
  bulkPreviewSummary: string;
  bulkPreviewWillChange: string;
  bulkPreviewAlreadyUpToDate: string;
  bulkPreviewUnavailable: string;
  applyBulkChanges: string;
  cancelBulkChanges: string;
  cancelRemainingBulkChanges: string;
  bulkResultSummary: string;
  bulkResultCancellationWarning: string;
  bulkResultVerificationWarning: string;
  bulkResultVerificationDetails: string;
  retryFailedBulkChanges: string;
  noManagementChanges: string;
  filterPullRequests: string;
  filterPullRequestsHint: string;
  sortPullRequests: string;
  sortByUpdated: string;
  sortByTitle: string;
  sortByNumber: string;
  filterQueueStatus: string;
  statusAll: string;
  statusChangesRequested: string;
  statusMergeBlocked: string;
  statusStale: string;
  statusDraft: string;
  queueLaneUnavailable: string;
  queueLaneTruncated: string;
  loadMorePullRequests: string;
  loadingMorePullRequests: string;
  queueLaneCapped: string;
  queueLoadedStatus: string;
  showMorePullRequests: string;
}

/** host locale을 적용한 Reviews webview 문자열 묶음을 만든다. */
export function reviewsI18n(): ReviewsI18n {
  return {
    title: vscode.l10n.t("Pull Request Reviews"),
    changes: vscode.l10n.t("Changes"),
    reviews: vscode.l10n.t("Reviews"),
    sidebarNavigation: vscode.l10n.t("Git Simple Compare navigation"),
    refresh: vscode.l10n.t("Refresh pull request reviews"),
    scopeTabs: vscode.l10n.t("Review queue scope"),
    personal: vscode.l10n.t("Personal"),
    management: vscode.l10n.t("Management"),
    showQueue: vscode.l10n.t("Show {0} review queue"),
    skipToContent: vscode.l10n.t("Skip to main content"),
    loading: vscode.l10n.t("Loading pull request reviews"),
    cachedSummaryTitle: vscode.l10n.t("Cached review summary"),
    cachedSummaryCounts: vscode.l10n.t("{0} personal · {1} management pull requests"),
    cachedSummaryRefreshing: vscode.l10n.t("Showing cached counts while GitHub refreshes the review queues."),
    cachedSummaryStale: vscode.l10n.t("Showing counts last updated {0} while GitHub refreshes the review queues."),
    cachedSummaryError: vscode.l10n.t("Cached counts remain available, but GitHub could not refresh the review queues."),
    unavailable: vscode.l10n.t("Reviews are unavailable"),
    reviewWritesDisabled: vscode.l10n.t("Review write actions are disabled by settings. Enable Git Simple Compare: Review Writes Enabled to use them."),
    authenticationRequired: vscode.l10n.t("GitHub authentication required"),
    permissionRequired: vscode.l10n.t("Review queue permission required"),
    connectionUnavailable: vscode.l10n.t("GitHub connection unavailable"),
    rateLimited: vscode.l10n.t("GitHub rate limit reached"),
    retry: vscode.l10n.t("Retry"),
    retryTitle: vscode.l10n.t("Retry loading pull request reviews"),
    signInWithGh: vscode.l10n.t("Sign in with gh"),
    signInWithGhTitle: vscode.l10n.t("Start GitHub CLI sign-in in a terminal"),
    openOutput: vscode.l10n.t("Open Git Simple Compare Output"),
    openOutputTitle: vscode.l10n.t("Open Git Simple Compare Output for review queue diagnostics"),
    requestedForYou: vscode.l10n.t("Requested for you"),
    noRequested: vscode.l10n.t("No open pull requests currently request your review."),
    authoredByYou: vscode.l10n.t("Authored by you"),
    noAuthored: vscode.l10n.t("You have no open pull requests in this repository."),
    assignedToYou: vscode.l10n.t("Assigned to you"),
    noAssigned: vscode.l10n.t("No open pull requests are assigned to you."),
    mentioned: vscode.l10n.t("Mentioned"),
    noMentioned: vscode.l10n.t("You are not mentioned on any open pull requests."),
    participated: vscode.l10n.t("Participated"),
    noParticipated: vscode.l10n.t("You have not participated in any open pull requests."),
    repositoryManagement: vscode.l10n.t("Repository management"),
    noManagement: vscode.l10n.t("No open pull requests need repository management."),
    managementScope: vscode.l10n.t("Management scope"),
    repositoryScope: vscode.l10n.t("Current repository"),
    ownerScope: vscode.l10n.t("Owner (organization or user)"),
    ownerScopeHint: vscode.l10n.t("Owner scope searches open pull requests across repositories owned by that organization or user."),
    teamScope: vscode.l10n.t("Team (organization/team)"),
    teamScopeHint: vscode.l10n.t("Team scope searches open pull requests requesting review from that team across repositories."),
    applyManagementScope: vscode.l10n.t("Apply management scope"),
    savedQueues: vscode.l10n.t("Saved queues"),
    openManagementQueue: vscode.l10n.t("All open pull requests"),
    savedQueuesLocalOnly: vscode.l10n.t("Saved queues are local to this GitHub account and are not shared with your team."),
    newSavedQueue: vscode.l10n.t("New saved queue"),
    editSavedQueue: vscode.l10n.t("Edit saved queue"),
    savedQueueName: vscode.l10n.t("Queue name"),
    savedQueueQuery: vscode.l10n.t("GitHub search qualifiers"),
    savedQueueQueryPreview: vscode.l10n.t("Active GitHub search qualifiers"),
    savedQueueQueryHint: vscode.l10n.t("Example: label:blocked review-requested:@me"),
    createSavedQueue: vscode.l10n.t("Save queue"),
    updateSavedQueue: vscode.l10n.t("Update saved queue"),
    moveSavedQueueUp: vscode.l10n.t("Move saved queue up"),
    moveSavedQueueDown: vscode.l10n.t("Move saved queue down"),
    deleteSavedQueue: vscode.l10n.t("Delete saved queue"),
    deleteSavedQueueConfirm: vscode.l10n.t("Delete this local saved queue?"),
    keepSavedQueue: vscode.l10n.t("Keep queue"),
    openReviewCenter: vscode.l10n.t("Open Review Center for pull request #{0}"),
    draft: vscode.l10n.t("Draft"),
    updated: vscode.l10n.t("Updated {0}"),
    reviewRequests: vscode.l10n.t("Review: {0}"),
    mergeState: vscode.l10n.t("Merge: {0}"),
    assigned: vscode.l10n.t("Assigned: {0}"),
    labels: vscode.l10n.t("Labels: {0}"),
    bulkManagement: vscode.l10n.t("Bulk management"),
    bulkManagementHint: vscode.l10n.t("Select pull requests below, preview their current metadata, then confirm the shared change."),
    selectedPullRequests: vscode.l10n.t("{0} selected"),
    selectedPullRequestsAcrossRepositories: vscode.l10n.t("{0} selected · {1} repositories"),
    selectAllPullRequests: vscode.l10n.t("Select all loaded pull requests matching the current filters"),
    clearPullRequestSelection: vscode.l10n.t("Clear selected pull requests"),
    selectPullRequest: vscode.l10n.t("Select pull request #{0} for bulk management"),
    bulkOperation: vscode.l10n.t("Operation"),
    bulkValues: vscode.l10n.t("Names or labels"),
    bulkValuesHint: vscode.l10n.t("Separate multiple values with commas."),
    milestoneNumber: vscode.l10n.t("Milestone number"),
    addAssignees: vscode.l10n.t("Add assignees"),
    removeAssignees: vscode.l10n.t("Remove assignees"),
    addLabels: vscode.l10n.t("Add labels"),
    removeLabels: vscode.l10n.t("Remove labels"),
    requestReviewers: vscode.l10n.t("Request reviewers"),
    removeReviewers: vscode.l10n.t("Remove review requests"),
    setMilestone: vscode.l10n.t("Set milestone"),
    clearMilestone: vscode.l10n.t("Clear milestone"),
    previewBulkChanges: vscode.l10n.t("Preview bulk changes"),
    previewingBulkChanges: vscode.l10n.t("Preparing bulk preview…"),
    bulkPreview: vscode.l10n.t("Bulk change preview"),
    bulkPreviewSummary: vscode.l10n.t("{0} pull requests will change; {1} will be skipped."),
    bulkPreviewWillChange: vscode.l10n.t("Will change"),
    bulkPreviewAlreadyUpToDate: vscode.l10n.t("Already up to date"),
    bulkPreviewUnavailable: vscode.l10n.t("Unavailable"),
    applyBulkChanges: vscode.l10n.t("Apply to {0} pull requests"),
    cancelBulkChanges: vscode.l10n.t("Cancel bulk changes"),
    cancelRemainingBulkChanges: vscode.l10n.t("Cancel remaining updates"),
    bulkResultSummary: vscode.l10n.t("Bulk update finished: {0} applied, {1} skipped, {2} failed."),
    bulkResultCancellationWarning: vscode.l10n.t("{0} pull requests were not changed because you cancelled the remaining updates."),
    bulkResultVerificationWarning: vscode.l10n.t("{0} updates need attention because GitHub did not confirm every requested metadata value."),
    bulkResultVerificationDetails: vscode.l10n.t("GitHub could not confirm: {0}"),
    retryFailedBulkChanges: vscode.l10n.t("Retry {0} failed pull requests"),
    noManagementChanges: vscode.l10n.t("No metadata changes are needed."),
    filterPullRequests: vscode.l10n.t("Filter pull requests"),
    filterPullRequestsHint: vscode.l10n.t("Search title, number, author, label, or reviewer"),
    sortPullRequests: vscode.l10n.t("Sort pull requests"),
    sortByUpdated: vscode.l10n.t("Recently updated"),
    sortByTitle: vscode.l10n.t("Title"),
    sortByNumber: vscode.l10n.t("Pull request number"),
    filterQueueStatus: vscode.l10n.t("Queue status"),
    statusAll: vscode.l10n.t("All statuses"),
    statusChangesRequested: vscode.l10n.t("Changes requested"),
    statusMergeBlocked: vscode.l10n.t("Merge blocked"),
    statusStale: vscode.l10n.t("Stale (7+ days)"),
    statusDraft: vscode.l10n.t("Draft"),
    queueLaneUnavailable: vscode.l10n.t("This queue could not be loaded. Refresh to retry."),
    queueLaneTruncated: vscode.l10n.t("More pull requests match this queue. Refine the filter or saved GitHub query."),
    loadMorePullRequests: vscode.l10n.t("Load more pull requests"),
    loadingMorePullRequests: vscode.l10n.t("Loading more pull requests…"),
    queueLaneCapped: vscode.l10n.t("Review Center shows up to 1,000 pull requests in one queue. Refine the filter or saved GitHub query."),
    queueLoadedStatus: vscode.l10n.t("{0} loaded pull requests · Updated {1}"),
    showMorePullRequests: vscode.l10n.t("Show {0} more pull requests"),
  };
}
