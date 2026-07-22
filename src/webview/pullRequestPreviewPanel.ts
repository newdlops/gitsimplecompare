// staged 상태를 target branch 로 PR 한다고 가정한 모의 페이지 웹뷰.
// - PR 데이터 생성은 PullRequestService 에 맡기고, 이 파일은 패널 생애주기와 렌더링만 담당한다.
import * as vscode from "vscode";
import {
  isAiCliAuthenticationError,
  isAiCliConfigurationError,
} from "../ai/cliRunner";
import { generateAiPullRequestMessage } from "../ai/messageGenerator";
import {
  PullRequestInfo,
  PullRequestService,
} from "../git/pullRequestService";
import { logError, logInfo } from "../ui/outputLog";
import {
  openPullRequestPreviewDiff,
  type PullRequestPreviewDiffRequest,
} from "../ui/pullRequestPreviewDiff";
import { nonceValue } from "./nonce";
import { instantTooltipResources } from "./instantTooltipResources";
import {
  PullRequestPreviewPublisher,
  type PullRequestPreviewPublishMessage,
} from "./pullRequestPreviewPublish";
import { pullRequestPreviewScript } from "./pullRequestPreviewScript";
import { pullRequestPreviewStyles } from "./pullRequestPreviewStyles";

type PreviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "openExistingPr" }
  | { type: "generatePullRequestMessage" }
  | { type: "configureAiCli" }
  | { type: "copyPullRequestMessage"; title: string; body: string }
  | PullRequestPreviewPublishMessage
  | { type: "setPreviewBranch"; role: "source" | "target"; branch: string }
  | { type: "loadCommitFiles"; hash: string }
  | ({ type: "openEditableDiff" } & PullRequestPreviewDiffRequest);

/** staged PR preview 웹뷰 패널 */
export class PullRequestPreviewPanel {
  private readonly disposables: vscode.Disposable[] = [];
  private lastTargetBranch?: string;
  private lastTargetRef?: string;
  private lastSourceBranch?: string;
  private lastSourceRef?: string;
  private previewRequestSeq = 0;
  private previewRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private previewRefreshReason = "";
  private pullRequestMessageGenerationInFlight = false;
  private readonly publisher: PullRequestPreviewPublisher;

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
    const panel = vscode.window.createWebviewPanel(
      "gitSimpleCompare.prPreview",
      vscode.l10n.t("Staged PR Preview"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    new PullRequestPreviewPanel(
      panel,
      extensionUri,
      service,
      baseBranch,
      existingPr,
      existingPr?.headRefName
    );
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private service: PullRequestService,
    private baseBranch?: string,
    private existingPr?: PullRequestInfo,
    private sourceBranch?: string
  ) {
    this.publisher = new PullRequestPreviewPublisher(
      this.service.repoRoot,
      (message) => this.post(message),
      async (result) => {
        this.existingPr = result.pullRequest;
        this.baseBranch = result.pullRequest.baseRefName;
        this.sourceBranch = result.pullRequest.headRefName;
        await this.sendPreview();
      }
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(
      (msg: PreviewMessage) => this.handleMessage(msg),
      undefined,
      this.disposables
    );
    vscode.workspace.onDidSaveTextDocument((document) => {
      const file = document.uri.scheme === "file" ? document.uri.fsPath : "";
      if (file && file.startsWith(`${this.service.repoRoot}/`)) {
        this.schedulePreviewRefresh("fileSave");
      }
    }, undefined, this.disposables);
    const gitWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        this.service.repoRoot,
        ".git/{index,HEAD,refs/**,packed-refs}"
      )
    );
    gitWatcher.onDidCreate(() => this.schedulePreviewRefresh("gitCreate"), undefined, this.disposables);
    gitWatcher.onDidChange(() => this.schedulePreviewRefresh("gitChange"), undefined, this.disposables);
    gitWatcher.onDidDelete(() => this.schedulePreviewRefresh("gitDelete"), undefined, this.disposables);
    this.disposables.push(gitWatcher);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /** 패널 리소스를 정리한다. */
  private dispose(): void {
    if (this.previewRefreshTimer) {
      clearTimeout(this.previewRefreshTimer);
      this.previewRefreshTimer = undefined;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  /**
   * 저장/스테이징/ref 변경이 짧은 시간에 몰릴 때 preview 재계산을 하나로 합친다.
   * @param reason refresh 를 예약한 원인
   */
  private schedulePreviewRefresh(reason: string): void {
    this.previewRefreshReason = this.previewRefreshTimer
      ? `${this.previewRefreshReason},${reason}`
      : reason;
    if (this.previewRefreshTimer) {
      clearTimeout(this.previewRefreshTimer);
    }
    this.previewRefreshTimer = setTimeout(() => {
      const refreshReason = this.previewRefreshReason;
      this.previewRefreshReason = "";
      this.previewRefreshTimer = undefined;
      logInfo("PR preview auto refresh requested", {
        repoRoot: this.service.repoRoot,
        reason: refreshReason,
      });
      void this.sendPreview();
    }, 180);
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
      return;
    }
    if (msg.type === "generatePullRequestMessage") {
      await this.generatePullRequestMessage();
      return;
    }
    if (msg.type === "configureAiCli") {
      await vscode.commands.executeCommand("gitSimpleCompare.configureAiCli");
      return;
    }
    if (msg.type === "copyPullRequestMessage") {
      await this.copyPullRequestMessage(msg.title, msg.body);
      return;
    }
    if (msg.type === "publishPullRequest") {
      await this.publisher.publish(msg, {
        existingPr: this.existingPr,
        lastSourceBranch: this.lastSourceBranch,
        lastTargetBranch: this.lastTargetBranch,
      });
      return;
    }
    if (msg.type === "setPreviewBranch") {
      if (msg.role === "target") {
        this.baseBranch = msg.branch || undefined;
      } else {
        this.sourceBranch = msg.branch || undefined;
      }
      if (this.existingPr && !this.matchesExistingPr()) {
        this.existingPr = undefined;
      }
      await this.sendPreview();
      return;
    }
    if (msg.type === "openEditableDiff") {
      await this.openEditableDiff(msg);
      return;
    }
    if (msg.type === "loadCommitFiles") {
      await this.sendCommitFiles(msg.hash);
    }
  }

  /**
   * 현재 preview 의 PR 제목/본문을 GitHub PR 작성 화면에 붙여넣기 쉬운 형식으로 복사한다.
   * @param title PR 제목
   * @param body PR 본문
   */
  private async copyPullRequestMessage(title: string, body: string): Promise<void> {
    const text = [title.trim(), body.trim()].filter(Boolean).join("\n\n");
    if (!text) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("No pull request message is available to copy.")
      );
      return;
    }
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(
      vscode.l10n.t("Pull request message copied to clipboard.")
    );
  }

