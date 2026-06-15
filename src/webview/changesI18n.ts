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
    toggleSection: vscode.l10n.t("Toggle section"),
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
    generateCommitMessage: vscode.l10n.t("Generate AI Commit Message"),
    generateCommitMessageShort: vscode.l10n.t("AI"),
    aiCommitRequiresStaged: vscode.l10n.t(
      "Stage changes before generating an AI commit message."
    ),
    configureAiCli: vscode.l10n.t("Configure AI CLI"),
    splitChanges: vscode.l10n.t("Stage Hunks"),
    moreActions: vscode.l10n.t("More Actions..."),
    stage: vscode.l10n.t("Stage Changes"),
    unstage: vscode.l10n.t("Unstage Changes"),
    discard: vscode.l10n.t("Discard Changes"),
    stageAll: vscode.l10n.t("Stage All Changes"),
    unstageAll: vscode.l10n.t("Unstage All Changes"),
    discardAll: vscode.l10n.t("Discard All Changes"),
    openFile: vscode.l10n.t("Open File"),
    openChanges: vscode.l10n.t("Open Changes"),
    addToGitignore: vscode.l10n.t("Add to .gitignore"),
    addToExclude: vscode.l10n.t("Add to .git/info/exclude"),
    stashes: vscode.l10n.t("Stashes"),
    noStashes: vscode.l10n.t("No stashes."),
    stashSelected: vscode.l10n.t("Stash Selected Changes"),
    applyStash: vscode.l10n.t("Apply Stash"),
    popStash: vscode.l10n.t("Pop Stash"),
    dropStash: vscode.l10n.t("Drop Stash"),
    branchStash: vscode.l10n.t("Create Branch from Stash"),
  };
}
