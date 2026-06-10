// git 그래프를 보여주는 웹뷰 패널을 관리하는 모듈.
// - 패널 생애주기(생성/표시/해제)와 웹뷰↔확장 메시지 라우팅만 담당한다.
//   그래프 계산은 graphLayout, git 접근은 GitLogService 에 위임한다(경계 분리).
import * as vscode from "vscode";
import { GitLogService, EMPTY_TREE } from "../git/gitLogService";
import { RebaseService } from "../git/rebaseService";
import { layoutGraph } from "../graph/graphLayout";
import { openRefVsRefDiff } from "../ui/diffPresenter";
import { RebasePanel } from "./rebasePanel";
import { FromWebviewMessage, ToWebviewMessage } from "./graphProtocol";

/**
 * git 그래프 웹뷰 패널. 동시에 하나만 유지한다(있으면 재사용).
 */
export class GitGraphPanel {
  private static current: GitGraphPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * 패널을 만들거나, 이미 있으면 앞으로 가져온다.
   * - 대상 저장소(logService)가 바뀌면 새 데이터를 다시 로드한다.
   * @param extensionUri 확장 루트 URI(미디어 리소스 경로 계산용)
   * @param logService   대상 저장소의 로그 서비스
   * @param maxCommits   로드할 최대 커밋 수
   */
  static createOrShow(
    extensionUri: vscode.Uri,
    logService: GitLogService,
    maxCommits: number
  ): void {
    if (GitGraphPanel.current) {
      GitGraphPanel.current.logService = logService;
      GitGraphPanel.current.maxCommits = maxCommits;
      GitGraphPanel.current.panel.reveal();
      void GitGraphPanel.current.sendGraph();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "gitSimpleCompare.graph",
      vscode.l10n.t("Git Graph"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    GitGraphPanel.current = new GitGraphPanel(
      panel,
      extensionUri,
      logService,
      maxCommits
    );
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private logService: GitLogService,
    private maxCommits: number
  ) {
    this.panel.webview.html = this.buildHtml();
    // 웹뷰에서 오는 메시지 처리
    this.panel.webview.onDidReceiveMessage(
      (msg: FromWebviewMessage) => this.handleMessage(msg),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /** 패널과 리스너를 정리한다. */
  private dispose(): void {
    GitGraphPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  /**
   * 웹뷰 메시지를 종류별로 처리한다.
   * @param msg 웹뷰가 보낸 메시지
   */
  private async handleMessage(msg: FromWebviewMessage): Promise<void> {
    try {
      if (msg.type === "ready" || msg.type === "refresh") {
        await this.sendGraph();
      } else if (msg.type === "selectCommit") {
        const detail = await this.logService.getCommitDetail(msg.hash);
        this.post({ type: "commitDetail", detail });
      } else if (msg.type === "openFileDiff") {
        const base = msg.parent && msg.parent.length > 0 ? msg.parent : EMPTY_TREE;
        await openRefVsRefDiff(
          this.logService.repoRoot,
          base,
          msg.hash,
          msg.path
        );
      } else if (msg.type === "rebaseFrom") {
        // 선택한 커밋과 그 이후를 편집하도록 base 를 picked^ 로 설정해 패널을 연다.
        RebasePanel.createOrShow(
          this.extensionUri,
          new RebaseService(this.logService.repoRoot),
          `${msg.hash}^`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", message });
    }
  }

  /** 커밋을 읽어 레이아웃한 뒤 그래프 데이터를 웹뷰로 보낸다. */
  private async sendGraph(): Promise<void> {
    const commits = await this.logService.getCommits(this.maxCommits);
    this.post({ type: "graph", data: layoutGraph(commits) });
  }

  /** 타입이 보장된 메시지를 웹뷰로 전송한다. */
  private post(message: ToWebviewMessage): void {
    void this.panel.webview.postMessage(message);
  }

  /**
   * 웹뷰 HTML 을 만든다(CSP + nonce + 미디어 리소스 URI 주입).
   */
  private buildHtml(): string {
    const webview = this.panel.webview;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media", "graph");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "graph.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "graph.css")
    );
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
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
  <link href="${styleUri}" rel="stylesheet" />
  <title>Git Graph</title>
</head>
<body>
  <div id="app">
    <div id="graph" tabindex="0"></div>
    <div id="detail"><p class="placeholder">${vscode.l10n.t(
      "Select a commit to see details."
    )}</p></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
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
