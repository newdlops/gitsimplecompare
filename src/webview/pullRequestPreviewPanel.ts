// staged 상태를 target branch 로 PR 한다고 가정한 모의 페이지 웹뷰.
// - PR 데이터 생성은 PullRequestService 에 맡기고, 이 파일은 패널 생애주기와 렌더링만 담당한다.
import * as path from "node:path";
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
import type { PullRequestPreviewFile } from "../git/pullRequestPreviewFiles";
import {
  PullRequestQuickEditError,
  PullRequestQuickEditService,
  type PullRequestQuickEditSession,
} from "../git/pullRequestQuickEditService";
import { logError, logInfo, logWarn } from "../ui/outputLog";
import {
  openPullRequestPreviewDiff,
  type PullRequestPreviewDiffRequest,
} from "../ui/pullRequestPreviewDiff";
import { openPullRequestQuickEdit } from "../ui/pullRequestQuickEdit";
import {
  PullRequestPreviewPublisher,
  type PullRequestPreviewPublishMessage,
} from "./pullRequestPreviewPublish";
import { buildPullRequestPreviewHtml } from "./pullRequestPreviewHtml";

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
  | { type: "openQuickEditor"; path: string }
  | ({ type: "openEditableDiff" } & PullRequestPreviewDiffRequest);

