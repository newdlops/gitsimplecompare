// 실제 media renderer를 deterministic fixture와 연결하는 Playwright 보조 도구.
// - Extension Development Host나 사용자 VS Code 창을 열지 않고 webview protocol의 render 경로를 검증한다.
import path from "node:path";
import type { Page } from "@playwright/test";
import type { WebviewFixture } from "../helpers/webviewFixture";

const WORKSPACE_ROOT = process.cwd();

// browser fixture가 VS Code webview와 같은 role token·form color-scheme을 쓰도록 만든다.
// - 실제 workbench theme을 복제하지 않고 dark/light 각각에서 layout과 contrast를 검토할 최소 token만 제공한다.
const WEBVIEW_THEME_FIXTURE_CSS = `
  :root {
    color-scheme: dark;
    --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --vscode-font-size: 13px;
    --vscode-editor-font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    --vscode-editor-font-size: 12px;
    --vscode-editor-background: #1e1e1e;
    --vscode-foreground: #d4d4d4;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-disabledForeground: #777;
    --vscode-sideBar-background: #252526;
    --vscode-sideBarSectionHeader-background: #272727;
    --vscode-sideBarSectionHeader-foreground: #ccc;
    --vscode-panel-border: #3c3c3c;
    --vscode-widget-border: #454545;
    --vscode-focusBorder: #007fd4;
    --vscode-list-hoverBackground: #2a2d2e;
    --vscode-list-activeSelectionBackground: #094771;
    --vscode-list-activeSelectionForeground: #fff;
    --vscode-list-inactiveSelectionBackground: #37373d;
    --vscode-list-inactiveSelectionForeground: #fff;
    --vscode-input-background: #3c3c3c;
    --vscode-input-foreground: #d4d4d4;
    --vscode-input-border: #3c3c3c;
    --vscode-button-background: #0e639c;
    --vscode-button-foreground: #fff;
    --vscode-button-hoverBackground: #1177bb;
    --vscode-button-secondaryBackground: #3a3d41;
    --vscode-button-secondaryForeground: #fff;
    --vscode-button-secondaryHoverBackground: #45494e;
    --vscode-errorForeground: #f48771;
    --vscode-editorWarning-foreground: #cca700;
    --vscode-editorInfo-foreground: #3794ff;
    --vscode-testing-iconPassed: #89d185;
    --vscode-gitDecoration-addedResourceForeground: #81b88b;
    --vscode-gitDecoration-modifiedResourceForeground: #e2c08d;
    --vscode-gitDecoration-deletedResourceForeground: #f48771;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --vscode-editor-background: #fff;
      --vscode-foreground: #1f1f1f;
      --vscode-descriptionForeground: #616161;
      --vscode-sideBar-background: #f3f3f3;
      --vscode-sideBarSectionHeader-background: #e7e7e7;
      --vscode-sideBarSectionHeader-foreground: #383838;
      --vscode-panel-border: #d0d0d0;
      --vscode-widget-border: #c8c8c8;
      --vscode-focusBorder: #006ab1;
      --vscode-list-hoverBackground: #e8e8e8;
      --vscode-list-activeSelectionBackground: #cce8ff;
      --vscode-list-activeSelectionForeground: #1f1f1f;
      --vscode-list-inactiveSelectionBackground: #e4e6f1;
      --vscode-list-inactiveSelectionForeground: #1f1f1f;
      --vscode-input-background: #fff;
      --vscode-input-foreground: #1f1f1f;
      --vscode-input-border: #cecece;
      --vscode-button-background: #0078d4;
      --vscode-button-secondaryBackground: #e0e0e0;
      --vscode-button-secondaryForeground: #1f1f1f;
      --vscode-button-secondaryHoverBackground: #d5d5d5;
      --vscode-errorForeground: #c72e0f;
      --vscode-editorWarning-foreground: #8b6a00;
      --vscode-editorInfo-foreground: #006ab1;
      --vscode-testing-iconPassed: #388a34;
      --vscode-gitDecoration-addedResourceForeground: #278238;
      --vscode-gitDecoration-modifiedResourceForeground: #b56700;
      --vscode-gitDecoration-deletedResourceForeground: #c72e0f;
    }
  }
`;

