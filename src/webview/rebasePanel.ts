// 인터랙티브 rebase 계획을 드래그로 편집하는 웹뷰 패널 모듈.
// - 패널 생애주기와 메시지 라우팅만 담당하고, 실제 rebase 실행은 RebaseService 에 위임한다.
// - 충돌로 멈추면 충돌 뷰(기능 3)가 이어받도록 새로고침 명령을 호출한다(경계 분리).
import * as vscode from "vscode";
import { RebaseItem, RebaseService } from "../git/rebaseService";
import { RebaseFromWebview, RebaseToWebview } from "./rebaseProtocol";

/**
 * rebase 계획 편집 패널. 매번 새로 만든다(기준점 base 가 다를 수 있으므로).
 */
export class RebasePanel {
  private static current: RebasePanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * 패널을 연다(기존 패널이 있으면 닫고 새로 만든다).
   * @param extensionUri 확장 루트 URI(미디어/헬퍼 경로 계산용)
   * @param service      대상 저장소의 RebaseService
   * @param base         편집 대상 직전 커밋(rebase 기준점)
   */
  static createOrShow(
    extensionUri: vscode.Uri,
    service: RebaseService,
    base: string
  ): void {
    RebasePanel.current?.dispose();
    const panel = vscode.window.createWebviewPanel(
      "gitSimpleCompare.rebase",
      vscode.l10n.t("Interactive Rebase"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    RebasePanel.current = new RebasePanel(panel, extensionUri, service, base);
  }

  private readonly editorScript: string;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly service: RebaseService,
    private readonly base: string
  ) {
    this.editorScript = vscode.Uri.joinPath(
      extensionUri,
      "media",
      "rebase",
      "rebaseEditor.js"
    ).fsPath;
    this.panel.webview.html = this.buildHtml(extensionUri);
    this.panel.webview.onDidReceiveMessage(
      (msg: RebaseFromWebview) => this.handleMessage(msg),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /** 패널과 리스너를 정리한다. */
  private dispose(): void {
    if (RebasePanel.current === this) {
      RebasePanel.current = undefined;
    }
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  /**
   * 웹뷰 메시지를 처리한다(준비/시작/취소).
   * @param msg 웹뷰 메시지
   */
  private async handleMessage(msg: RebaseFromWebview): Promise<void> {
    if (msg.type === "ready") {
      try {
        const commits = await this.service.getCommits(this.base);
        if (commits.length === 0) {
          vscode.window.showInformationMessage(
            vscode.l10n.t("No commits to rebase.")
          );
          this.dispose();
          return;
        }
        this.post({ type: "plan", base: this.base, commits });
      } catch (err) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            "Could not load commits: {0}",
            err instanceof Error ? err.message : String(err)
          )
        );
        this.dispose();
      }
      return;
    }
    if (msg.type === "cancel") {
      this.dispose();
      return;
    }
    if (msg.type === "start") {
      await this.runRebase(msg.items);
    }
  }

  /**
   * 계획을 실행하기 전 사용자 확인을 거쳐 rebase 를 수행한다.
   * - 미커밋 변경은 RebaseService.start 의 --autostash 로 보존한다.
   * @param items 사용자가 짠 계획
   */
  private async runRebase(items: RebaseItem[]): Promise<void> {
    const count = items.filter((i) => i.action !== "drop").length;
    const yes = vscode.l10n.t("Start Rebase");
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Rewrite history of {0} commit(s)? This cannot be easily undone.",
        count
      ),
      { modal: true },
      yes
    );
    if (choice !== yes) {
      return;
    }

    const result = await this.service.start(
      this.base,
      false,
      items,
      this.editorScript
    );
    if (result.status === "completed") {
      vscode.window.showInformationMessage(vscode.l10n.t("Rebase completed."));
      this.dispose();
    } else if (result.status === "conflicts") {
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Rebase paused due to conflicts. Resolve them in the Conflicts view, then Continue."
        )
      );
      this.dispose();
    } else if (result.status === "stopped") {
        vscode.window.showWarningMessage(
          vscode.l10n.t("Rebase paused at a todo item. Continue, Skip, or Abort after resolving the current Git step.")
        );
      this.dispose();
    } else if (result.status === "noop") {
      vscode.window.showInformationMessage(vscode.l10n.t("Nothing to rebase."));
      this.dispose();
    } else {
      vscode.window.showErrorMessage(
        vscode.l10n.t("Rebase failed: {0}", result.message ?? "")
      );
    }
    // 어느 경우든 충돌 뷰 상태를 갱신한다.
    void vscode.commands.executeCommand("gitSimpleCompare.refreshConflicts");
  }

  /** 타입이 보장된 메시지를 웹뷰로 전송한다. */
  private post(message: RebaseToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  /**
   * 웹뷰 HTML 을 만든다(CSP + nonce + 미디어 리소스 URI 주입).
   * @param extensionUri 확장 루트 URI
   */
  private buildHtml(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const mediaRoot = vscode.Uri.joinPath(extensionUri, "media", "rebase");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "rebase.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "rebase.css")
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
  <title>Interactive Rebase</title>
</head>
<body>
  <header>
    <h1>${vscode.l10n.t("Interactive Rebase")}</h1>
    <p class="hint">${vscode.l10n.t(
      "Drag to reorder. Top is applied first (oldest)."
    )}</p>
  </header>
  <ul id="list"></ul>
  <footer>
	    <button id="start" class="primary" type="button" title="${vscode.l10n.t(
        "Start Rebase"
      )}" aria-label="${vscode.l10n.t("Start Rebase")}" data-tooltip="${vscode.l10n.t(
      "Start Rebase"
    )}">${vscode.l10n.t(
      "Start Rebase"
    )}</button>
	    <button id="cancel" type="button" title="${vscode.l10n.t(
        "Cancel"
      )}" aria-label="${vscode.l10n.t("Cancel")}" data-tooltip="${vscode.l10n.t(
      "Cancel"
    )}">${vscode.l10n.t(
      "Cancel"
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
