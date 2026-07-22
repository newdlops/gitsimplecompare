// Changes 웹뷰에 주입할 런타임 지역화 문자열 묶음.
// - 웹뷰 클라이언트는 vscode.l10n 에 직접 접근할 수 없으므로 extension host 에서 문자열을 주입한다.
import * as vscode from "vscode";

/**
 * Changes 웹뷰 JavaScript 가 사용하는 문자열 사전을 만든다.
 * @returns 웹뷰 전역 `window.__gscI18n` 으로 전달할 key/value 객체
 */
export function changesWebviewI18n(): Record<string, string> {
  return {
    repositories: vscode.l10n.t("Repositories"),
    compareBranches: vscode.l10n.t("Compare Branches"),
    changes: vscode.l10n.t("Changes"),
    current: vscode.l10n.t("current"),
    from: vscode.l10n.t("From:"),
    to: vscode.l10n.t("To:"),
    selectBranch: vscode.l10n.t("(select a branch)"),
    compare: vscode.l10n.t("Compare"),
    compareWithCurrent: vscode.l10n.t("Compare with Current Checkout..."),
    compareWithCurrentTooltip: vscode.l10n.t(
      "Choose one branch to compare with the current working tree"
    ),
    advancedComparison: vscode.l10n.t("Advanced branch comparison"),
    compareAdvanced: vscode.l10n.t("Compare Selected FROM and TO"),
    resetComparison: vscode.l10n.t("Reset Comparison"),
    resetComparisonTooltip: vscode.l10n.t(
      "Clear the current comparison and choose again"
    ),
    gutterReadyTitle: vscode.l10n.t("Line markers ready"),
    gutterReadyDetail: vscode.l10n.t(
      "Open a changed file to see changes beside line numbers."
    ),
    gutterOffTitle: vscode.l10n.t("Line markers unavailable"),
    gutterComparisonHidden: vscode.l10n.t(
      "Comparison markers are turned off. Show them to use line markers."
    ),
    gutterTargetNotCurrent: vscode.l10n.t(
      "This comparison does not target the current checkout, so files open as side-by-side diffs."
    ),
    gutterRefsUnavailable: vscode.l10n.t(
      "The comparison refs are not available locally. Fetch them, then refresh."
    ),
    gutterSettingHidden: vscode.l10n.t(
      "VS Code's scm.diffDecorations setting is hiding line markers."
    ),
    openGutterSettings: vscode.l10n.t("Open Line Marker Settings"),
    showLineMarkers: vscode.l10n.t("Show Line Markers"),
    toggleSection: vscode.l10n.t("Toggle section"),
    collapseSection: vscode.l10n.t("Collapse {0}"),
    expandSection: vscode.l10n.t("Expand {0}"),
    noCompare: vscode.l10n.t("No changes between the selected branches."),
    noChanges: vscode.l10n.t("No working tree changes."),
    conflicts: vscode.l10n.t("Conflicts"),
    noRepos: vscode.l10n.t("No git repository found."),
    change: vscode.l10n.t("Change branch"),
    viewAsTree: vscode.l10n.t("View as Tree"),
    viewAsList: vscode.l10n.t("View as List"),
    stagedChanges: vscode.l10n.t("Staged Changes"),
    commitPlaceholder: vscode.l10n.t("Message (Ctrl+Enter to commit)"),
    commitMultilinePlaceholder: vscode.l10n.t(
      "Subject, blank line, optional body. Ctrl+Enter to commit."
    ),
    commit: vscode.l10n.t("Commit"),
    commitHooks: vscode.l10n.t("File-based Commit Hooks"),
    manageCommitHooks: vscode.l10n.t("Manage file-based commit hooks"),
    activeCommitHooks: vscode.l10n.t("{0} file hooks active"),
    refreshCommitHooks: vscode.l10n.t("Refresh file-based commit hooks"),
    openCommitHooksFolder: vscode.l10n.t("Open hooks folder"),
    createCommitHook: vscode.l10n.t("Create commit hook"),
    noCommitHooks: vscode.l10n.t("No file-based commit hooks found."),
    fileBasedHookScope: vscode.l10n.t(
      "Traditional hook files only. Hooks configured with hook.* are not shown."
    ),
    hookDirectory: vscode.l10n.t("Hook directory: {0}"),
    hookConfigOrigin: vscode.l10n.t("Configured by {0}"),
    sharedHookPath: vscode.l10n.t(
      "This hook path may be shared by multiple repositories."
    ),
    hookPathUnavailable: vscode.l10n.t(
      "The configured hook path is not a directory. Hooks are disabled."
    ),
    hookStateUnavailable: vscode.l10n.t(
      "Commit hook status is unavailable. Refresh to try again."
    ),
    enabledHook: vscode.l10n.t("Enabled"),
    disabledHook: vscode.l10n.t("Disabled"),
    notExecutableHook: vscode.l10n.t("Not executable"),
    missingHookEntrypoint: vscode.l10n.t(
      "The Git hook entrypoint is missing or not executable"
    ),
    conflictingHookFiles: vscode.l10n.t(
      "Active and disabled files both exist"
    ),
    trackedHook: vscode.l10n.t("Tracked"),
    worktreeHook: vscode.l10n.t("Untracked"),
    trackedHookToggleBlocked: vscode.l10n.t(
      "Tracked hooks cannot be toggled here because that would change the working tree."
    ),
    worktreeHookToggleBlocked: vscode.l10n.t(
      "This untracked hook cannot be toggled here because Commit All could include it."
    ),
    proxyHookToggleBlocked: vscode.l10n.t(
      "Husky proxy hooks must be enabled or disabled through Husky."
    ),
    symbolicHookToggleBlocked: vscode.l10n.t(
      "Symbolic-link hooks can be opened but are not toggled here."
    ),
    platformHookToggleBlocked: vscode.l10n.t(
      "Safe hook toggling is unavailable on this platform."
    ),
    renamedHookToggleBlocked: vscode.l10n.t(
      "Hooks already renamed to .disabled can be opened but are not renamed here."
    ),
    enableCommitHook: vscode.l10n.t("Enable {0}"),
    disableCommitHook: vscode.l10n.t("Disable {0}"),
    openCommitHook: vscode.l10n.t("Open {0}"),
    commitChecksFailed: vscode.l10n.t("Commit checks failed"),
    commitFailedDetails: vscode.l10n.t("Commit failed"),
    retryCommit: vscode.l10n.t("Retry commit"),
    dismissCommitFailure: vscode.l10n.t("Dismiss commit failure"),
    showFullOutput: vscode.l10n.t("Show full output"),
    openFailureLocation: vscode.l10n.t("Open {0} at line {1}"),
    noFailureLocations: vscode.l10n.t(
      "The check did not report a file location. See the full output for details."
    ),
    failureItemsTruncated: vscode.l10n.t(
      "Some failures are hidden. See the full output."
    ),
    hookFramework: vscode.l10n.t("Managed by {0}"),
    updatingCommitHooks: vscode.l10n.t("Updating commit hooks..."),
    generateCommitMessage: vscode.l10n.t("Generate AI Commit Message"),
    generateCommitMessageShort: vscode.l10n.t("AI"),
    aiCommitGenerating: vscode.l10n.t("Generating AI commit message..."),
    aiCommitRequiresStaged: vscode.l10n.t(
      "Stage changes before generating an AI commit message."
    ),
    configureAiCli: vscode.l10n.t("Configure AI CLI"),
    aiCommitPlanMode: vscode.l10n.t("AI Plan"),
    enableAiCommitPlanMode: vscode.l10n.t("Enable AI commit plan mode"),
    disableAiCommitPlanMode: vscode.l10n.t("Disable AI commit plan mode"),
    aiCommitPlanPrompt: vscode.l10n.t(
      "Additional AI plan instructions (optional)"
    ),
    aiCommitPlanPromptPlaceholder: vscode.l10n.t(
      "For example: keep tests with implementation; separate docs."
    ),
    aiCommitPlanIntentPlaceholder: vscode.l10n.t(
      "Overall change intent (optional). Ctrl+Enter to plan commits."
    ),
    createAiCommitPlan: vscode.l10n.t("Create AI Commit Plan"),
    aiCommitPlanAmendUnsupported: vscode.l10n.t(
      "AI plan mode is not available for amend commits."
    ),
    splitChanges: vscode.l10n.t("Stage Hunks"),
    moreActions: vscode.l10n.t("More Actions..."),
    stage: vscode.l10n.t("Stage Changes"),
    unstage: vscode.l10n.t("Unstage Changes"),
    stagingChanges: vscode.l10n.t("Staging changes..."),
    unstagingChanges: vscode.l10n.t("Unstaging changes..."),
    updatingGitIndex: vscode.l10n.t("Updating git index..."),
    refreshingChanges: vscode.l10n.t("Refreshing changes..."),
    selectedFiles: vscode.l10n.t("{0} file(s)"),
    allChanges: vscode.l10n.t("all changes"),
    discard: vscode.l10n.t("Discard Changes"),
    stageAll: vscode.l10n.t("Stage All Changes"),
    unstageAll: vscode.l10n.t("Unstage All Changes"),
    discardAll: vscode.l10n.t("Discard All Changes"),
    openFile: vscode.l10n.t("Open File"),
    openChanges: vscode.l10n.t("Open Changes"),
    openFileWithMarkers: vscode.l10n.t("Open File with Comparison Markers"),
    openDeletedFileWithMarkers: vscode.l10n.t(
      "Open Deleted File with Red Line Markers"
    ),
    openFileMarkersHidden: vscode.l10n.t("Open File (line markers hidden)"),
    comparisonUnavailable: vscode.l10n.t(
      "Comparison file unavailable locally"
    ),
    openComparisonDiff: vscode.l10n.t("Open Comparison Diff"),
    addToGitignore: vscode.l10n.t("Add to .gitignore"),
    addToExclude: vscode.l10n.t("Add to .git/info/exclude"),
    history: vscode.l10n.t("History"),
    noHistoryFile: vscode.l10n.t("No file is currently open."),
    noHistory: vscode.l10n.t("No commits for the current file."),
    openHistoryCommit: vscode.l10n.t("Open File Change"),
    stashes: vscode.l10n.t("Stashes"),
    noStashes: vscode.l10n.t("No stashes."),
    stashSelected: vscode.l10n.t("Stash Selected Changes"),
    applyStash: vscode.l10n.t("Apply Stash"),
    popStash: vscode.l10n.t("Pop Stash"),
    dropStash: vscode.l10n.t("Drop Stash"),
    branchStash: vscode.l10n.t("Create Branch from Stash"),
    worktrees: vscode.l10n.t("Worktrees"),
    noWorktrees: vscode.l10n.t("No worktrees found."),
    openWorktree: vscode.l10n.t("Open Worktree"),
    renameWorktree: vscode.l10n.t("Rename Worktree"),
    removeWorktree: vscode.l10n.t("Remove Worktree"),
    mainWorktree: vscode.l10n.t("main"),
    detached: vscode.l10n.t("detached"),
    locked: vscode.l10n.t("locked"),
    prunable: vscode.l10n.t("prunable"),
    pathLabel: vscode.l10n.t("Path"),
    branchLabel: vscode.l10n.t("Branch"),
    headLabel: vscode.l10n.t("HEAD"),
    repositoryLabel: vscode.l10n.t("Repository"),
    yes: vscode.l10n.t("yes"),
    pullRequestStacks: vscode.l10n.t("PR Stacks"),
    noPullRequestStacks: vscode.l10n.t(
      "No open pull requests. Create one to start a stack."
    ),
    loadingPullRequestStacks: vscode.l10n.t("Loading pull request stacks..."),
    refreshPullRequestStacks: vscode.l10n.t("Refresh pull request stacks"),
    createStackPullRequest: vscode.l10n.t("Create stack pull request"),
    createPullRequestAbove: vscode.l10n.t("Create a pull request above this PR"),
    changeStackParent: vscode.l10n.t("Change stack parent (base branch)"),
    openPullRequest: vscode.l10n.t("Open pull request on GitHub"),
    retry: vscode.l10n.t("Retry"),
    draft: vscode.l10n.t("draft"),
    approved: vscode.l10n.t("approved"),
    changesRequested: vscode.l10n.t("changes requested"),
    reviewRequired: vscode.l10n.t("review required"),
    behind: vscode.l10n.t("behind"),
    blocked: vscode.l10n.t("blocked"),
    checksPending: vscode.l10n.t("checks pending"),
    baseLabel: vscode.l10n.t("Base"),
    authorLabel: vscode.l10n.t("Author"),
  };
}
