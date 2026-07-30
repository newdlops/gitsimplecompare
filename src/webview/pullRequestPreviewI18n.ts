import * as vscode from "vscode";

/** PR 생성 준비 웹뷰가 사용하는 번역 문자열 계약이다. */
export interface PullRequestPreviewI18n {
  readonly title: string;
  readonly refresh: string;
  readonly generate: string;
  readonly configure: string;
  readonly copy: string;
  readonly create: string;
  readonly openGitHub: string;
  readonly loading: string;
  readonly ready: string;
  readonly busy: string;
  readonly existing: string;
  readonly selectTarget: string;
  readonly selectLocalSource: string;
  readonly missingMessage: string;
  readonly noChanges: string;
  readonly updating: string;
  readonly composer: string;
  readonly titleLabel: string;
  readonly descriptionOptional: string;
  readonly titleRequired: string;
  readonly unableToUpdate: string;
  readonly retryPreview: string;
  readonly generating: string;
  readonly generateNeedsTarget: string;
  readonly generateNeedsChanges: string;
  readonly copyUnavailable: string;
  readonly selectTargetState: string;
  readonly draft: string;
  readonly noChangesState: string;
  readonly repository: string;
  readonly changed: string;
  readonly staged: string;
  readonly diffSummary: string;
  readonly additions: string;
  readonly deletions: string;
  readonly changedFiles: string;
  readonly filesChanged: string;
  readonly commits: string;
  readonly conversation: string;
  readonly localDraft: string;
  readonly noDescription: string;
  readonly showFile: string;
  readonly viewedLocal: string;
  readonly unviewedLocal: string;
  readonly markViewedLocal: string;
  readonly markUnviewedLocal: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly sourceRole: string;
  readonly targetRole: string;
  readonly changeSourceBranch: string;
  readonly changeTargetBranch: string;
  readonly selectTargetBranch: string;
  readonly showBranchOptions: string;
  readonly hideBranchOptions: string;
  readonly noMatchingBranches: string;
  readonly sections: string;
  readonly showSection: string;
  readonly noChangedFiles: string;
  readonly noCommits: string;
  readonly selectTargetToInspectCommitFiles: string;
  readonly loadingCommitFiles: string;
  readonly selectCommitToInspectChangedFiles: string;
  readonly openEditableDiff: string;
  readonly openQuickEditor?: string;
  readonly quickEditNeedsCheckout?: string;
  readonly quickEditDeleted?: string;
  readonly expandFileDiff: string;
  readonly collapseFileDiff: string;
  readonly filesDisplayMode: string;
  readonly cardsMode: string;
  readonly cardsModeTooltip: string;
  readonly continuousMode: string;
  readonly continuousModeTooltip: string;
  readonly diffLayout: string;
  readonly unifiedMode: string;
  readonly unifiedModeTooltip: string;
  readonly splitMode: string;
  readonly splitModeTooltip: string;
  readonly changedFilesView: string;
  readonly showCommitFiles: string;
  readonly resizeChangedFilesInspector: string;
  readonly lineCountsUnavailable: string;
  readonly diffUnavailable: string;
  readonly diffLinesTruncated: string;
  readonly diffExpandUnchangedLines: string;
  readonly diffShowMoreUnchangedLines: string;
  readonly diffCollapseUnchangedLines: string;
  readonly diffCollapseUnchanged: string;
  readonly diffLine: string;
  readonly diffReview: string;
  readonly diffUnknownAuthor: string;
}

/**
 * VS Code 로케일에 맞춘 PR 생성 준비 웹뷰 문자열을 만든다.
 * @returns HTML 셸과 생성 스크립트에서 함께 쓰는 번역 문자열
 */