/** 테스트 대상 media 파일의 절대 경로를 workspace 기준으로 만든다. */
function mediaPath(...segments: string[]): string {
  return path.join(WORKSPACE_ROOT, "media", ...segments);
}

/** fake VS Code bridge와 locale proxy를 설치할 브라우저 페이지의 초기 HTML을 만든다. */
async function preparePage(
  page: Page,
  rootClass: string,
  i18nKey: "__gscI18n" | "__gscReviewsI18n" | "__gscReviewCenterI18n",
  labels: Record<string, string>
): Promise<void> {
  await page.setContent(`<main id="root" class="gsc-surface ${rootClass}"></main>`);
  await page.addStyleTag({ content: WEBVIEW_THEME_FIXTURE_CSS });
  await page.evaluate(({ i18nKey: key, labels: suppliedLabels }) => {
    const target = window as Window & typeof globalThis & Record<string, unknown>;
    const messages: unknown[] = [];
    const state: Record<string, unknown> = {};
    target.acquireVsCodeApi = () => ({
      getState: () => state,
      setState: (next: Record<string, unknown>) => Object.assign(state, next),
      postMessage: (message: unknown) => messages.push(message),
    });
    target.__gscFixtureMessages = messages;
    target[key] = new Proxy(suppliedLabels, {
      get(current, property) {
        return current[String(property)] || `Fixture ${String(property)}`;
      },
    });
    target.__gscMenu = [];
    target.__gscCommitMenu = [];
  }, { i18nKey, labels });
}

/** CSS 파일들을 선언 순서대로 page에 넣어 visual/a11y smoke가 실제 layout을 보게 한다. */
async function addStyles(page: Page, files: string[]): Promise<void> {
  for (const file of files) {
    await page.addStyleTag({ path: file });
  }
}

/** 일반 script 파일들을 순차 실행해 webview 전역 module 의존성을 보존한다. */
async function addScripts(page: Page, files: string[]): Promise<void> {
  for (const file of files) {
    await page.addScriptTag({ path: file });
  }
}

/** Changes fixture의 host render message를 실제 renderer에 전달한다. */
async function postChangesPayload(page: Page, payload: Record<string, unknown>): Promise<void> {
  await page.evaluate((nextPayload) => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "render", payload: nextPayload } }));
  }, payload);
}

/** Reviews fixture의 host snapshot 또는 error message를 실제 renderer에 전달한다. */
async function postReviewsPayload(page: Page, payload: Record<string, unknown>): Promise<void> {
  await page.evaluate((nextPayload) => {
    const message = "cachedCounts" in nextPayload
      ? { type: "cachedCounts", ...(nextPayload.cachedCounts as Record<string, unknown>) }
      : "message" in nextPayload
      ? { type: "error", ...nextPayload }
      : { type: "snapshot", snapshot: nextPayload.snapshot };
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  }, payload);
}

/** Review Workspace fixture의 host snapshot 또는 error message를 실제 renderer에 전달한다. */
async function postWorkspacePayload(page: Page, payload: Record<string, unknown>): Promise<void> {
  await page.evaluate((nextPayload) => {
    const message = "message" in nextPayload
      ? { type: "error", message: nextPayload.message }
      : { type: "snapshot", snapshot: nextPayload.snapshot };
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  }, payload);
}

