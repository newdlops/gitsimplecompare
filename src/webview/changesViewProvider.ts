// CHANGES 사이드바 뷰를 웹뷰(WebviewView)로 렌더링하는 프로바이더.
// - TreeView 로는 불가능한 "가로 스크롤"과 "+/- 숫자 색상"을 위해 HTML 로 그린다.
// - 비교 상태/초안/보기모드/정렬을 보관하고, 변경 시 웹뷰로 렌더 payload 를 보낸다.
//   사용자 클릭은 등록된 명령으로 위임한다(경계 분리).
import * as vscode from "vscode";
import { BranchComparison } from "../git/gitTypes";
import {
  ChangeDiffArgs,
  SortKey,
  ViewMode,
  buildNodes,
} from "../providers/changesTreeModel";

/** 보기 모드/정렬을 세션 간 유지하기 위한 저장 키 */
const VIEW_MODE_STATE = "gitSimpleCompare.viewMode";
const SORT_KEY_STATE = "gitSimpleCompare.sortKey";

/** 비교 실행 전, 사용자가 설정 중인 from/to 초안 */
export interface ComparisonDraft {
  from?: string;
  to?: string;
}

/**
 * CHANGES 웹뷰 뷰 프로바이더.
 * - 기존 TreeProvider 와 동일한 메서드(setComparison/getDraft 등)를 제공해
 *   명령 레이어 변경을 최소화한다.
 */
export class ChangesViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "gitSimpleCompare.changes";

  private view?: vscode.WebviewView;
  private comparison?: BranchComparison;
  private draft: ComparisonDraft = {};
  private viewMode: ViewMode;
  private sortKey: SortKey;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memento: vscode.Memento
  ) {
    this.viewMode = memento.get<ViewMode>(VIEW_MODE_STATE, "tree");
    this.sortKey = memento.get<SortKey>(SORT_KEY_STATE, "path");
  }

  /**
   * 웹뷰 뷰가 생성/표시될 때 호출된다(숨겼다 다시 열면 재호출될 수 있다).
   * @param view 해석할 웹뷰 뷰
   */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.buildHtml(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  // ---- 상태 API (명령 레이어가 호출) ----

  /** 비교 컨텍스트를 교체하고 다시 그린다. */
  setComparison(comparison: BranchComparison): void {
    this.comparison = comparison;
    this.render();
  }

  /** 현재 비교 컨텍스트를 반환한다(없으면 undefined). */
  getComparison(): BranchComparison | undefined {
    return this.comparison;
  }

  /** 비교 전 초안(from/to)을 반환한다. */
  getDraft(): ComparisonDraft {
    return this.draft;
  }

  /** 초안의 한쪽 브랜치를 설정하고 다시 그린다. */
  setDraft(side: "from" | "to", ref: string): void {
    this.draft[side] = ref;
    this.render();
  }

  /** 현재 보기 모드. */
  getViewMode(): ViewMode {
    return this.viewMode;
  }

  /** 현재 정렬 기준. */
  getSortKey(): SortKey {
    return this.sortKey;
  }

  /** 보기 모드를 바꾸고(변경 시) 다시 그린다. */
  setViewMode(mode: ViewMode): void {
    if (mode !== this.viewMode) {
      this.viewMode = mode;
      void this.memento.update(VIEW_MODE_STATE, mode);
      this.render();
    }
  }

  /** 정렬 기준을 바꾸고(변경 시) 다시 그린다. */
  setSortKey(key: SortKey): void {
    if (key !== this.sortKey) {
      this.sortKey = key;
      void this.memento.update(SORT_KEY_STATE, key);
      this.render();
    }
  }

  /** 강제로 다시 그린다. */
  refresh(): void {
    this.render();
  }

  // ---- 내부 구현 ----

  /** 현재 상태로 렌더 payload 를 만들어 웹뷰로 보낸다. */
  private render(): void {
    if (!this.view) {
      return;
    }
    const payload = this.comparison
      ? {
          mode: "comparison" as const,
          from: this.comparison.base,
          to: this.comparison.target,
          viewMode: this.viewMode,
          nodes: buildNodes(
            this.comparison.changes,
            this.viewMode,
            this.sortKey
          ),
        }
      : {
          mode: "draft" as const,
          from: this.draft.from ?? "",
          to: this.draft.to ?? "",
          viewMode: this.viewMode,
          nodes: [],
        };
    void this.view.webview.postMessage({ type: "render", payload });
  }

  /**
   * 웹뷰 메시지를 처리한다. 동작은 등록된 명령으로 위임한다.
   * @param msg 웹뷰 메시지
   */
  private handleMessage(msg: {
    type: string;
    side?: "from" | "to";
    path?: string;
  }): void {
    if (msg.type === "ready") {
      this.render();
    } else if (msg.type === "changeRef" && msg.side) {
      void vscode.commands.executeCommand(
        "gitSimpleCompare.changeComparisonRef",
        msg.side
      );
    } else if (msg.type === "runCompare") {
      void vscode.commands.executeCommand("gitSimpleCompare.runComparison");
    } else if (msg.type === "openDiff" && msg.path && this.comparison) {
      const change = this.comparison.changes.find((c) => c.path === msg.path);
      if (change) {
        const args: ChangeDiffArgs = { comparison: this.comparison, change };
        void vscode.commands.executeCommand(
          "gitSimpleCompare.openChangeDiff",
          args
        );
      }
    }
  }

  /** 웹뷰 HTML 을 만든다(CSP + nonce + 미디어 리소스 URI). */
  private buildHtml(webview: vscode.Webview): string {
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media", "changes");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "changes.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "changes.css")
    );
    // VS Code 네이티브 아이콘(codicon) 폰트 — 트리/버튼을 표준 모양과 일치시킨다.
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "codicons", "codicon.css")
    );
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    // 웹뷰는 vscode.l10n 을 쓸 수 없으므로, 지역화된 문자열을 주입한다.
    const i18n = {
      from: vscode.l10n.t("From:"),
      to: vscode.l10n.t("To:"),
      selectBranch: vscode.l10n.t("(select a branch)"),
      compare: vscode.l10n.t("Compare"),
      noChanges: vscode.l10n.t("No changes between the selected branches."),
      change: vscode.l10n.t("Change branch"),
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link href="${codiconUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Changes</title>
</head>
<body>
  <div id="refs"></div>
  <div id="files"></div>
  <script nonce="${nonce}">window.__gscI18n=${JSON.stringify(i18n)};</script>
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
