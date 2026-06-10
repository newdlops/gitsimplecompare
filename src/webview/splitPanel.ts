// 작업 변경을 hunk 단위로 골라 여러 커밋으로 나누는 웹뷰 패널 모듈.
// - 패널 생애주기와 메시지 라우팅만 담당하고, 실제 분할 커밋은 DiffHunkService 에 위임한다.
import * as vscode from "vscode";
import {
  DiffFile,
  DiffHunkService,
  HunkSelection,
} from "../git/diffHunkService";
import { SplitFromWebview, SplitToWebview } from "./splitProtocol";

/**
 * 변경 분할 패널. 동시에 하나만 유지한다(있으면 재사용).
 */
export class SplitPanel {
  private static current: SplitPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private files: DiffFile[] = []; // 마지막으로 파싱한 변경(커밋 시 hunk 매칭에 사용)

  /**
   * 패널을 열거나, 있으면 앞으로 가져와 변경을 다시 읽는다.
   * @param extensionUri 확장 루트 URI
   * @param service      대상 저장소의 DiffHunkService
   */
  static createOrShow(
    extensionUri: vscode.Uri,
    service: DiffHunkService
  ): void {
    if (SplitPanel.current) {
      SplitPanel.current.service = service;
      SplitPanel.current.panel.reveal();
      void SplitPanel.current.sendChanges();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "gitSimpleCompare.split",
      vscode.l10n.t("Split Changes into Commits"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    SplitPanel.current = new SplitPanel(panel, extensionUri, service);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private service: DiffHunkService
  ) {
    this.panel.webview.html = this.buildHtml();
    this.panel.webview.onDidReceiveMessage(
      (msg: SplitFromWebview) => this.handleMessage(msg),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /** 패널과 리스너를 정리한다. */
  private dispose(): void {
    SplitPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  /**
   * 웹뷰 메시지를 처리한다(준비/새로고침/커밋).
   * @param msg 웹뷰 메시지
   */
  private async handleMessage(msg: SplitFromWebview): Promise<void> {
    if (msg.type === "ready" || msg.type === "refresh") {
      await this.sendChanges();
      return;
    }
    if (msg.type === "commit") {
      await this.commit(msg.selections, msg.message);
    }
  }

  /**
   * 선택한 hunk 들을 커밋한 뒤 남은 변경을 다시 보여준다.
   * @param selections 선택 정보
   * @param message    커밋 메시지
   */
  private async commit(
    selections: HunkSelection[],
    message: string
  ): Promise<void> {
    try {
      await this.service.commit(this.files, selections, message);
      this.post({ type: "committed", message });
      await this.sendChanges();
      vscode.window.showInformationMessage(
        vscode.l10n.t("Committed selected changes.")
      );
    } catch (err) {
      this.post({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 작업 변경을 다시 읽어 웹뷰로 보낸다. */
  private async sendChanges(): Promise<void> {
    this.files = await this.service.getWorkingDiff();
    this.post({ type: "changes", files: this.files });
  }

  /** 타입이 보장된 메시지를 웹뷰로 전송한다. */
  private post(message: SplitToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  /** 웹뷰 HTML 을 만든다(CSP + nonce + 미디어 리소스 URI). */
  private buildHtml(): string {
    const webview = this.panel.webview;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media", "split");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "split.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "split.css")
    );
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Split Changes</title>
</head>
<body>
  <header>
    <h1>${vscode.l10n.t("Split Changes into Commits")}</h1>
    <p class="hint">${vscode.l10n.t(
      "Select hunks, write a message, and commit. Repeat for the rest."
    )}</p>
  </header>
  <div id="files"></div>
  <footer>
    <input id="message" type="text" placeholder="${vscode.l10n.t(
      "Commit message"
    )}" />
    <button id="commit" class="primary">${vscode.l10n.t(
      "Commit Selected"
    )}</button>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** CSP 의 script nonce(1회성 난수 문자열)를 만든다. */
function makeNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
