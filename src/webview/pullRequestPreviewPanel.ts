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
      service,
      baseBranch,
      existingPr
    );
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
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
    const csp = [
      `default-src 'none'`,
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${this.panel.webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
      <meta http-equiv="Content-Security-Policy" content="${csp}" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <style nonce="${nonce}">${styles()}</style>
      <title>Staged PR Preview</title></head><body>
      <header>
        <h1>Staged PR Preview</h1>
        <div class="actions">
          <button id="refresh" type="button" title="Refresh staged PR preview" data-tooltip="Refresh staged PR preview">
            Refresh
          </button>
          <button id="open-pr" type="button" title="Open related pull request" data-tooltip="Open related pull request" hidden>
            Open PR
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
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); }
    h1 { margin: 0; font-size: 14px; font-weight: 600; }
    main { padding: 14px; display: grid; gap: 12px; }
    button { position: relative; height: 26px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button[data-tooltip]::after { content: attr(data-tooltip); position: fixed; z-index: 100; top: 38px; right: 10px; max-width: min(420px, calc(100vw - 20px)); padding: 4px 7px; border: 1px solid var(--vscode-widget-border); border-radius: 3px; color: var(--vscode-quickInput-foreground); background: #252526; opacity: 0; pointer-events: none; white-space: normal; overflow-wrap: anywhere; }
    button[data-tooltip]:hover::after, button[data-tooltip]:focus-visible::after { opacity: 1; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
    .metric, .section { border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-editorWidget-background); }
    .metric { padding: 8px; }
    .label { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .value { margin-top: 4px; font-weight: 600; }
    .section { overflow: hidden; }
    .section h2 { margin: 0; padding: 8px 10px; font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    pre, ul { margin: 0; padding: 10px; }
    pre { overflow: auto; white-space: pre-wrap; font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); }
    li { margin: 4px 0; }
    .empty, .placeholder { color: var(--vscode-descriptionForeground); }
  `;
}

/** preview 페이지 클라이언트 스크립트를 반환한다. */
function script(): string {
  return `
    const vscode = acquireVsCodeApi();
    const content = document.getElementById("content");
    const openPr = document.getElementById("open-pr");
    document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    openPr.addEventListener("click", () => vscode.postMessage({ type: "openExistingPr" }));
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "preview") render(msg.preview);
      if (msg.type === "error") content.innerHTML = '<p class="empty">' + esc(msg.message) + '</p>';
    });
    function render(preview) {
      openPr.hidden = !preview.existingPr?.url;
      content.innerHTML =
        '<section class="summary">' +
          metric('Repository', preview.repository || 'unknown') +
          metric('Source', preview.currentBranch) +
          metric('Target', preview.targetBranch) +
          metric('Staged files', String(preview.files.length)) +
        '</section>' +
        section('Title', '<pre>' + esc(preview.title) + '</pre>') +
        section('Body draft', '<pre>' + esc(preview.body) + '</pre>') +
        section('Files', fileList(preview.files)) +
        section('Commits', list(preview.commits));
    }
    function metric(label, value) { return '<div class="metric"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div></div>'; }
    function section(title, body) { return '<section class="section"><h2>' + esc(title) + '</h2>' + body + '</section>'; }
    function fileList(files) { return files.length ? '<ul>' + files.map((f) => '<li>' + esc(f.status + ' ' + f.path + ' +' + f.additions + '/-' + f.deletions) + '</li>').join('') + '</ul>' : '<p class="empty">No staged files.</p>'; }
    function list(items) { return items.length ? '<ul>' + items.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '<p class="empty">No commits.</p>'; }
    function esc(value) { return String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
    vscode.postMessage({ type: "ready" });
  `;
}
