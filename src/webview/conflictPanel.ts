// 충돌 해결 전용 웹뷰 패널.
// - Current/Incoming/Result 를 한 화면에서 편집하고, 선택한 수용 전략을 ConflictService 로 적용한다.
// - git 데이터 접근은 ConflictService 에 위임하고, 이 모듈은 패널 생애주기와 메시지 라우팅만 담당한다.
import * as vscode from "vscode";
import { ConflictService } from "../git/conflictService";
import { openMergeEditorUri } from "../ui/mergePresenter";
import { logError, logInfo } from "../ui/outputLog";

type ConflictPanelMessage =
  | { type: "ready" }
  | { type: "saveResult"; content: string }
  | { type: "resolveMarked"; content: string }
  | { type: "acceptCurrent"; content?: string }
  | { type: "acceptIncoming"; content?: string }
  | { type: "acceptBoth" }
  | { type: "openMergeEditor" };

/**
 * 커스텀 conflict editor 패널. 동시에 하나만 유지하고, 다른 파일을 열면 같은 패널을 재사용한다.
 */
export class ConflictPanel {
  private static current: ConflictPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * 충돌 파일을 커스텀 편집 패널로 연다.
   * @param extensionUri 확장 루트 URI
   * @param service      대상 저장소의 ConflictService
   * @param rel          저장소 상대 경로
   * @param onDidMutate  파일 저장/해결 후 외부 뷰를 갱신하는 콜백
   */
  static createOrShow(
    extensionUri: vscode.Uri,
    service: ConflictService,
    rel: string,
    onDidMutate: () => Promise<void>
  ): void {
    if (ConflictPanel.current) {
      ConflictPanel.current.service = service;
      ConflictPanel.current.rel = rel;
      ConflictPanel.current.onDidMutate = onDidMutate;
      ConflictPanel.current.panel.reveal();
      void ConflictPanel.current.reload();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "gitSimpleCompare.conflictEditor",
      vscode.l10n.t("Resolve Conflict"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    ConflictPanel.current = new ConflictPanel(
      panel,
      extensionUri,
      service,
      rel,
      onDidMutate
    );
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private service: ConflictService,
    private rel: string,
    private onDidMutate: () => Promise<void>
  ) {
    this.panel.webview.html = this.buildHtml();
    this.panel.webview.onDidReceiveMessage(
      (msg: ConflictPanelMessage) => this.handleMessage(msg),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /** 패널과 리스너를 정리한다. */
  private dispose(): void {
    if (ConflictPanel.current === this) {
      ConflictPanel.current = undefined;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  /**
   * 웹뷰에서 온 액션 메시지를 처리한다.
   * @param msg 웹뷰 메시지
   */
  private async handleMessage(msg: ConflictPanelMessage): Promise<void> {
    try {
      if (msg.type === "ready") {
        await this.reload();
      } else if (msg.type === "saveResult") {
        await this.service.writeResolvedContent(this.rel, msg.content, false);
        await this.afterMutation("saved");
      } else if (msg.type === "resolveMarked") {
        await this.service.writeResolvedContent(this.rel, msg.content, true);
        await this.afterMutation("resolved");
      } else if (msg.type === "acceptCurrent") {
        await this.service.acceptCurrent(this.rel, msg.content);
        await this.afterMutation("acceptedCurrent");
      } else if (msg.type === "acceptIncoming") {
        await this.service.acceptIncoming(this.rel, msg.content);
        await this.afterMutation("acceptedIncoming");
      } else if (msg.type === "acceptBoth") {
        await this.service.acceptBoth(this.rel);
        await this.afterMutation("acceptedBoth");
      } else if (msg.type === "openMergeEditor") {
        await openMergeEditorUri(vscode.Uri.file(this.service.absPath(this.rel)));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("conflict editor action failed", err, {
        repoRoot: this.service.repoRoot,
        rel: this.rel,
        type: msg.type,
      });
      this.post({ type: "error", message });
    }
  }

  /** 현재 충돌 문서를 다시 읽어 웹뷰에 보낸다. */
  private async reload(): Promise<void> {
    const document = await this.service.getConflictDocument(this.rel);
    this.panel.title = vscode.l10n.t("Resolve Conflict: {0}", this.rel);
    this.post({ type: "document", document });
  }

  /**
   * 파일을 수정한 뒤 관련 뷰를 갱신하고 최신 문서를 다시 보낸다.
   * @param reason 로그에 남길 변경 이유
   */
  private async afterMutation(reason: string): Promise<void> {
    logInfo("conflict editor mutation", {
      repoRoot: this.service.repoRoot,
      rel: this.rel,
      reason,
    });
    await this.onDidMutate();
    void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason: `conflict:${reason}`,
    });
    await this.reload();
  }

  /** 타입이 보장된 메시지를 웹뷰로 보낸다. */
  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  /** 웹뷰 HTML 을 만든다. */
  private buildHtml(): string {
    const webview = this.panel.webview;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media", "conflict");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "conflict.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "conflict.css")
    );
    const codiconStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "codicons", "codicon.css")
    );
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${codiconStyleUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Resolve Conflict</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** CSP nonce 를 만든다. */
function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
