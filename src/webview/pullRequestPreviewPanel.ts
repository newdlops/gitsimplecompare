// staged 상태를 target branch 로 PR 한다고 가정한 모의 페이지 웹뷰.
// - PR 데이터 생성은 PullRequestService 에 맡기고, 이 파일은 패널 생애주기와 렌더링만 담당한다.
import * as vscode from "vscode";
import {
  PullRequestInfo,
  PullRequestService,
} from "../git/pullRequestService";
import { logError } from "../ui/outputLog";

type PreviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "openExistingPr" };

/** staged PR preview 웹뷰 패널 */
export class PullRequestPreviewPanel {
  private static current: PullRequestPreviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * staged PR preview 패널을 만들거나 기존 패널을 재사용한다.
   * @param service PR preview 데이터를 만드는 서비스
   * @param baseBranch PR target branch
   * @param existingPr 기존 PR 에서 preview 를 연 경우의 PR 정보
   */
  static createOrShow(
    extensionUri: vscode.Uri,
    service: PullRequestService,
    baseBranch?: string,
    existingPr?: PullRequestInfo
  ): void {
    if (PullRequestPreviewPanel.current) {
      PullRequestPreviewPanel.current.service = service;
      PullRequestPreviewPanel.current.baseBranch = baseBranch;
      PullRequestPreviewPanel.current.existingPr = existingPr;
      PullRequestPreviewPanel.current.panel.reveal();
      void PullRequestPreviewPanel.current.sendPreview();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "gitSimpleCompare.prPreview",
      vscode.l10n.t("Staged PR Preview"),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    PullRequestPreviewPanel.current = new PullRequestPreviewPanel(
      panel,
      extensionUri,
      service,
      baseBranch,
      existingPr
    );
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private service: PullRequestService,
    private baseBranch?: string,
    private existingPr?: PullRequestInfo
  ) {
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(
      (msg: PreviewMessage) => this.handleMessage(msg),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /** 패널 리소스를 정리한다. */
  private dispose(): void {
    PullRequestPreviewPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  /**
   * 웹뷰 메시지를 처리한다.
   * @param msg 웹뷰에서 보낸 메시지
   */
  private async handleMessage(msg: PreviewMessage): Promise<void> {
    if (msg.type === "ready" || msg.type === "refresh") {
      await this.sendPreview();
      return;
    }
    if (msg.type === "openExistingPr" && this.existingPr?.url) {
      await vscode.env.openExternal(vscode.Uri.parse(this.existingPr.url));
    }
  }

  /** staged preview 데이터를 읽어 웹뷰에 보낸다. */
  private async sendPreview(): Promise<void> {
    try {
      const preview = await this.service.getStagedPreview(
        this.baseBranch,
        this.existingPr
      );
      this.post({ type: "preview", preview });
    } catch (error) {
      logError("staged PR preview failed", error);
      this.post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** preview 웹뷰 HTML 을 만든다. */
  private html(): string {
    const nonce = nonceValue();
    const codiconUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "codicons", "codicon.css")
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${this.panel.webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${this.panel.webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
      <meta http-equiv="Content-Security-Policy" content="${csp}" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <link href="${codiconUri}" rel="stylesheet" />
      <style nonce="${nonce}">${styles()}</style>
      <title>Staged PR Preview</title></head><body>
      <header class="topbar">
        <div class="topbar-title">
          <span class="codicon codicon-git-pull-request" aria-hidden="true"></span>
          <h1>Pull request preview</h1>
        </div>
        <div class="actions">
          <button id="refresh" class="icon-button" type="button" title="Refresh staged PR preview"
            aria-label="Refresh staged PR preview" data-tooltip="Refresh staged PR preview">
            <span class="codicon codicon-refresh" aria-hidden="true"></span>
          </button>
          <button id="open-pr" class="icon-button" type="button" title="Open related pull request"
            aria-label="Open related pull request" data-tooltip="Open related pull request" hidden>
            <span class="codicon codicon-mark-github" aria-hidden="true"></span>
          </button>
        </div>
      </header>
      <main id="content"><p class="placeholder">Loading...</p></main>
      <script nonce="${nonce}">${script()}</script>
    </body></html>`;
  }

  /** 타입이 보장된 메시지를 웹뷰로 보낸다. */
  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }
}

/** nonce 문자열을 만든다. */
function nonceValue(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

/** preview 페이지 스타일을 반환한다. */
function styles(): string {
  return `
    :root { --border: var(--vscode-panel-border); --muted: var(--vscode-descriptionForeground); --panel: var(--vscode-editorWidget-background); --subtle: var(--vscode-sideBar-background); --green: #2ea043; --green-bg: rgba(46, 160, 67, .16); --red: #f85149; --blue: #58a6ff; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 14px; border-bottom: 1px solid var(--border); background: var(--panel); }
    .topbar-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .topbar-title .codicon { color: var(--green); }
    h1 { margin: 0; font-size: 14px; font-weight: 600; }
    main { padding: 16px; }
    .actions { display: flex; gap: 6px; }
    .icon-button { position: relative; display: inline-grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    .icon-button:hover { background: var(--vscode-button-hoverBackground); }
    .icon-button[data-tooltip]::after { content: attr(data-tooltip); position: fixed; z-index: 100; top: 40px; right: 10px; max-width: min(420px, calc(100vw - 20px)); padding: 4px 7px; border: 1px solid var(--vscode-widget-border); border-radius: 3px; color: var(--vscode-quickInput-foreground); background: #252526; opacity: 0; pointer-events: none; white-space: normal; overflow-wrap: anywhere; }
    .icon-button[data-tooltip]:hover::after, .icon-button[data-tooltip]:focus-visible::after { opacity: 1; }
    .pr-page { max-width: 1080px; margin: 0 auto; display: grid; gap: 12px; }
    .pr-header { border-bottom: 1px solid var(--border); padding-bottom: 12px; }
    .title-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .state-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border-radius: 999px; background: var(--green-bg); color: var(--green); font-weight: 600; white-space: nowrap; }
    .state-pill.draft { color: var(--vscode-charts-purple); background: color-mix(in srgb, var(--vscode-charts-purple) 18%, transparent); }
    .state-pill.empty { color: var(--muted); background: var(--subtle); }
    .pr-title { margin: 0; font-size: 22px; line-height: 1.25; font-weight: 600; overflow-wrap: anywhere; }
    .pr-number { color: var(--muted); font-weight: 400; }
    .branch-flow { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 8px; color: var(--muted); }
    .branch-flow code { padding: 2px 6px; border: 1px solid var(--border); border-radius: 4px; color: var(--blue); background: var(--subtle); font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .tabbar { display: flex; gap: 2px; border-bottom: 1px solid var(--border); }
    .tab { display: flex; align-items: center; gap: 6px; padding: 9px 12px; border: 0; border-bottom: 2px solid transparent; color: var(--muted); background: transparent; font: inherit; cursor: pointer; }
    .tab:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .tab.active { border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-foreground); font-weight: 600; }
    .count { min-width: 18px; padding: 1px 6px; border-radius: 999px; text-align: center; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 11px; }
    .content-grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 12px; align-items: start; }
    .content-single { display: grid; }
    .side-stack { display: grid; gap: 12px; }
    .panel { border: 1px solid var(--border); border-radius: 6px; background: var(--panel); overflow: hidden; }
    .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--border); background: var(--subtle); font-weight: 600; }
    .panel-title { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .comment-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); background: var(--subtle); color: var(--muted); }
    .avatar { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-weight: 700; }
    .body-pre { margin: 0; padding: 14px; overflow: auto; white-space: pre-wrap; font-family: var(--vscode-font-family); line-height: 1.45; }
    .quick-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .metric { padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); }
    .metric-label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; }
    .metric-value { margin-top: 5px; font-weight: 600; overflow-wrap: anywhere; }
    .file-list, .commit-list { display: grid; }
    .file-row, .commit-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 8px 10px; border-top: 1px solid var(--border); }
    .file-row:first-child, .commit-row:first-child { border-top: 0; }
    .file-name, .commit-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-dir, .commit-hash { color: var(--muted); font-size: 12px; }
    .file-row[data-status="A"] .status-icon { color: var(--green); }
    .file-row[data-status="D"] .status-icon { color: var(--red); }
    .file-row[data-status="R"] .status-icon, .file-row[data-status="C"] .status-icon { color: var(--blue); }
    .stat { display: flex; gap: 6px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .add { color: var(--green); }
    .del { color: var(--red); }
    .empty, .placeholder { margin: 0; padding: 14px; color: var(--muted); }
    .warning { border-color: var(--vscode-inputValidation-warningBorder, var(--border)); }
    @media (max-width: 820px) {
      main { padding: 10px; }
      .content-grid { grid-template-columns: 1fr; }
      .quick-stats { grid-template-columns: 1fr; }
      .pr-title { font-size: 18px; }
    }
  `;
}

/** preview 페이지 클라이언트 스크립트를 반환한다. */
function script(): string {
  return `
    const vscode = acquireVsCodeApi();
    const content = document.getElementById("content");
    const openPr = document.getElementById("open-pr");
    let activeTab = 'conversation';
    let latestPreview = null;
    document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    openPr.addEventListener("click", () => vscode.postMessage({ type: "openExistingPr" }));
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "preview") render(msg.preview);
      if (msg.type === "error") content.innerHTML = '<p class="empty">' + esc(msg.message) + '</p>';
    });
    function render(preview) {
      latestPreview = preview;
      const files = preview.files || [];
      const commits = preview.commits || [];
      const additions = files.reduce((sum, file) => sum + (file.additions || 0), 0);
      const deletions = files.reduce((sum, file) => sum + (file.deletions || 0), 0);
      openPr.hidden = !preview.existingPr?.url;
      content.innerHTML =
        '<div class="pr-page">' +
          prHeader(preview) +
          tabbar(files.length, commits.length) +
          '<section class="quick-stats">' +
            metric('repo', 'Repository', preview.repository || 'unknown') +
            metric('files', 'Changed files', String(files.length)) +
            metric('diff', 'Diff summary', '+' + additions + ' / -' + deletions) +
          '</section>' +
          tabContent(preview, files, commits) +
        '</div>';
      bindTabs();
    }
    function prHeader(preview) {
      const pr = preview.existingPr || {};
      const number = pr.number ? ' <span class="pr-number">#' + esc(pr.number) + '</span>' : '';
      const state = pr.isDraft ? 'Draft' : (pr.state || (preview.hasStagedChanges ? 'Open' : 'No changes'));
      const stateClass = pr.isDraft ? 'draft' : (!preview.hasStagedChanges && !pr.state ? 'empty' : '');
      return '<section class="pr-header">' +
        '<div class="title-row"><span class="state-pill ' + stateClass + '"><span class="codicon codicon-git-pull-request" aria-hidden="true"></span>' + esc(state) + '</span>' +
        '<h2 class="pr-title">' + esc(preview.title) + number + '</h2></div>' +
        '<div class="branch-flow"><span class="codicon codicon-git-branch" aria-hidden="true"></span><code>' + esc(preview.currentBranch) + '</code>' +
        '<span class="codicon codicon-arrow-right" aria-hidden="true"></span><code>' + esc(preview.targetBranch) + '</code></div>' +
      '</section>';
    }
    function tabbar(fileCount, commitCount) {
      return '<nav class="tabbar" aria-label="Pull request sections">' +
        tabButton('conversation', 'comment-discussion', 'Conversation', '') +
        tabButton('files', 'files', 'Files changed', fileCount) +
        tabButton('commits', 'git-commit', 'Commits', commitCount) +
      '</nav>';
    }
    function tabButton(tab, icon, label, count) {
      const active = activeTab === tab;
      return '<button class="tab' + (active ? ' active' : '') + '" type="button" data-tab="' + esc(tab) + '" ' +
        'aria-selected="' + (active ? 'true' : 'false') + '" title="' + esc(label) + '" aria-label="' + esc(label) + '">' +
        '<span class="codicon codicon-' + icon + '" aria-hidden="true"></span>' + esc(label) +
        (count === '' ? '' : ' <span class="count">' + esc(count) + '</span>') + '</button>';
    }
    function tabContent(preview, files, commits) {
      if (activeTab === 'files') {
        return '<section class="content-single">' + filesPanel(files) + '</section>';
      }
      if (activeTab === 'commits') {
        return '<section class="content-single">' + commitsPanel(commits) + '</section>';
      }
      return '<section class="content-grid">' + conversation(preview) +
        '<div class="side-stack">' + filesPanel(files) + commitsPanel(commits) + '</div></section>';
    }
    function bindTabs() {
      content.querySelectorAll('[data-tab]').forEach((button) => {
        button.addEventListener('click', () => {
          activeTab = button.dataset.tab || 'conversation';
          if (latestPreview) render(latestPreview);
        });
      });
    }
    function conversation(preview) {
      const author = preview.existingPr?.author || preview.currentBranch || 'local';
      return '<article class="panel">' +
        '<div class="comment-head"><span class="avatar">' + esc(initial(author)) + '</span><strong>' + esc(author) + '</strong><span>opened this preview into ' + esc(preview.targetBranch) + '</span></div>' +
        '<pre class="body-pre">' + esc(bodyText(preview)) + '</pre>' +
      '</article>';
    }
    function bodyText(preview) {
      if (preview.body) return preview.body;
      return preview.existingPr ? 'No PR body.' : 'No staged PR body generated.';
    }
    function filesPanel(files) {
      return '<section class="panel' + (files.length ? '' : ' warning') + '"><div class="panel-header"><span class="panel-title"><span class="codicon codicon-files" aria-hidden="true"></span>Files changed</span><span class="count">' + esc(files.length) + '</span></div>' +
        (files.length ? '<div class="file-list">' + files.map(fileRow).join('') + '</div>' : '<p class="empty">No staged files.</p>') + '</section>';
    }
    function commitsPanel(commits) {
      return '<section class="panel"><div class="panel-header"><span class="panel-title"><span class="codicon codicon-git-commit" aria-hidden="true"></span>Commits</span><span class="count">' + esc(commits.length) + '</span></div>' +
        (commits.length ? '<div class="commit-list">' + commits.map(commitRow).join('') + '</div>' : '<p class="empty">No commits ahead of target.</p>') + '</section>';
    }
    function metric(icon, label, value) {
      return '<div class="metric"><div class="metric-label"><span class="codicon codicon-' + icon + '" aria-hidden="true"></span>' + esc(label) + '</div><div class="metric-value">' + esc(value) + '</div></div>';
    }
    function fileRow(file) {
      const path = file.oldPath ? file.oldPath + ' -> ' + file.path : file.path;
      const slash = path.lastIndexOf('/');
      const name = slash >= 0 ? path.slice(slash + 1) : path;
      const dir = slash >= 0 ? path.slice(0, slash) : '';
      return '<div class="file-row" data-status="' + esc(file.status) + '" title="' + esc(path) + '">' +
        '<span class="status-icon codicon ' + statusIcon(file.status) + '" aria-hidden="true"></span>' +
        '<span class="file-name">' + esc(name) + (dir ? '<span class="file-dir"> ' + esc(dir) + '</span>' : '') + '</span>' +
        '<span class="stat"><span class="add">+' + esc(file.additions || 0) + '</span><span class="del">-' + esc(file.deletions || 0) + '</span></span></div>';
    }
    function commitRow(line) {
      const parts = String(line || '').split(/\\s+/);
      const hash = /^[0-9a-f]{7,40}$/i.test(parts[0] || '') ? parts.shift() : '';
      const title = parts.join(' ') || line;
      return '<div class="commit-row" title="' + esc(line) + '"><span class="codicon codicon-git-commit" aria-hidden="true"></span>' +
        '<span class="commit-title">' + esc(title) + '</span><span class="commit-hash">' + esc(hash) + '</span></div>';
    }
    function statusIcon(status) {
      if (status === 'A') return 'codicon-diff-added';
      if (status === 'D') return 'codicon-diff-removed';
      if (status === 'R' || status === 'C') return 'codicon-diff-renamed';
      if (status === 'U') return 'codicon-warning';
      return 'codicon-diff-modified';
    }
    function initial(value) { return String(value || '?').trim().charAt(0).toUpperCase() || '?'; }
    function esc(value) { return String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
    vscode.postMessage({ type: "ready" });
  `;
}