  /**
   * PR preview 파일을 기준 브랜치와 작업트리의 editable diff 로 연 뒤, 오른쪽 파일에 review comment 를 표시한다.
   * @param msg 웹뷰에서 선택한 파일 경로와 comment 목록
   */
  private async openEditableDiff(msg: Extract<PreviewMessage, { type: "openEditableDiff" }>): Promise<void> {
    try {
      await openPullRequestPreviewDiff(this.service.repoRoot, {
        ...msg,
        baseRef: msg.baseRef || this.lastTargetRef || this.baseBranch || this.lastTargetBranch,
        headRef: msg.headRef || this.lastSourceRef || this.sourceBranch || this.lastSourceBranch || this.existingPr?.headHash || "HEAD",
      });
    } catch (error) {
      logError("PR preview editable diff open failed", error);
    }
  }

  /** Commits 탭에서 선택한 commit 의 파일 변경을 웹뷰에 보낸다. */
  private async sendCommitFiles(hash: string): Promise<void> {
    try {
      this.post({ type: "commitFiles", hash, files: await this.service.getPreviewCommitFiles(hash) });
    } catch (error) {
      logError("PR preview commit files failed", error);
      this.post({ type: "commitFiles", hash, files: [] });
    }
  }

  /** staged preview 데이터를 읽어 웹뷰에 보낸다. */
  private async sendPreview(): Promise<void> {
    const requestSeq = ++this.previewRequestSeq;
    try {
      const preview = await this.service.getStagedPreview(
        this.baseBranch,
        this.existingPr,
        this.sourceBranch
      );
      if (requestSeq !== this.previewRequestSeq) {
        return;
      }
      this.lastTargetBranch = preview.targetBranch;
      this.lastTargetRef = preview.targetRef;
      this.lastSourceBranch = preview.sourceBranch;
      this.lastSourceRef = preview.sourceRef;
      this.panel.title = preview.existingPr?.number
        ? vscode.l10n.t("PR #{0} Preview", preview.existingPr.number)
        : preview.targetBranch
          ? vscode.l10n.t("PR Preview: {0} -> {1}", preview.sourceBranch, preview.targetBranch)
          : vscode.l10n.t("PR Preview: select target branch");
      this.post({ type: "preview", preview });
    } catch (error) {
      if (requestSeq !== this.previewRequestSeq) {
        return;
      }
      logError("staged PR preview failed", error);
      this.post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 현재 preview 기준으로 AI PR 제목/본문을 생성해 웹뷰에 반영한다. */
  private async generatePullRequestMessage(): Promise<void> {
    if (this.pullRequestMessageGenerationInFlight) {
      logInfo("AI pull request message generation skipped: already running", {
        repoRoot: this.service.repoRoot,
      });
      this.post({ type: "aiPullRequestMessageGeneration", active: true });
      return;
    }
    this.pullRequestMessageGenerationInFlight = true;
    this.post({ type: "aiPullRequestMessageGeneration", active: true });
    try {
      const message = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t("Generating AI pull request message..."),
          cancellable: true,
        },
        async (_progress, token) => {
          const preview = await this.service.getStagedPreview(
            this.baseBranch,
            this.existingPr,
            this.sourceBranch
          );
          if (!preview.targetBranch) {
            throw new Error(vscode.l10n.t(
              "Select a target branch before generating a pull request message."
            ));
          }
          return generateAiPullRequestMessage(preview, this.service.repoRoot, token);
        }
      );
      this.post({ type: "generatedPullRequestMessage", message });
    } catch (error) {
      logError("AI pull request message generation failed", error);
      const configure = vscode.l10n.t("Configure AI CLI");
      const login = vscode.l10n.t("Login to AI CLI");
      const message = vscode.l10n.t(
        "AI pull request message generation failed: {0}",
        errText(error)
      );
      const choice = isAiCliAuthenticationError(error)
        ? await vscode.window.showErrorMessage(message, login, configure)
        : isAiCliConfigurationError(error)
          ? await vscode.window.showErrorMessage(message, configure)
          : await vscode.window.showErrorMessage(message);
      if (choice === login && isAiCliAuthenticationError(error)) {
        await vscode.commands.executeCommand(
          "gitSimpleCompare.loginAiCli",
          error.provider
        );
        return;
      }
      if (choice === configure) {
        await vscode.commands.executeCommand("gitSimpleCompare.configureAiCli");
      }
    } finally {
      this.pullRequestMessageGenerationInFlight = false;
      this.post({ type: "aiPullRequestMessageGeneration", active: false });
    }
  }

