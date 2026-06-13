// 작업 변경을 hunk 단위로 골라 선택한 부분만 stage 하는 웹뷰 패널 모듈.
// - 패널 생애주기와 메시지 라우팅만 담당하고, 실제 hunk stage 는 DiffHunkService 에 위임한다.
import * as vscode from "vscode";
import {
  DiffFile,
  DiffHunkService,
  HunkSelection,
} from "../git/diffHunkService";
import { openRefVsWorkingDiff } from "../ui/diffPresenter";
import { SplitFocus, SplitFromWebview, SplitToWebview } from "./splitProtocol";

/**
 * 변경 분할 패널. 동시에 하나만 유지한다(있으면 재사용).
 */
export class SplitPanel {
  private static current: SplitPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private files: DiffFile[] = []; // 마지막으로 파싱한 변경(stage 시 hunk 매칭에 사용)
  private pendingFocus: SplitFocus | undefined;
  private scope: SplitFocus | undefined;

  /**
   * 패널을 열거나, 있으면 앞으로 가져와 변경을 다시 읽는다.
   * @param extensionUri 확장 루트 URI
   * @param service      대상 저장소의 DiffHunkService
   */
  static createOrShow(
    extensionUri: vscode.Uri,
    service: DiffHunkService,
    focus?: SplitFocus
  ): void {
    if (SplitPanel.current) {
      SplitPanel.current.service = service;
      SplitPanel.current.pendingFocus = focus;
      SplitPanel.current.scope = fileScope(focus);
      SplitPanel.current.panel.reveal();
      void SplitPanel.current.sendChanges();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "gitSimpleCompare.split",
      vscode.l10n.t("Editable Diff"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    SplitPanel.current = new SplitPanel(panel, extensionUri, service);
    SplitPanel.current.pendingFocus = focus;
    SplitPanel.current.scope = fileScope(focus);
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
   * 웹뷰 메시지를 처리한다(준비/새로고침/stage).
   * @param msg 웹뷰 메시지
   */
  private async handleMessage(msg: SplitFromWebview): Promise<void> {
    if (msg.type === "ready" || msg.type === "refresh") {
      await this.sendChanges();
      return;
    }
    if (msg.type === "stage") {
      await this.stage(msg.selections);
    } else if (msg.type === "discard") {
      await this.discard(msg.selections);
    } else if (msg.type === "saveFile") {
      await this.saveFile(msg.path, msg.content);
    } else if (msg.type === "openFile") {
      await this.openFile(msg.path);
    }
  }

  /**
   * 선택한 hunk 들을 stage 한 뒤 남은 변경을 다시 보여준다.
   * @param selections 선택 정보
   */
  private async stage(selections: HunkSelection[]): Promise<void> {
    try {
      await this.service.stageSelections(this.files, selections);
      await this.sendChanges();
      this.post({
        type: "staged",
        message: vscode.l10n.t("Selected hunks staged."),
      });
      void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges");
      vscode.window.showInformationMessage(
        vscode.l10n.t("Selected hunks staged.")
      );
    } catch (err) {
      this.post({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 선택한 hunk 들을 working tree 에서 되돌린 뒤 남은 변경을 다시 보여준다.
   * @param selections 선택 정보
   */
  private async discard(selections: HunkSelection[]): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Discard selected hunks? This is irreversible."),
      { modal: true },
      vscode.l10n.t("Discard Selected")
    );
    if (!choice) {
      return;
    }
    try {
      await this.service.discardSelections(this.files, selections);
      await this.sendChanges();
      this.post({
        type: "discarded",
        message: vscode.l10n.t("Selected hunks discarded."),
      });
      void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges");
      vscode.window.showInformationMessage(
        vscode.l10n.t("Selected hunks discarded.")
      );
    } catch (err) {
      this.post({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 현재 hunk 작업 대상 파일을 HEAD ↔ Working Tree editable diff 로 연다.
   * @param filePath 저장소 상대 경로
   */
  private async openFile(filePath: string): Promise<void> {
    if (!filePath) {
      return;
    }
    await openRefVsWorkingDiff(
      this.service.repoRoot,
      "HEAD",
      vscode.Uri.file(`${this.service.repoRoot}/${filePath}`),
      filePath
    );
  }

  /**
   * 웹뷰의 HTML textarea 에서 편집한 작업 파일 내용을 저장한다.
   * @param filePath 저장소 상대 경로
   * @param content 저장할 전체 파일 내용
   */
  private async saveFile(filePath: string, content: string): Promise<void> {
    if (!filePath) {
      return;
    }
    try {
      await this.service.writeWorkingFile(filePath, content);
      await this.sendChanges();
      this.post({
        type: "saved",
        message: vscode.l10n.t("Working file saved."),
      });
      void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
        reason: "htmlEditableDiff:save",
      });
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
    const files = this.visibleFiles();
    const workingFile = await this.workingFilePayload(files);
    this.post({
      type: "changes",
      files,
      focus: this.pendingFocus ?? this.scope,
      singleFile: !!this.scope?.path,
      workingFile,
    });
    this.pendingFocus = undefined;
  }

  /** 단일 파일 scope 일 때 작업 파일 내용을 웹뷰로 함께 보낸다. */
  private async workingFilePayload(
    files: DiffFile[]
  ): Promise<{ path: string; baseText: string; text: string } | undefined> {
    const path = this.scope?.path ?? files[0]?.path;
    if (!path) {
      return undefined;
    }
    const file = files.find((item) => item.path === path);
    if (file?.binary) {
      return undefined;
    }
    try {
      const [baseText, text] = await Promise.all([
        this.service.readHeadFile(path),
        this.service.readWorkingFile(path),
      ]);
      return { path, baseText, text };
    } catch {
      return undefined;
    }
  }

  /** 현재 패널 scope 에 맞춰 웹뷰에 보낼 파일 목록을 좁힌다. */
  private visibleFiles(): DiffFile[] {
    const unstaged = this.files.filter((file) => file.stage === "unstaged");
    if (!this.scope?.path) {
      return unstaged;
    }
    return unstaged.filter((file) => file.path === this.scope?.path);
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
    const i18n = {
      all: vscode.l10n.t("All"),
      binary: vscode.l10n.t("binary"),
      changed: vscode.l10n.t("Changed"),
      clear: vscode.l10n.t("Clear"),
      headWorkingTree: vscode.l10n.t("HEAD ↔ Working Tree"),
      discardSelected: vscode.l10n.t("Discard Selected"),
      discardedSelected: vscode.l10n.t("Selected hunks discarded."),
      emptyFile: vscode.l10n.t("Select a file."),
      files: vscode.l10n.t("Files"),
      filter: vscode.l10n.t("Filter"),
      hunk: vscode.l10n.t("Hunk"),
      hunks: vscode.l10n.t("hunks"),
      noChanges: vscode.l10n.t("No changes."),
      noMatches: vscode.l10n.t("No matching changes."),
      previous: vscode.l10n.t("Previous"),
      refresh: vscode.l10n.t("Refresh"),
      openEditableDiff: vscode.l10n.t("Open Editable Diff"),
      saveWorkingFile: vscode.l10n.t("Save Working File"),
      selected: vscode.l10n.t("selected"),
      selectedOnly: vscode.l10n.t("Selected"),
      selectedSummary: vscode.l10n.t("{0} selected"),
      stageSelected: vscode.l10n.t("Stage Selected"),
      staged: vscode.l10n.t("Staged"),
      stagedSelected: vscode.l10n.t("Selected hunks staged."),
      unstaged: vscode.l10n.t("Changes"),
      workingFile: vscode.l10n.t("Working File"),
      workingFileDirty: vscode.l10n.t("Unsaved"),
      workingFileSaved: vscode.l10n.t("Working file saved."),
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link href="${codiconUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Editable Diff</title>
</head>
<body>
  <header class="topbar">
    <div class="title">
      <span class="codicon codicon-split-horizontal"></span>
      <span>${vscode.l10n.t("Editable Diff")}</span>
    </div>
    <div class="toolbar">
      <label class="search">
        <span class="codicon codicon-search"></span>
	        <input id="filter" type="search" title="${vscode.l10n.t(
            "Filter"
          )}" aria-label="${vscode.l10n.t("Filter")}" placeholder="${vscode.l10n.t(
	          "Filter"
	        )}" />
      </label>
      <button id="selected-only" class="secondary" type="button" title="${vscode.l10n.t(
        "Selected"
      )}">
        <span class="codicon codicon-list-selection"></span>
        <span>${vscode.l10n.t("Selected")}</span>
      </button>
      <button id="refresh" class="icon secondary" type="button" title="${vscode.l10n.t(
        "Refresh"
      )}">
        <span class="codicon codicon-refresh"></span>
      </button>
    </div>
  </header>
  <main class="split-shell">
    <aside class="file-pane">
      <div class="pane-head">
        <span>${vscode.l10n.t("Files")}</span>
        <span id="file-count">0</span>
      </div>
      <div id="file-list"></div>
    </aside>
    <section class="hunk-pane">
      <div class="hunk-toolbar">
        <div>
          <div id="active-path"></div>
          <div id="active-meta"></div>
        </div>
        <div class="hunk-actions">
          <button id="select-file" class="secondary" type="button" title="${vscode.l10n.t(
            "All"
          )}">${vscode.l10n.t(
            "All"
          )}</button>
          <button id="clear-file" class="secondary" type="button" title="${vscode.l10n.t(
            "Clear"
          )}">${vscode.l10n.t(
            "Clear"
          )}</button>
          <button id="open-file" class="secondary" type="button" title="${vscode.l10n.t(
            "Open Editable Diff"
          )}">${vscode.l10n.t(
            "Open Editable Diff"
          )}</button>
          <button id="save-working-file" class="secondary" type="button" title="${vscode.l10n.t(
            "Save Working File"
          )}" disabled>
            <span class="codicon codicon-save"></span>
            <span>${vscode.l10n.t("Save Working File")}</span>
          </button>
        </div>
      </div>
      <div id="hunks"></div>
    </section>
  </main>
  <footer class="commitbar">
    <span id="selection-summary"></span>
    <span id="notice"></span>
    <button id="discard" class="secondary" type="button" title="${vscode.l10n.t(
      "Discard Selected"
    )}" disabled>
      <span class="codicon codicon-discard"></span>
      <span>${vscode.l10n.t("Discard Selected")}</span>
    </button>
    <button id="commit" type="button" title="${vscode.l10n.t(
      "Stage Selected"
    )}" disabled>
      <span class="codicon codicon-add"></span>
      <span>${vscode.l10n.t("Stage Selected")}</span>
    </button>
  </footer>
  <script nonce="${nonce}">window.__gscSplitI18n=${JSON.stringify(i18n)};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** focus 에 파일 경로가 있을 때만 패널 scope 로 사용한다. */
function fileScope(focus: SplitFocus | undefined): SplitFocus | undefined {
  return focus?.path ? { path: focus.path, stage: "unstaged" } : undefined;
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
