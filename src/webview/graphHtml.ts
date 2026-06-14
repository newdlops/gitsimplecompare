// git graph 웹뷰의 HTML/CSP/리소스 URI 생성을 담당하는 모듈.
// - 패널 생애주기와 메시지 처리는 graphPanel.ts 에 남기고, 정적인 UI 조립만 이 파일로 분리한다.
import * as vscode from "vscode";

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
  const scriptUri = script(webview, mediaRoot, "graph.js");
  const featureScriptUri = script(webview, mediaRoot, "graphFeatures.js");
  const branchFilterScriptUri = script(webview, mediaRoot, "graphBranchFilter.js");
  const contextScriptUri = script(webview, mediaRoot, "graphContextMenu.js");
  const localColorScriptUri = script(webview, mediaRoot, "graphLocalColors.js");
  const colorScriptUri = script(webview, mediaRoot, "graphColors.js");
  const detailScriptUri = script(webview, mediaRoot, "graphDetail.js");
  const rebaseScriptUri = script(webview, mediaRoot, "graphRebase.js");
  const rebaseMessageScriptUri = script(webview, mediaRoot, "graphRebaseMessages.js");
  const rebaseDetailScriptUri = script(webview, mediaRoot, "graphRebaseDetail.js");
  const rebasePreviewScriptUri = script(webview, mediaRoot, "graphRebasePreview.js");
  const styleUri = style(webview, mediaRoot, "graph.css");
  const controlsStyleUri = style(webview, mediaRoot, "graphControls.css");
  const detailStyleUri = style(webview, mediaRoot, "graphDetail.css");
  const rebaseStyleUri = style(webview, mediaRoot, "graphRebase.css");
  const codiconStyleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "codicons", "codicon.css")
  );
  const nonce = makeNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join("; ");
  const refreshGraphTitle = vscode.l10n.t("Refresh graph");
  const fetchTitle = vscode.l10n.t("Fetch");
  const pullTitle = vscode.l10n.t("Pull");
  const pushTitle = vscode.l10n.t("Push");
  const openRemoteTitle = vscode.l10n.t("Open Remote Branch");
  const jumpHeadTitle = vscode.l10n.t("Jump to HEAD");
  const toggleDetailTitle = vscode.l10n.t("Toggle commit details");
  const filterBranchesTitle = vscode.l10n.t("Filter visible branches");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${codiconStyleUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <link href="${controlsStyleUri}" rel="stylesheet" />
  <link href="${detailStyleUri}" rel="stylesheet" />
  <link href="${rebaseStyleUri}" rel="stylesheet" />
  <title>Git Graph</title>
</head>
<body class="detail-open">
  <div id="app">
    <main id="graph-pane">
	      <div id="graph-toolbar">
	        <div class="toolbar-group">
	          <button id="refresh-graph" class="icon-button" type="button" title="${refreshGraphTitle}"
	            aria-label="${refreshGraphTitle}" data-tooltip="${refreshGraphTitle}">
	            <span class="codicon codicon-refresh" aria-hidden="true"></span>
	          </button>
	          <button id="fetch-graph" class="icon-button" type="button" title="${fetchTitle}"
	            aria-label="${fetchTitle}" data-tooltip="${fetchTitle}">
	            <span class="codicon codicon-repo-fetch" aria-hidden="true"></span>
	          </button>
	          <button id="pull-graph" class="icon-button" type="button" title="${pullTitle}"
	            aria-label="${pullTitle}" data-tooltip="${pullTitle}">
	            <span class="codicon codicon-repo-pull" aria-hidden="true"></span>
	          </button>
	          <button id="push-graph" class="icon-button" type="button" title="${pushTitle}"
	            aria-label="${pushTitle}" data-tooltip="${pushTitle}">
	            <span class="codicon codicon-repo-push" aria-hidden="true"></span>
	          </button>
	          <button id="open-remote-branch" class="icon-button" type="button" hidden disabled title="${openRemoteTitle}"
	            aria-label="${openRemoteTitle}" data-tooltip="${openRemoteTitle}">
	            <span class="codicon codicon-link-external" aria-hidden="true"></span>
	          </button>
	          <button id="jump-head" class="icon-button" type="button" title="${jumpHeadTitle}"
	            aria-label="${jumpHeadTitle}" data-tooltip="${jumpHeadTitle}">
	            <span class="codicon codicon-target" aria-hidden="true"></span>
	          </button>
	          <button id="toggle-detail" class="icon-button" type="button" title="${toggleDetailTitle}"
	            aria-label="${toggleDetailTitle}" data-tooltip="${toggleDetailTitle}">
	            <span class="codicon codicon-layout-sidebar-right" aria-hidden="true"></span>
	          </button>
        </div>
        <div id="graph-search" role="search">
          <span class="codicon codicon-search" aria-hidden="true"></span>
          <input id="graph-search-input" type="search" placeholder="${vscode.l10n.t(
            "Search commits, branches"
          )}" title="${vscode.l10n.t(
    "Search by commit hash, commit title, or branch name"
  )}" aria-label="${vscode.l10n.t(
    "Search by commit hash, commit title, or branch name"
  )}" />
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
  <script nonce="${nonce}" src="${colorScriptUri}"></script>
  <script nonce="${nonce}" src="${featureScriptUri}"></script>
  <script nonce="${nonce}" src="${localColorScriptUri}"></script>
  <script nonce="${nonce}" src="${contextScriptUri}"></script>
  <script nonce="${nonce}" src="${detailScriptUri}"></script>
  <script nonce="${nonce}" src="${branchFilterScriptUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
  <script nonce="${nonce}" src="${rebaseMessageScriptUri}"></script>
  <script nonce="${nonce}" src="${rebaseDetailScriptUri}"></script>
  <script nonce="${nonce}" src="${rebasePreviewScriptUri}"></script>
  <script nonce="${nonce}" src="${rebaseScriptUri}"></script>
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