/** small Changes fixture로 실제 Changes renderer를 mount한다. */
export async function mountChanges(page: Page, fixture: WebviewFixture): Promise<void> {
  await preparePage(page, "changes", "__gscI18n", {
    repositories: "Repositories", repositoryContext: "Repository context", workingChanges: "Working Changes", tools: "Tools",
    changes: "Changes", reviews: "Reviews", sidebarNavigation: "Git Simple Compare navigation", history: "History", compareBranches: "Compare Branches", stashes: "Stashes", worktrees: "Worktrees",
    noChanges: "No working tree changes.", stagedChanges: "Staged Changes", commit: "Commit", commitPlaceholder: "Message",
    toggleSection: "Toggle section", collapseSection: "Collapse {0}", expandSection: "Expand {0}",
  });
  await addStyles(page, [
    mediaPath("shared", "reset.css"), mediaPath("shared", "tokens.css"), mediaPath("shared", "controls.css"), mediaPath("shared", "navigation.css"),
    mediaPath("shared", "data-display.css"), mediaPath("shared", "feedback.css"), mediaPath("shared", "layout.css"), mediaPath("changes", "changes.css"), mediaPath("changes", "changesCommitBox.css"),
  ]);
  await addScripts(page, [
    mediaPath("shared", "a11y.js"), mediaPath("shared", "dom.js"), mediaPath("shared", "sidebarShell.js"), mediaPath("shared", "keyboard.js"), mediaPath("shared", "overlay.js"), mediaPath("shared", "persistedState.js"), mediaPath("shared", "requestState.js"), mediaPath("shared", "splitter.js"), mediaPath("shared", "virtualList.js"),
    mediaPath("changes", "changesWorkingOperation.js"), mediaPath("changes", "changesWorktrees.js"), mediaPath("changes", "changesCompare.js"),
    mediaPath("changes", "changesStashes.js"), mediaPath("changes", "changesInformationArchitecture.js"), mediaPath("changes", "changesMenu.js"),
    mediaPath("changes", "changesTreeSelection.js"), mediaPath("changes", "changesWorkingTreeActions.js"), mediaPath("changes", "changesHistory.js"),
    mediaPath("changes", "changesSectionLayout.js"), mediaPath("changes", "changesCommitBox.js"), mediaPath("changes", "changes.js"),
  ]);
  await postChangesPayload(page, fixture.payload);
}