  /** preview 웹뷰 HTML 을 만든다. */
  private html(): string {
    const nonce = nonceValue();
    const tooltipResources = instantTooltipResources(
      this.panel.webview,
      this.extensionUri
    );
    const generatePrMessageTitle = vscode.l10n.t(
      "Generate AI pull request message"
    );
    const configureAiCliTitle = vscode.l10n.t("Configure AI CLI");
    const noPrMessageTitle = vscode.l10n.t(
      "No pull request message to copy"
    );
    const publishPrTitle = vscode.l10n.t("Create Pull Request on GitHub");
    const openPrTitle = vscode.l10n.t("Open related Pull Request on GitHub");
    const previewScript = pullRequestPreviewScript({
      ready: publishPrTitle,
      busy: vscode.l10n.t("Publishing Pull Request to GitHub..."),
      existing: vscode.l10n.t("A Pull Request already exists for this source branch"),
      selectTarget: vscode.l10n.t("Select a target branch before creating a Pull Request"),
      selectLocalSource: vscode.l10n.t("Select a local source branch before creating a Pull Request"),
      missingMessage: vscode.l10n.t("Generate a Pull Request title before publishing"),
      noChanges: vscode.l10n.t("No changes to publish as a Pull Request"),
      updating: vscode.l10n.t("Wait for the Pull Request preview to finish updating"),
    });
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
      <link href="${tooltipResources.styleUri}" rel="stylesheet" />
      <style nonce="${nonce}">${pullRequestPreviewStyles()}</style>
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
          <button id="generate-pr-message" class="icon-button" type="button" title="${generatePrMessageTitle}"
            aria-label="${generatePrMessageTitle}" data-tooltip="${generatePrMessageTitle}">
            <span class="codicon codicon-comment-discussion-sparkle" aria-hidden="true"></span>
          </button>
          <button id="configure-ai-cli" class="icon-button" type="button" title="${configureAiCliTitle}"
            aria-label="${configureAiCliTitle}" data-tooltip="${configureAiCliTitle}">
            <span class="codicon codicon-settings-gear" aria-hidden="true"></span>
          </button>
          <button id="copy-pr-message" class="icon-button" type="button" title="${noPrMessageTitle}"
            aria-label="${noPrMessageTitle}" data-tooltip="${noPrMessageTitle}" disabled>
            <span class="codicon codicon-copy" aria-hidden="true"></span>
          </button>
          <button id="publish-pr" class="icon-button publish-button" type="button" title="${publishPrTitle}"
            aria-label="${publishPrTitle}" data-tooltip="${publishPrTitle}" disabled>
            <span class="codicon codicon-cloud-upload" aria-hidden="true"></span>
            <span class="publish-label">${vscode.l10n.t("Create Pull Request")}</span>
          </button>
          <button id="open-pr" class="icon-button" type="button" title="${openPrTitle}"
            aria-label="${openPrTitle}" data-tooltip="${openPrTitle}" hidden>
            <span class="codicon codicon-mark-github" aria-hidden="true"></span>
          </button>
        </div>
      </header>
      <main id="content"><p class="placeholder">Loading...</p></main>
      <script nonce="${nonce}" src="${tooltipResources.scriptUri}"></script>
      <script nonce="${nonce}">${previewScript}</script>
    </body></html>`;
  }

  /** 타입이 보장된 메시지를 웹뷰로 보낸다. */
  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  /** 현재 선택된 source/target 이 기존 PR 의 head/base 와 같은지 확인한다. */
  private matchesExistingPr(): boolean {
    const target = this.baseBranch || this.existingPr?.baseRefName;
    const source = this.sourceBranch || this.existingPr?.headRefName;
    return (!target || target === this.existingPr?.baseRefName)
      && (!source || source === this.existingPr?.headRefName);
  }
}

/** 오류 값을 사용자에게 보여줄 짧은 문자열로 바꾼다. */
function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