export function pullRequestPreviewI18n(): PullRequestPreviewI18n {
  return {
    title: vscode.l10n.t("Pull request preview"),
    refresh: vscode.l10n.t("Refresh staged PR preview"),
    generate: vscode.l10n.t("Generate AI pull request message"),
    configure: vscode.l10n.t("Configure AI CLI"),
    copy: vscode.l10n.t("Copy pull request message"),
    create: vscode.l10n.t("Create Pull Request on GitHub"),
    openGitHub: vscode.l10n.t("Open pull request on GitHub"),
    loading: vscode.l10n.t("Loading…"),
    ready: vscode.l10n.t("Ready to create pull request"),
    busy: vscode.l10n.t("Publishing Pull Request to GitHub…"),
    existing: vscode.l10n.t("A Pull Request already exists for this source branch"),
    selectTarget: vscode.l10n.t("Select a target branch before creating a Pull Request"),
    selectLocalSource: vscode.l10n.t("Select a local source branch before creating a Pull Request"),
    missingMessage: vscode.l10n.t("Enter a Pull Request title before publishing"),
    noChanges: vscode.l10n.t("No changes to publish as a Pull Request"),
    updating: vscode.l10n.t("Wait for the Pull Request preview to finish updating"),
    composer: vscode.l10n.t("Pull request message"), titleLabel: vscode.l10n.t("Title"), descriptionOptional: vscode.l10n.t("Description (optional)"), titleRequired: vscode.l10n.t("A title is required to create a pull request."),
    unableToUpdate: vscode.l10n.t("Unable to update preview."), retryPreview: vscode.l10n.t("Retry preview"), generating: vscode.l10n.t("Generating AI pull request message…"), generateNeedsTarget: vscode.l10n.t("Select a target branch before generating a PR message"), generateNeedsChanges: vscode.l10n.t("Stage changes before generating an AI pull request message"), copyUnavailable: vscode.l10n.t("No pull request message to copy"),
    selectTargetState: vscode.l10n.t("Select target"), draft: vscode.l10n.t("Draft"), noChangesState: vscode.l10n.t("No changes"), repository: vscode.l10n.t("Repository"), changed: vscode.l10n.t("Changed files"), staged: vscode.l10n.t("Staged"), diffSummary: vscode.l10n.t("Diff summary"), additions: vscode.l10n.t("Additions"), deletions: vscode.l10n.t("Deletions"), changedFiles: vscode.l10n.t("Changed files"), filesChanged: vscode.l10n.t("Files changed"), commits: vscode.l10n.t("Commits"), conversation: vscode.l10n.t("Conversation"), localDraft: vscode.l10n.t("Local draft"), noDescription: vscode.l10n.t("No pull request description was provided."), showFile: vscode.l10n.t("Show {0} file"), viewedLocal: vscode.l10n.t("Viewed locally"), unviewedLocal: vscode.l10n.t("Not viewed locally"), markViewedLocal: vscode.l10n.t("Mark file as viewed locally"), markUnviewedLocal: vscode.l10n.t("Mark file as not viewed locally"),
    sourceBranch: vscode.l10n.t("Source branch"), targetBranch: vscode.l10n.t("Target branch"), sourceRole: vscode.l10n.t("Source"), targetRole: vscode.l10n.t("Target"), changeSourceBranch: vscode.l10n.t("Change source branch"), changeTargetBranch: vscode.l10n.t("Change target branch"), selectTargetBranch: vscode.l10n.t("Select target branch"), showBranchOptions: vscode.l10n.t("Show {0} branch options"), hideBranchOptions: vscode.l10n.t("Hide {0} branch options"), noMatchingBranches: vscode.l10n.t("No matching branches"),
    sections: vscode.l10n.t("Pull request sections"), showSection: vscode.l10n.t("Show {0}"), noChangedFiles: vscode.l10n.t("No changed files."), noCommits: vscode.l10n.t("No commits ahead of target."), selectTargetToInspectCommitFiles: vscode.l10n.t("Select a target branch to inspect commit files."), loadingCommitFiles: vscode.l10n.t("Loading commit files…"), selectCommitToInspectChangedFiles: vscode.l10n.t("Select a commit to inspect changed files."), openEditableDiff: vscode.l10n.t("Open editable diff"), openQuickEditor: vscode.l10n.t("Quick edit with change markers"), quickEditNeedsCheckout: vscode.l10n.t("Check out the source branch to use quick edit"), quickEditDeleted: vscode.l10n.t("Deleted files cannot be quick edited."), expandFileDiff: vscode.l10n.t("Expand file diff for {0}"), collapseFileDiff: vscode.l10n.t("Collapse file diff for {0}"),
    filesDisplayMode: vscode.l10n.t("Files display mode"), cardsMode: vscode.l10n.t("Cards"), cardsModeTooltip: vscode.l10n.t("Show each file in a separate card"), continuousMode: vscode.l10n.t("Continuous"), continuousModeTooltip: vscode.l10n.t("Show files as one continuous diff stream"), diffLayout: vscode.l10n.t("Diff layout"), unifiedMode: vscode.l10n.t("Unified"), unifiedModeTooltip: vscode.l10n.t("Show a unified one-column diff"), splitMode: vscode.l10n.t("Split"), splitModeTooltip: vscode.l10n.t("Show a split two-column diff"), changedFilesView: vscode.l10n.t("Changed files view"), showCommitFiles: vscode.l10n.t("Show files changed in commit {0}"), resizeChangedFilesInspector: vscode.l10n.t("Resize changed files inspector"), lineCountsUnavailable: vscode.l10n.t("Line counts unavailable"),
    diffUnavailable: vscode.l10n.t("Diff snippet is unavailable for this file."), diffLinesTruncated: vscode.l10n.t("{0} lines truncated", "{0}"), diffExpandUnchangedLines: vscode.l10n.t("Expand {0} unchanged lines", "{0}"), diffShowMoreUnchangedLines: vscode.l10n.t("Show {0} more unchanged lines ({1} hidden)", "{0}", "{1}"), diffCollapseUnchangedLines: vscode.l10n.t("Collapse {0} unchanged lines", "{0}"), diffCollapseUnchanged: vscode.l10n.t("Collapse unchanged lines"), diffLine: vscode.l10n.t("line {0}", "{0}"), diffReview: vscode.l10n.t("review"), diffUnknownAuthor: vscode.l10n.t("unknown"),
  };
}