/** Personal/Management queue fixture로 실제 Reviews renderer를 mount한다. */
export async function mountReviews(page: Page, fixture: WebviewFixture): Promise<void> {
  await preparePage(page, "reviews", "__gscReviewsI18n", {
    title: "Pull Request Reviews", changes: "Changes", reviews: "Reviews", sidebarNavigation: "Git Simple Compare navigation", refresh: "Refresh pull request reviews", scopeTabs: "Review queue scope", personal: "Personal", management: "Management", reviewWritesDisabled: "Review write actions are disabled in this release.",
    showQueue: "Show {0} review queue", skipToContent: "Skip to main content", loading: "Loading pull request reviews", unavailable: "Reviews are unavailable",
    cachedSummaryTitle: "Cached review summary", cachedSummaryCounts: "{0} personal · {1} management pull requests", cachedSummaryRefreshing: "Showing cached counts while GitHub refreshes the review queues.", cachedSummaryStale: "Showing counts last updated {0} while GitHub refreshes the review queues.", cachedSummaryError: "Cached counts remain available, but GitHub could not refresh the review queues.",
    authenticationRequired: "GitHub authentication required", permissionRequired: "Review queue permission required", connectionUnavailable: "GitHub connection unavailable", rateLimited: "GitHub rate limit reached", signInWithGh: "Sign in with gh", signInWithGhTitle: "Start GitHub CLI sign-in in a terminal", openOutput: "Open Git Simple Compare Output", openOutputTitle: "Open Git Simple Compare Output for review queue diagnostics",
    retry: "Retry", retryTitle: "Retry loading pull request reviews", requestedForYou: "Requested for you", authoredByYou: "Authored by you",
    assignedToYou: "Assigned to you", mentioned: "Mentioned", participated: "Participated", repositoryManagement: "Repository management",
    noRequested: "No requested reviews", noAuthored: "No authored reviews", noAssigned: "No assigned reviews", noMentioned: "No mentions", noParticipated: "No participation", noManagement: "No management pull requests",
    filterPullRequests: "Filter pull requests", filterPullRequestsHint: "Search title, author, label, or number", sortPullRequests: "Sort pull requests", sortByUpdated: "Recently updated", sortByTitle: "Title", sortByNumber: "Number", filterQueueStatus: "Filter queue status", statusAll: "All statuses", statusChangesRequested: "Changes requested", statusMergeBlocked: "Merge blocked", statusStale: "Stale", statusDraft: "Draft",
    savedQueues: "Saved queues", savedQueuesLocalOnly: "Saved only in this VS Code workspace", managementScope: "Management scope", repositoryScope: "This repository", ownerScope: "Organization or owner", ownerScopeHint: "Enter an organization or user login", teamScope: "Team", teamScopeHint: "Enter organization/team", openManagementQueue: "Open management queue", newSavedQueue: "New saved queue", savedQueueName: "Queue name", savedQueueQuery: "Search query", savedQueueQueryHint: "GitHub search qualifiers", createSavedQueue: "Create saved queue", updateSavedQueue: "Update saved queue", deleteSavedQueue: "Delete saved queue", editSavedQueue: "Edit saved queue", moveSavedQueueUp: "Move saved queue up", moveSavedQueueDown: "Move saved queue down",
    openReviewCenter: "Open Review Center for pull request #{0}", bulkManagement: "Bulk management", bulkManagementHint: "Select pull requests below.",
    selectedPullRequestsAcrossRepositories: "{0} selected · {1} repositories", selectAllPullRequests: "Select all", clearPullRequestSelection: "Clear selection",
    selectPullRequest: "Select pull request #{0}", bulkOperation: "Operation", addAssignees: "Add assignees", removeAssignees: "Remove assignees", addLabels: "Add labels", removeLabels: "Remove labels",
    requestReviewers: "Request reviewers", removeReviewers: "Remove review requests", setMilestone: "Set milestone", clearMilestone: "Clear milestone", bulkValues: "Names or labels",
    bulkValuesHint: "Separate multiple values with commas.", previewBulkChanges: "Preview bulk changes", queueLoadedStatus: "{0} loaded pull requests · Updated {1}", updated: "Updated {0}", reviewRequests: "Review: {0}", mergeState: "Merge: {0}", assigned: "Assigned: {0}", labels: "Labels: {0}", draft: "Draft",
  });
  await addStyles(page, [mediaPath("shared", "reset.css"), mediaPath("shared", "tokens.css"), mediaPath("shared", "controls.css"), mediaPath("shared", "navigation.css"), mediaPath("shared", "data-display.css"), mediaPath("shared", "feedback.css"), mediaPath("shared", "layout.css"), mediaPath("review-queue", "reviews.css")]);
  await addScripts(page, [
    mediaPath("shared", "a11y.js"), mediaPath("shared", "dom.js"), mediaPath("shared", "sidebarShell.js"), mediaPath("shared", "keyboard.js"), mediaPath("shared", "overlay.js"), mediaPath("shared", "persistedState.js"), mediaPath("shared", "requestState.js"), mediaPath("shared", "splitter.js"), mediaPath("shared", "virtualList.js"),
    mediaPath("review-queue", "reviewsQueueControls.js"), mediaPath("review-queue", "reviewsQueuePagination.js"), mediaPath("review-queue", "reviewsQueueWindow.js"), mediaPath("review-queue", "reviewsCachedSummary.js"),
    mediaPath("review-queue", "reviewsSavedQueues.js"), mediaPath("review-queue", "reviewsQueueKeyboard.js"), mediaPath("review-queue", "reviews.js"),
  ]);
  await postReviewsPayload(page, fixture.payload);
}