/** staged PR preview 웹뷰 패널 */
export class PullRequestPreviewPanel {
  private readonly disposables: vscode.Disposable[] = [];
  private lastTargetBranch?: string;
  private lastTargetRef?: string;
  private lastSourceBranch?: string;
  private lastSourceRef?: string;
  private lastCurrentBranch?: string;
  private quickEditFiles: readonly PullRequestPreviewFile[] = [];
  private previewRequestSeq = 0;
  private previewRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private previewRefreshReason = "";
  private activeQuickEditSession?: PullRequestQuickEditSession;
  private quickEditSaveQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private pullRequestMessageGenerationInFlight = false;
  private readonly publisher: PullRequestPreviewPublisher;
  private readonly quickEditService: PullRequestQuickEditService;

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
    this.quickEditService = new PullRequestQuickEditService(this.service.repoRoot);
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
    this.panel.webview.html = buildPullRequestPreviewHtml(this.extensionUri, this.panel.webview);
    this.panel.webview.onDidReceiveMessage(
      (msg: PreviewMessage) => this.handleMessage(msg),
      undefined,
      this.disposables
    );
    vscode.workspace.onDidSaveTextDocument(
      (document) => this.handleSavedDocument(document),
      undefined,
      this.disposables
    );
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
    this.disposed = true;
    this.activeQuickEditSession = undefined;
    this.cancelScheduledPreviewRefresh();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  /**
   * 저장/스테이징/ref 변경이 짧은 시간에 몰릴 때 preview 재계산을 하나로 합친다.
   * @param reason refresh 를 예약한 원인
   */
  private schedulePreviewRefresh(reason: string): void {
    if (this.disposed) {
      return;
    }
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

  /** 예약된 자동 refresh를 취소하고 누적 원인을 비운다. */
  private cancelScheduledPreviewRefresh(): void {
    if (this.previewRefreshTimer) {
      clearTimeout(this.previewRefreshTimer);
      this.previewRefreshTimer = undefined;
    }
    this.previewRefreshReason = "";
  }

  /**
   * 웹뷰 메시지를 처리한다.
   * @param msg 웹뷰에서 보낸 메시지
   */
  private async handleMessage(msg: PreviewMessage): Promise<void> {
    if (msg.type === "ready") {
      await this.sendPreview();
      return;
    }
    if (msg.type === "refresh") {
      await this.quickEditSaveQueue;
      this.cancelScheduledPreviewRefresh();
      await this.sendPreview();
      return;
    }
    if (msg.type === "openExistingPr") {
      await this.openExistingPullRequest();
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
    if (msg.type === "openQuickEditor") {
      await this.openQuickEditor(msg.path);
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

  /**
   * 마지막으로 검증된 preview 파일을 현재 작업 브랜치의 일반 editor로 연다.
   * @param filePath 웹뷰에서 선택한 저장소 상대 경로
   */
  private async openQuickEditor(filePath: string): Promise<void> {
    const file = this.quickEditFiles.find((candidate) => candidate.path === filePath);
    if (!file) {
      logWarn("PR preview quick edit skipped: file not in current preview", {
        repoRoot: this.service.repoRoot,
        path: filePath,
      });
      await vscode.window.showWarningMessage(
        vscode.l10n.t("This review file cannot be opened for quick editing.")
      );
      return;
    }
    if (
      !this.lastCurrentBranch
      || !this.lastSourceBranch
      || this.lastSourceBranch !== this.lastCurrentBranch
    ) {
      logWarn("PR preview quick edit skipped: source branch is not checked out", {
        repoRoot: this.service.repoRoot,
        sourceBranch: this.lastSourceBranch,
        currentBranch: this.lastCurrentBranch,
        path: filePath,
      });
      await vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Quick edit is available only for files on the checked-out source branch."
        )
      );
      return;
    }
    try {
      const session = await this.quickEditService.prepare(
        file.path,
        this.lastSourceBranch
      );
      if (await openPullRequestQuickEdit(this.service.repoRoot, file)) {
        this.activeQuickEditSession = session;
      }
    } catch (error) {
      logWarn("PR preview quick edit preparation failed", {
        repoRoot: this.service.repoRoot,
        path: file.path,
        reason: error instanceof Error ? error.message : String(error),
      });
      await vscode.window.showWarningMessage(quickEditPreparationMessage(error));
    }
  }

  /**
   * 활성 Quick Edit 문서의 저장만 직렬 staging queue에 넣는다.
   * - 일반 저장은 staged preview 원본을 바꾸지 않으므로 불필요한 전체 refresh를 만들지 않는다.
   * @param document 방금 디스크에 저장된 VS Code 문서
   */
  private handleSavedDocument(document: vscode.TextDocument): void {
    const session = this.activeQuickEditSession;
    if (
      !session
      || document.uri.scheme !== "file"
      || path.resolve(document.uri.fsPath)
        !== path.resolve(this.service.repoRoot, session.relativePath)
    ) {
      return;
    }
    const staging = this.quickEditSaveQueue.then(async () => {
      const changed = await this.quickEditService.stageSavedFile(session);
      if (!changed) {
        logInfo("PR preview quick edit save skipped: index already matches", {
          repoRoot: this.service.repoRoot,
          path: session.relativePath,
        });
        return;
      }
      logInfo("PR preview quick edit save staged", {
        repoRoot: this.service.repoRoot,
        path: session.relativePath,
      });
      this.schedulePreviewRefresh("quickEditSave");
    });
    this.quickEditSaveQueue = staging.catch(async (error) => {
      logError("PR preview quick edit save staging failed", error, {
        repoRoot: this.service.repoRoot,
        path: session.relativePath,
      });
      await vscode.window.showErrorMessage(
        vscode.l10n.t(
          "Quick Edit saved {0}, but the staged preview could not be updated: {1}",
          session.relativePath,
          error instanceof Error ? error.message : String(error)
        )
      );
    });
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
    this.post({ type: "previewLoading" });
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
      this.lastCurrentBranch = preview.currentBranch;
      this.quickEditFiles = preview.previewFiles;
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
      this.quickEditFiles = [];
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

  /** 타입이 보장된 메시지를 웹뷰로 보낸다. */
  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  /** 기존 PR URL을 기본 브라우저로 열고 Preview 패널은 유지한다. */
  private async openExistingPullRequest(): Promise<void> {
    const pullRequest = this.existingPr;
    if (!pullRequest?.number || !pullRequest.url) {
      vscode.window.showWarningMessage(vscode.l10n.t("Unable to open Pull Request #{0} on GitHub.", pullRequest?.number ?? ""));
      logWarn("PR preview existing pull request open skipped: missing URL", { repoRoot: this.service.repoRoot, number: pullRequest?.number, reason: "missing-url" });
      return;
    }
    try {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(pullRequest.url));
      if (!opened) throw new Error(vscode.l10n.t("Unable to open Pull Request #{0} on GitHub.", pullRequest.number));
      logInfo("PR preview existing pull request opened in browser", { repoRoot: this.service.repoRoot, number: pullRequest.number, url: pullRequest.url });
    } catch (error) {
      logError("PR preview existing pull request open failed", error, { repoRoot: this.service.repoRoot, number: pullRequest.number, url: pullRequest.url });
      void vscode.window.showErrorMessage(vscode.l10n.t("Unable to open Pull Request #{0} on GitHub.", pullRequest.number));
    }
  }

  /** 현재 선택된 source/target 이 기존 PR 의 head/base 와 같은지 확인한다. */
  private matchesExistingPr(): boolean {
    const target = this.baseBranch || this.existingPr?.baseRefName;
    const source = this.sourceBranch || this.existingPr?.headRefName;
    return (!target || target === this.existingPr?.baseRefName)
      && (!source || source === this.existingPr?.headRefName);
  }
}

/**
 * Quick Edit 준비 실패를 사용자가 바로 복구할 수 있는 안내로 바꾼다.
 * @param error Git 계층이 분류한 준비 오류 또는 예상하지 못한 실패
 * @returns warning notification에 표시할 로컬라이즈 문자열
 */
function quickEditPreparationMessage(error: unknown): string {
  if (error instanceof PullRequestQuickEditError) {
    if (error.code === "existingUnstagedChanges") {
      return vscode.l10n.t(
        "Quick Edit stages this file when saved. Stage or discard its existing unstaged changes first."
      );
    }
    if (error.code === "sourceBranchChanged") {
      return vscode.l10n.t(
        "Quick edit is available only for files on the checked-out source branch."
      );
    }
    if (error.code === "unsafePath") {
      return vscode.l10n.t(
        "This review file cannot be opened for quick editing."
      );
    }
  }
  return vscode.l10n.t(
    "Unable to prepare Quick Edit: {0}",
    error instanceof Error ? error.message : String(error)
  );
}

/** 오류 값을 사용자에게 보여줄 짧은 문자열로 바꾼다. */
function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
