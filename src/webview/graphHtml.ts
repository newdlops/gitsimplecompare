// git graph 웹뷰의 HTML/CSP/리소스 URI 생성을 담당하는 모듈.
// - 패널 생애주기와 메시지 처리는 graphPanel.ts 에 남기고, 정적인 UI 조립만 이 파일로 분리한다.
import * as vscode from "vscode";
import {
  sharedWebviewResources,
  sharedWebviewStyleTags,
} from "./sharedWebviewResources";

/**
 * git graph 웹뷰 HTML 을 만든다.
 * @param panel 리소스 URI 변환과 CSP source 를 제공하는 웹뷰 패널
 * @param extensionUri 확장 루트 URI
 * @returns CSP nonce 와 미디어 리소스 URI 가 주입된 HTML 문자열
 */
export function buildGraphHtml(
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri
): string {
  const webview = panel.webview;
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media", "graph");
  const scriptUri = script(webview, vscode.Uri.joinPath(extensionUri, "media", "bundled"), "graph.js");
  const styleUri = style(webview, mediaRoot, "graph.css");
  const healthStyleUri = style(webview, mediaRoot, "graphHealth.css");
  const worktreeStyleUri = style(webview, mediaRoot, "graphWorktrees.css");
  const compactStyleUri = style(webview, mediaRoot, "graphCompact.css");
  const prStyleUri = style(webview, mediaRoot, "graphPr.css");
  const prFilesStyleUri = style(webview, mediaRoot, "graphPrFiles.css");
  const prLabelsStyleUri = style(webview, mediaRoot, "graphPrLabels.css");
  const prStacksStyleUri = style(webview, mediaRoot, "graphPrStacks.css");
  const controlsStyleUri = style(webview, mediaRoot, "graphControls.css");
  const detailStyleUri = style(webview, mediaRoot, "graphDetail.css");
  const rebaseStyleUri = style(webview, mediaRoot, "graphRebase.css");
  const rebaseProgressStyleUri = style(webview, mediaRoot, "graphRebaseProgress.css");
  const rebaseAiStyleUri = style(webview, mediaRoot, "graphRebaseAi.css");
  const reflogStyleUri = style(webview, mediaRoot, "graphReflog.css");
  const reflogVirtualStyleUri = style(webview, mediaRoot, "graphReflogVirtual.css");
  const codiconStyleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "codicons", "codicon.css")
  );
  const sharedResources = sharedWebviewResources(webview, extensionUri);
  const nonce = makeNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    // Graph의 행 위치·레인 색상은 renderer가 style 속성으로 갱신한다. style/script 태그 허용 범위는 유지한다.
    `style-src-attr 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join("; ");
  const refreshGraphTitle = vscode.l10n.t("Refresh graph");
  const fetchTitle = vscode.l10n.t("Fetch");
  const fetchTagsTitle = vscode.l10n.t("Fetch Tags");
  const pullTitle = vscode.l10n.t("Pull");
  const pushTitle = vscode.l10n.t("Push");
  const forcePushTitle = vscode.l10n.t("Force Push...");
  const openRemoteTitle = vscode.l10n.t("Open Remote Branch");
  const jumpHeadTitle = vscode.l10n.t("Jump to HEAD");
  const toggleDetailTitle = vscode.l10n.t("Toggle commit details");
  const filterBranchesTitle = vscode.l10n.t("Filter visible branches");
  const searchScopeTitle = vscode.l10n.t("Search scope");
  const prListTitle = vscode.l10n.t("Show pull requests");
  const prPreviewTitle = vscode.l10n.t("Preview staged pull request");
  const prStacksTitle = vscode.l10n.t("Manage pull request stacks");
  const reflogTitle = vscode.l10n.t("Show reflog recovery");
  const syncCommandsTitle = vscode.l10n.t("Graph synchronization commands");
  const reviewCommandsTitle = vscode.l10n.t("Pull request and stack commands");
  const navigationCommandsTitle = vscode.l10n.t("Graph navigation and details commands");
  const showOutputTitle = vscode.l10n.t("Show Git Simple Compare Output");
  // 외부 webview script는 vscode.l10n에 직접 접근할 수 없으므로 필요한 문자열만 안전한 JSON으로 주입한다.
  const prStackI18n = JSON.stringify({
    locale: vscode.env.language,
    prAuthor: vscode.l10n.t("Author"), prReviewers: vscode.l10n.t("Reviewers"),
    prOpen: vscode.l10n.t("Open"), prMerged: vscode.l10n.t("Merged"), prClosed: vscode.l10n.t("Closed"), prDraft: vscode.l10n.t("Draft"),
    prUpdated: vscode.l10n.t("Updated {0}"), reviewRequired: vscode.l10n.t("Review required"),
    reviewShowAll: vscode.l10n.t("Show all {0} loaded reviewers"), reviewShowLess: vscode.l10n.t("Show fewer reviewers"),
    reviewLess: vscode.l10n.t("Show less"), reviewPartial: vscode.l10n.t("Partial reviewer list"),
    unknownAuthor: vscode.l10n.t("Unknown author"), reviewLoading: vscode.l10n.t("Loading reviewers…"),
    reviewUnavailable: vscode.l10n.t("Reviewers unavailable"), reviewNone: vscode.l10n.t("No reviewers"),
    reviewAwaiting: vscode.l10n.t("Awaiting review"), reviewApproved: vscode.l10n.t("Approved"),
    reviewChanges: vscode.l10n.t("Changes requested"), reviewCommented: vscode.l10n.t("Commented"),
    reviewDismissed: vscode.l10n.t("Dismissed"), reviewPending: vscode.l10n.t("Pending"),
    reviewTeam: vscode.l10n.t("Team"), reviewMore: vscode.l10n.t("More reviewers are not shown"),
    loadingPullRequests: vscode.l10n.t("Loading pull requests…"),
    loadingPrDetails: vscode.l10n.t("Loading remaining commits and comments…"),
    loadingPrCommits: vscode.l10n.t("Loading pull request commits…"),
    jumpToPrRow: vscode.l10n.t("Jump to pull request #{0} row in the graph"),
    loadingPrJump: vscode.l10n.t("Locating pull request #{0} in the graph…"),
    commitNotAvailableInGraph: vscode.l10n.t("Could not locate the commit in the current graph. Fetch the source branch or adjust branch filters, then try again."),
    retryPullRequests: vscode.l10n.t("Retry loading pull requests"),
    retryPrDetails: vscode.l10n.t("Retry loading changed files"),
    loadingPrFiles: vscode.l10n.t("Loading changed files ({0} of {1})…"),
    refreshingPrFiles: vscode.l10n.t("Refreshing changed files…"),
    prFilesRefreshFailed: vscode.l10n.t("Changed files could not be refreshed."),
    loadingPrFileComments: vscode.l10n.t("Loading file comments…"),
    prFileCommentsUnavailable: vscode.l10n.t("File comments could not be loaded."),
    retryPrDetailsAll: vscode.l10n.t("Retry loading pull request details"),
    loadingGraphCommit: vscode.l10n.t("Locating commit {0} in the graph…"),
    openPrCommit: vscode.l10n.t("Open commit {0} details"),
    jumpToCommit: vscode.l10n.t("Jump to commit {0} in the graph"),
    viewCommitDetails: vscode.l10n.t("View commit details"),
    loadingCommitDetails: vscode.l10n.t("Loading commit details…"),
    noCommitMessage: vscode.l10n.t("(No commit message)"),
    noRelatedCommits: vscode.l10n.t("No related commits."),
    unavailable: vscode.l10n.t("Pull request stack data is unavailable."),
    unavailableReason: vscode.l10n.t("Pull request stacks unavailable: {0}"),
    manageCount: vscode.l10n.t("Manage pull request stacks ({0} layers)"),
    showLayerFlow: vscode.l10n.t("Show stack layer {0}: {1} ← {0}"),
    pullRequestFlow: vscode.l10n.t("Pull request flow: {0} ← {1}"),
    stackDetails: vscode.l10n.t("Pull request stack details"),
    stacks: vscode.l10n.t("Pull request stacks"),
    localRepository: vscode.l10n.t("Local repository"),
    addLayer: vscode.l10n.t("Add a new stack layer"),
    layerDetails: vscode.l10n.t("Pull request stack layer details"),
    addChild: vscode.l10n.t("Add a child layer above {0}"),
    editParent: vscode.l10n.t("Edit local Stack parent for {0}"),
    deleteLocal: vscode.l10n.t("Delete local Stack metadata for this connected Stack"),
    githubOnly: vscode.l10n.t("GitHub-only Stack relation. Local parent editing and deletion are unavailable."),
    localParent: vscode.l10n.t("Local parent"),
    publishedParent: vscode.l10n.t("Published PR base"),
    restackThenSync: vscode.l10n.t("Local and published parents differ. Restack, then Submit / Sync to update the PR base."),
    actionBusy: vscode.l10n.t("Stack action in progress"),
    restackDescendants: vscode.l10n.t("Restack {0} and descendants"),
    submitStack: vscode.l10n.t("Submit or sync the stack containing {0}"),
    advanceChildren: vscode.l10n.t("Advance children after merged PR #{0}"),
    parent: vscode.l10n.t("Parent"),
    localBranch: vscode.l10n.t("Local branch"),
    yes: vscode.l10n.t("Yes"),
    no: vscode.l10n.t("No"),
    pullRequest: vscode.l10n.t("Pull request"),
    notSubmitted: vscode.l10n.t("Not submitted"),
    restack: vscode.l10n.t("Restack"),
    restackRequired: vscode.l10n.t("Required — parent moved"),
    upToDate: vscode.l10n.t("Up to date"),
    worktree: vscode.l10n.t("Worktree"),
    childLayers: vscode.l10n.t("Child layers"),
    topLayer: vscode.l10n.t("This is the top layer."),
    base: vscode.l10n.t("base"),
    local: vscode.l10n.t("LOCAL"),
    remote: vscode.l10n.t("REMOTE"),
    noLayers: vscode.l10n.t("No stack layers yet. Add one from a parent branch to start."),
    addFirstLayer: vscode.l10n.t("Add the first stack layer"),
    showAll: vscode.l10n.t("Show all pull request stacks"),
    openPullRequest: vscode.l10n.t("Open pull request #{0} in browser"),
    previewPullRequest: vscode.l10n.t("Preview staged pull request"),
    showChild: vscode.l10n.t("Show child layer {0}"),
    showLayer: vscode.l10n.t("Show stack layer {0}"),
  }).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${sharedWebviewStyleTags(sharedResources)}
  <link href="${codiconStyleUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <link href="${healthStyleUri}" rel="stylesheet" />
  <link href="${worktreeStyleUri}" rel="stylesheet" />
  <link href="${compactStyleUri}" rel="stylesheet" />
  <link href="${prStyleUri}" rel="stylesheet" />
  <link href="${prFilesStyleUri}" rel="stylesheet" />
  <link href="${prLabelsStyleUri}" rel="stylesheet" />
  <link href="${prStacksStyleUri}" rel="stylesheet" />
  <link href="${controlsStyleUri}" rel="stylesheet" />
  <link href="${detailStyleUri}" rel="stylesheet" />
  <link href="${rebaseStyleUri}" rel="stylesheet" />
  <link href="${rebaseProgressStyleUri}" rel="stylesheet" />
  <link href="${rebaseAiStyleUri}" rel="stylesheet" />
  <link href="${reflogStyleUri}" rel="stylesheet" />
  <link href="${reflogVirtualStyleUri}" rel="stylesheet" />
  <title>Git Graph</title>
</head>
<body class="gsc-surface detail-open">
  <div id="app">
    <main id="graph-pane">
	      <div id="graph-toolbar">
	        <div class="toolbar-group" role="group" aria-label="${syncCommandsTitle}">
	          <button id="refresh-graph" class="icon-button" type="button" title="${refreshGraphTitle}"
	            aria-label="${refreshGraphTitle}" data-tooltip="${refreshGraphTitle}">
	            <span class="codicon codicon-refresh" aria-hidden="true"></span>
	          </button>
          <button id="fetch-graph" class="icon-button" type="button" title="${fetchTitle}"
            aria-label="${fetchTitle}" data-tooltip="${fetchTitle}">
            <span class="codicon codicon-repo-fetch" aria-hidden="true"></span>
          </button>
          <button id="fetch-tags-graph" class="icon-button" type="button" title="${fetchTagsTitle}"
            aria-label="${fetchTagsTitle}" data-tooltip="${fetchTagsTitle}">
            <span class="codicon codicon-tag" aria-hidden="true"></span>
          </button>
          <button id="pull-graph" class="icon-button" type="button" title="${pullTitle}"
            aria-label="${pullTitle}" data-tooltip="${pullTitle}">
            <span class="codicon codicon-repo-pull" aria-hidden="true"></span>
	          </button>
	          <button id="push-graph" class="icon-button" type="button" title="${pushTitle}"
	            aria-label="${pushTitle}" data-tooltip="${pushTitle}">
	            <span class="codicon codicon-repo-push" aria-hidden="true"></span>
	          </button>
          <button id="force-push-graph" class="icon-button danger" type="button" title="${forcePushTitle}"
	            aria-label="${forcePushTitle}" data-tooltip="${forcePushTitle}">
	            <span class="codicon codicon-repo-force-push" aria-hidden="true"></span>
	          </button>
          <button id="open-remote-branch" class="icon-button" type="button" hidden disabled title="${openRemoteTitle}"
	            aria-label="${openRemoteTitle}" data-tooltip="${openRemoteTitle}">
	            <span class="codicon codicon-link-external" aria-hidden="true"></span>
	          </button>
	        </div>
	        <div class="toolbar-group" role="group" aria-label="${reviewCommandsTitle}">
	          <button id="graph-pr-list" class="icon-button" type="button" title="${prListTitle}"
	            aria-label="${prListTitle}" data-tooltip="${prListTitle}">
	            <span class="codicon codicon-git-pull-request" aria-hidden="true"></span>
	          </button>
          <button id="graph-pr-stacks" class="icon-button" type="button" title="${prStacksTitle}"
            aria-label="${prStacksTitle}" data-tooltip="${prStacksTitle}">
            <span class="codicon codicon-layers" aria-hidden="true"></span>
          </button>
          <button id="graph-pr-preview" class="icon-button" type="button" title="${prPreviewTitle}"
            aria-label="${prPreviewTitle}" data-tooltip="${prPreviewTitle}">
            <span class="codicon codicon-preview" aria-hidden="true"></span>
          </button>
          <button id="graph-reflog" class="icon-button" type="button" title="${reflogTitle}"
            aria-label="${reflogTitle}" data-tooltip="${reflogTitle}"
            aria-controls="graph-reflog-panel" aria-expanded="false">
	            <span class="codicon codicon-history" aria-hidden="true"></span>
	          </button>
	        </div>
	        <div class="toolbar-group" role="group" aria-label="${navigationCommandsTitle}">
	          <button id="jump-head" class="icon-button" type="button" title="${jumpHeadTitle}"
	            aria-label="${jumpHeadTitle}" data-tooltip="${jumpHeadTitle}">
	            <span class="codicon codicon-target" aria-hidden="true"></span>
	          </button>
	          <button id="toggle-detail" class="icon-button" type="button" title="${toggleDetailTitle}"
	            aria-label="${toggleDetailTitle}" data-tooltip="${toggleDetailTitle}"
              aria-controls="detail" aria-expanded="true">
	            <span class="codicon codicon-layout-sidebar-right" aria-hidden="true"></span>
	          </button>
        </div>
        <div id="graph-search" role="search">
          <span class="codicon codicon-search" aria-hidden="true"></span>
          <input id="graph-search-input" type="search" placeholder="${vscode.l10n.t(
            "Search commits, branches, tags"
          )}" title="${vscode.l10n.t(
    "Search by commit hash, commit title, branch name, or tag name"
  )}" aria-label="${vscode.l10n.t(
    "Search by commit hash, commit title, branch name, or tag name"
  )}" />
          <select id="graph-search-scope" title="${searchScopeTitle}" aria-label="${searchScopeTitle}">
            <option value="all">${vscode.l10n.t("All")}</option>
            <option value="commit">${vscode.l10n.t("Commits")}</option>
            <option value="branch">${vscode.l10n.t("Branches")}</option>
            <option value="tag">${vscode.l10n.t("Tags")}</option>
          </select>
          <button id="graph-branch-filter-button" class="search-icon-button" type="button"
            title="${filterBranchesTitle}" aria-label="${filterBranchesTitle}" data-tooltip="${filterBranchesTitle}"
            aria-haspopup="dialog" aria-expanded="false">
            <span class="codicon codicon-filter" aria-hidden="true"></span>
          </button>
          <div id="graph-search-results" role="listbox" hidden></div>
          <div id="graph-branch-filter-menu" role="dialog" aria-label="${filterBranchesTitle}" hidden></div>
        </div>
        <span id="load-status" aria-live="polite"></span>
      </div>
      <section id="graph-health" role="status" aria-live="polite" hidden>
        <span id="graph-health-icon" class="codicon codicon-warning" aria-hidden="true"></span>
        <div class="graph-health-copy">
          <strong id="graph-health-title"></strong>
          <span id="graph-health-detail"></span>
          <code id="graph-health-refs" translate="no" hidden></code>
        </div>
        <button id="graph-health-output" class="gsc-button gsc-button--ghost graph-health-action"
          type="button" title="${showOutputTitle}" aria-label="${showOutputTitle}"
          data-tooltip="${showOutputTitle}">${vscode.l10n.t("Show Output")}</button>
      </section>
      <section id="graph-pr-panel" aria-label="${prListTitle}" hidden></section>
      <section id="graph-reflog-panel" aria-label="${reflogTitle}" hidden></section>
      <div id="graph" tabindex="0"><div id="graph-content"></div></div>
    </main>
    <div id="main-splitter" class="splitter" role="separator" aria-orientation="vertical" tabindex="0"
      title="${vscode.l10n.t("Resize commit details")}" aria-label="${vscode.l10n.t(
    "Resize commit details"
  )}"></div>
    <div id="detail"><p class="placeholder">${vscode.l10n.t(
      "Select a commit to see details."
    )}</p></div>
  </div>
  <div id="drawer-backdrop"></div>
  <script nonce="${nonce}">window.GscPrStackI18n = ${prStackI18n};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/**
 * graph 미디어 스크립트 파일을 웹뷰에서 읽을 수 있는 URI 로 변환한다.
 * @param webview 대상 웹뷰
 * @param mediaRoot graph 미디어 디렉터리 URI
 * @param fileName 스크립트 파일명
 * @returns CSP source 에 맞는 웹뷰 URI
 */
function script(
  webview: vscode.Webview,
  mediaRoot: vscode.Uri,
  fileName: string
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, fileName));
}

/**
 * graph 미디어 스타일 파일을 웹뷰에서 읽을 수 있는 URI 로 변환한다.
 * @param webview 대상 웹뷰
 * @param mediaRoot graph 미디어 디렉터리 URI
 * @param fileName 스타일 파일명
 * @returns CSP source 에 맞는 웹뷰 URI
 */
function style(
  webview: vscode.Webview,
  mediaRoot: vscode.Uri,
  fileName: string
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, fileName));
}

/** CSP 의 script nonce(인라인/허용 스크립트 식별용 1회성 난수 문자열)를 만든다. */
function makeNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