/** 단일 PR detail fixture로 실제 Review Workspace renderer를 mount한다. */
export async function mountReviewWorkspace(page: Page, fixture: WebviewFixture): Promise<void> {
  await preparePage(page, "review-center", "__gscReviewCenterI18n", {
    reviewCenter: "Review Workspace", overview: "Overview", files: "Files", commits: "Commits", checks: "Checks", activity: "Activity",
    refresh: "Refresh", openGitHub: "Open GitHub", openGitHubTitle: "Open this pull request in GitHub", contentTabs: "Review content", showTab: "Show {0}",
    skipToContent: "Skip to main content", loading: "Loading review", unavailable: "Review is unavailable", reviewWritesDisabled: "Review write actions are disabled in this release.", retry: "Retry", retryTitle: "Retry loading review",
    description: "Description", noDescription: "No description", reviewState: "Review state", metadata: "Metadata", assignees: "Assignees", labels: "Labels", milestone: "Milestone", reviewers: "Reviewers", none: "None",
    manageMetadata: "Manage metadata", managementOperation: "Operation", addLabels: "Add labels", removeLabels: "Remove labels", addAssignees: "Add assignees", removeAssignees: "Remove assignees", requestReviewers: "Request reviewers", removeReviewers: "Remove review requests", setMilestone: "Set milestone", clearMilestone: "Clear milestone", convertToDraft: "Convert to draft", markReadyForReview: "Mark ready for review",
    metadataValues: "Values", metadataValuesHint: "Comma-separated values", milestoneValues: "Milestone", milestoneValuesHint: "Milestone number", reviewerValues: "Reviewers", reviewerValuesHint: "User or team", clearMilestoneHint: "Clear the milestone", stageChangeHint: "This changes review state", previewChanges: "Preview changes", previewingChanges: "Preparing changes", valuesRequired: "Enter a value", metadataPermissionDenied: "You cannot manage metadata",
    draft: "Draft", readyForReview: "Ready for review", baseUnavailable: "Base unavailable", headUnavailable: "Head unavailable", reviewDecisionSummary: "Review: {0}", mergeStateSummary: "Merge: {0}", changedFilesAndThreads: "Changed files and threads", filesTitle: "Files", noFiles: "No changed files", openFileDiff: "Open file diff", markViewed: "Mark viewed", markUnviewed: "Mark unviewed", viewed: "Viewed", unviewed: "Unviewed", addFileComment: "Add file comment", newFileComment: "New file comment", reviewThreads: "Review threads", reply: "Reply", threadReply: "Reply to thread", lineComment: "Comment", addLineComment: "Add line comment", activityTimeline: "Activity timeline",
  });
  await addStyles(page, [mediaPath("shared", "reset.css"), mediaPath("shared", "tokens.css"), mediaPath("shared", "controls.css"), mediaPath("shared", "navigation.css"), mediaPath("shared", "data-display.css"), mediaPath("shared", "feedback.css"), mediaPath("shared", "layout.css"), mediaPath("review-center", "reviewCenter.css")]);
  await addScripts(page, [
    mediaPath("shared", "a11y.js"), mediaPath("shared", "dom.js"), mediaPath("shared", "keyboard.js"), mediaPath("shared", "overlay.js"), mediaPath("shared", "persistedState.js"), mediaPath("shared", "requestState.js"), mediaPath("shared", "splitter.js"), mediaPath("shared", "virtualList.js"),
    mediaPath("review-center", "reviewCenterDraft.js"), mediaPath("review-center", "reviewCenterFileComment.js"), mediaPath("review-center", "reviewCenterLineComment.js"),
    mediaPath("review-center", "reviewCenterThreadReply.js"), mediaPath("review-center", "reviewCenterCommentActions.js"), mediaPath("review-center", "reviewCenterSuggestionApply.js"),
    mediaPath("review-center", "reviewCenterCommits.js"), mediaPath("review-center", "reviewCenterChecks.js"), mediaPath("review-center", "reviewCenterManagement.js"),
    mediaPath("review-center", "reviewCenterActivity.js"), mediaPath("review-center", "reviewCenterKeyboard.js"), mediaPath("review-center", "reviewCenterFormat.js"), mediaPath("review-center", "reviewCenter.js"),
  ]);
  await postWorkspacePayload(page, fixture.payload);
}
