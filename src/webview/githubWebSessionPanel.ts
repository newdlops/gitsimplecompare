// GitHub suggested changeset 조회용 웹 세션 설정 패널.
// - 브라우저 쿠키 자동 수집 대신 사용자가 명시적으로 복사/붙여넣기 한 값만 저장한다.
// - 실제 Cookie 검증과 SecretStorage 저장은 ui/githubWebCookieSecret 에 위임한다.
import * as vscode from "vscode";
import {
  clearStoredGitHubWebCookie,
  readStoredGitHubWebCookie,
  storeGitHubWebCookie,
  validateGitHubWebCookieInput,
} from "../ui/githubWebCookieSecret";
import { logError, logInfo } from "../ui/outputLog";
import { nonceValue } from "./nonce";

type GitHubWebSessionMessage =
  | { type: "ready" }
  | { type: "openGitHub" }
  | { type: "save"; value: string }
  | { type: "saveClipboard" }
  | { type: "clear" };

type GitHubWebSessionStatus = {
  type: "status";
  state: "idle" | "saved" | "cleared" | "invalid" | "error";
  message: string;
};

/** GitHub 웹 세션 로그인 안내 webview 패널 */
export class GitHubWebSessionPanel {
  private static current: GitHubWebSessionPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * GitHub 웹 세션 설정 패널을 열거나 이미 열린 패널을 앞으로 가져온다.
   * @param secrets Cookie 헤더를 저장할 VS Code SecretStorage
   * @param onDidSessionChange 저장/삭제 뒤 PR comment 캐시를 새로고침하는 콜백
   */
  static createOrShow(
    secrets: vscode.SecretStorage,
    onDidSessionChange: (reason: string) => void
  ): void {
    if (GitHubWebSessionPanel.current) {
      GitHubWebSessionPanel.current.panel.reveal(vscode.ViewColumn.Active);
      void GitHubWebSessionPanel.current.sendStoredState();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "gitSimpleCompare.githubWebSession",
      vscode.l10n.t("GitHub Web Session"),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    GitHubWebSessionPanel.current = new GitHubWebSessionPanel(
      panel,
      secrets,
      onDidSessionChange
    );
  }

  /**
   * 패널을 초기화하고 webview 메시지 수신기를 연결한다.
   * @param panel VS Code webview 패널
   * @param secrets Cookie 헤더를 저장할 VS Code SecretStorage
   * @param onDidSessionChange 저장/삭제 뒤 호출할 새로고침 콜백
   */
  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly secrets: vscode.SecretStorage,
    private readonly onDidSessionChange: (reason: string) => void
  ) {
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(
      (msg: GitHubWebSessionMessage) => this.handleMessage(msg),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    logInfo("github web session panel opened");
  }

  /** 패널이 닫힐 때 이벤트 구독을 정리한다. */
  private dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    if (GitHubWebSessionPanel.current === this) {
      GitHubWebSessionPanel.current = undefined;
    }
  }

  /**
   * webview 에서 올라온 사용자 액션을 처리한다.
   * @param msg webview script 가 보낸 메시지
   */
  private async handleMessage(msg: GitHubWebSessionMessage): Promise<void> {
    try {
      if (msg.type === "ready") {
        await this.sendStoredState();
        return;
      }
      if (msg.type === "openGitHub") {
        await vscode.env.openExternal(vscode.Uri.parse("https://github.com"));
        return;
      }
      if (msg.type === "saveClipboard") {
        await this.saveFromClipboard();
        return;
      }
      if (msg.type === "save") {
        await this.saveValue(msg.value);
        return;
      }
      if (msg.type === "clear") {
        await this.clearSession();
      }
    } catch (error) {
      logError("github web session panel action failed", error);
      this.post({
        type: "status",
        state: "error",
        message: vscode.l10n.t(
          "GitHub web session action failed: {0}",
          errText(error)
        ),
      });
    }
  }

  /**
   * 클립보드에 복사된 GitHub cURL/Cookie 값을 저장한다.
   * - 버튼 클릭 시점에만 클립보드를 읽어 사용자의 명시적 동작으로 한정한다.
   */
  private async saveFromClipboard(): Promise<void> {
    const value = await vscode.env.clipboard.readText();
    const error = validateGitHubWebCookieInput(value);
    if (error) {
      this.post({
        type: "status",
        state: "invalid",
        message: vscode.l10n.t(
          "Clipboard does not contain a GitHub Cookie header or cURL request."
        ),
      });
      return;
    }
    await this.store(value, "webviewClipboard");
  }

  /**
   * webview textarea 에 붙여넣은 GitHub cURL/Cookie 값을 저장한다.
   * @param value 사용자가 붙여넣은 원문
   */
  private async saveValue(value: string): Promise<void> {
    const error = validateGitHubWebCookieInput(value);
    if (error) {
      this.post({
        type: "status",
        state: "invalid",
        message: error,
      });
      return;
    }
    await this.store(value, "webviewPaste");
  }

  /**
   * 검증된 GitHub 웹 Cookie 입력을 SecretStorage 에 저장하고 PR comment 를 새로고침한다.
   * @param value Cookie 헤더 또는 cURL 요청 원문
   * @param source 로그에 남길 저장 경로
   */
  private async store(value: string, source: string): Promise<void> {
    const stored = await storeGitHubWebCookie(this.secrets, value, source);
    if (!stored) {
      this.post({
        type: "status",
        state: "invalid",
        message: vscode.l10n.t("Paste a github.com Cookie header."),
      });
      return;
    }
    this.onDidSessionChange("githubWebCookieStored");
    this.post({
      type: "status",
      state: "saved",
      message: vscode.l10n.t("GitHub web session saved."),
    });
  }

  /** 저장된 GitHub 웹 세션 Cookie 를 삭제하고 PR comment 를 새로고침한다. */
  private async clearSession(): Promise<void> {
    await clearStoredGitHubWebCookie(this.secrets);
    this.onDidSessionChange("githubWebCookieCleared");
    this.post({
      type: "status",
      state: "cleared",
      message: vscode.l10n.t("GitHub web session cleared."),
    });
  }

  /** 현재 저장된 세션 존재 여부를 webview 상태 영역에 보낸다. */
  private async sendStoredState(): Promise<void> {
    const hasStoredSession = Boolean(await readStoredGitHubWebCookie(this.secrets));
    this.post({
      type: "status",
      state: "idle",
      message: hasStoredSession
        ? vscode.l10n.t("Stored GitHub web session is active.")
        : vscode.l10n.t("No GitHub web session is stored."),
    });
  }

  /** GitHub 웹 세션 설정 UI 의 HTML 을 만든다. */
  private html(): string {
    const nonce = nonceValue();
    const csp = [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    const openGitHub = vscode.l10n.t("Open GitHub");
    const useClipboard = vscode.l10n.t("Use Clipboard");
    const saveSession = vscode.l10n.t("Save Session");
    const logoutSession = vscode.l10n.t("Logout Session");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(vscode.l10n.t("GitHub Web Session"))}</title>
  <style nonce="${nonce}">${styles()}</style>
</head>
<body>
  <main class="shell">
    <header class="hero">
      <p class="eyebrow">${escapeHtml(vscode.l10n.t("Suggested changesets"))}</p>
      <h1>${escapeHtml(vscode.l10n.t("GitHub Web Session"))}</h1>
      <p>${escapeHtml(vscode.l10n.t("Use a signed-in github.com request when Copilot or private PR suggested changesets are missing from the GitHub API."))}</p>
    </header>
    <section class="section" aria-labelledby="copy-title">
      <h2 id="copy-title">${escapeHtml(vscode.l10n.t("Copy a GitHub request"))}</h2>
      <ol>
        <li>${escapeHtml(vscode.l10n.t("Open the pull request on github.com while signed in."))}</li>
        <li>${escapeHtml(vscode.l10n.t("In browser DevTools, refresh the PR page and copy the document request as cURL."))}</li>
        <li>${escapeHtml(vscode.l10n.t("You can also copy only the Cookie request header."))}</li>
      </ol>
      <button id="open-github" class="secondary" type="button" title="${escapeHtml(openGitHub)}" aria-label="${escapeHtml(openGitHub)}">${escapeHtml(openGitHub)}</button>
    </section>
    <section class="section" aria-labelledby="save-title">
      <h2 id="save-title">${escapeHtml(vscode.l10n.t("Save the session"))}</h2>
      <div class="actions">
        <button id="use-clipboard" type="button" title="${escapeHtml(useClipboard)}" aria-label="${escapeHtml(useClipboard)}">${escapeHtml(useClipboard)}</button>
        <button id="clear" class="secondary danger" type="button" title="${escapeHtml(logoutSession)}" aria-label="${escapeHtml(logoutSession)}">${escapeHtml(logoutSession)}</button>
      </div>
      <label for="cookie-input">${escapeHtml(vscode.l10n.t("Cookie header or copied cURL request"))}</label>
      <textarea id="cookie-input" spellcheck="false" autocomplete="off" placeholder="${escapeHtml(vscode.l10n.t("Paste the github.com Cookie header or a copied cURL request."))}" aria-label="${escapeHtml(vscode.l10n.t("Cookie header or copied cURL request"))}"></textarea>
      <div class="actions footer-actions">
        <button id="save" type="button" title="${escapeHtml(saveSession)}" aria-label="${escapeHtml(saveSession)}">${escapeHtml(saveSession)}</button>
      </div>
      <p id="status" class="status" role="status"></p>
    </section>
  </main>
  <script nonce="${nonce}">${script()}</script>
</body>
</html>`;
  }

  /**
   * 타입이 보장된 상태 메시지를 webview 로 보낸다.
   * @param message webview script 로 전달할 상태
   */
  private post(message: GitHubWebSessionStatus): void {
    void this.panel.webview.postMessage(message);
  }
}

/** webview 에서 사용할 CSS 문자열을 만든다. */
function styles(): string {
  return `
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .shell {
      max-width: 860px;
      margin: 0 auto;
      padding: 32px 28px 40px;
    }
    .hero {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 18px;
      margin-bottom: 20px;
    }
    .eyebrow {
      margin: 0 0 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      text-transform: uppercase;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      font-weight: 650;
      letter-spacing: 0;
    }
    h2 {
      margin: 0 0 10px;
      font-size: 17px;
      font-weight: 650;
      letter-spacing: 0;
    }
    p {
      line-height: 1.55;
    }
    .section {
      padding: 20px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    ol {
      margin: 0 0 14px 20px;
      padding: 0;
    }
    li {
      margin: 7px 0;
      line-height: 1.5;
    }
    label {
      display: block;
      margin: 14px 0 8px;
      font-weight: 600;
    }
    textarea {
      box-sizing: border-box;
      width: 100%;
      min-height: 160px;
      resize: vertical;
      padding: 10px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.45;
    }
    textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .footer-actions {
      margin-top: 12px;
    }
    button {
      min-height: 30px;
      padding: 5px 12px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
      font: inherit;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    button.danger {
      color: var(--vscode-errorForeground);
    }
    .status {
      min-height: 22px;
      margin: 12px 0 0;
      color: var(--vscode-descriptionForeground);
    }
    .status[data-state="saved"] {
      color: var(--vscode-testing-iconPassed);
    }
    .status[data-state="invalid"],
    .status[data-state="error"] {
      color: var(--vscode-errorForeground);
    }
  `;
}

/** webview 에서 실행할 클라이언트 script 문자열을 만든다. */
function script(): string {
  return `
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('cookie-input');
    const status = document.getElementById('status');
    document.getElementById('open-github').addEventListener('click', () => {
      vscode.postMessage({ type: 'openGitHub' });
    });
    document.getElementById('use-clipboard').addEventListener('click', () => {
      vscode.postMessage({ type: 'saveClipboard' });
    });
    document.getElementById('save').addEventListener('click', () => {
      vscode.postMessage({ type: 'save', value: input.value });
    });
    document.getElementById('clear').addEventListener('click', () => {
      vscode.postMessage({ type: 'clear' });
    });
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'status') {
        return;
      }
      status.textContent = message.message || '';
      status.dataset.state = message.state || 'idle';
      if (message.state === 'saved') {
        input.value = '';
      }
    });
    vscode.postMessage({ type: 'ready' });
  `;
}

/**
 * HTML 본문/속성에 넣을 문자열을 escape 한다.
 * @param value escape 할 원문
 * @returns HTML 특수문자를 entity 로 바꾼 문자열
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 오류 값을 사용자에게 보여줄 짧은 문자열로 바꾼다. */
function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
