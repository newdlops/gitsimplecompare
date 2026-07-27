// 선택된 GitHub Pull Request의 파일·리뷰 스레드를 VS Code 편집기에서 읽는 Review Center 패널.
// - GitHub detail 조회는 git 서비스, native diff 열기는 ui presenter에 위임해 패널은 lifecycle만 담당한다.
import * as vscode from "vscode";
import { PullRequestReviewCenterService } from "../git/pullRequestReviewCenterService";
import { PullRequestReviewDraftService } from "../git/pullRequestReviewDraftService";
import { PullRequestReviewMutationService } from "../git/pullRequestReviewMutationService";
import { PullRequestReviewChecksService } from "../git/pullRequestReviewChecksService";
import { GitService } from "../git/gitService";
import { managementMutationToApply, previewPullRequestManagementMutation, PullRequestManagementService, type PullRequestManagementPreview } from "../git/pullRequestManagementService";
import { reviewCenterPreviewCommentsForFile, type ReviewCenterSnapshot } from "../git/pullRequestReviewCenterModel";
import { resolvePreviewHeadRef, resolvePreviewTargetRef } from "../git/pullRequestPreviewTarget";
import { openPullRequestPreviewDiff } from "../ui/pullRequestPreviewDiff";
import { logError, logInfo } from "../ui/outputLog";
import { isReviewCenterWriteMessage, reviewWritesEnabled } from "../ui/reviewWriteGate";
import { buildReviewCenterHtml } from "./reviewCenterHtml";
import { WorkspaceReviewDraftStorage } from "./reviewDraftStorage";
import { ReviewCenterDraftCoordinator, reviewDraftTarget } from "./reviewCenterDraftCoordinator";
import { ReviewCenterThreadReplyCoordinator } from "./reviewCenterThreadReplyCoordinator";
import { ReviewCenterFileCommentCoordinator } from "./reviewCenterFileCommentCoordinator";
import { ReviewCenterLineCommentCoordinator } from "./reviewCenterLineCommentCoordinator";
import { ReviewCenterCommentCoordinator } from "./reviewCenterCommentCoordinator";
import { ReviewCenterChecksCoordinator } from "./reviewCenterChecksCoordinator";
import { ReviewCenterCommitsCoordinator } from "./reviewCenterCommitsCoordinator";
import { ReviewCenterSuggestionApplyCoordinator } from "./reviewCenterSuggestionApplyCoordinator";
import { ReviewCenterActivityCoordinator } from "./reviewCenterActivityCoordinator";
import { managementMutationFromInput } from "./reviewManagementMutationInput";
import type { ReviewCenterRenderMessage } from "./reviewCenterPanelMessages";
import type { ReviewCenterWebviewMessage } from "./reviewCenterProtocol";
/** 파일/스레드 읽기와 native diff 진입을 담당하는 Review Center 편집기 panel. */
export class ReviewCenterPanel {
  private static current: ReviewCenterPanel | undefined;
  private static workspaceState: vscode.Memento | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private requestId = 0;
  private refreshController?: AbortController;
  private filesPageController?: AbortController;
  private threadsPageController?: AbortController;
  private readonly viewedControllers = new Map<string, AbortController>();
  private readonly threadControllers = new Map<string, AbortController>();
  private managementController?: AbortController;
  private managementPreview?: { id: string; snapshot: ReviewCenterSnapshot; preview: PullRequestManagementPreview };
  private managementPreviewSequence = 0;
  private snapshot?: ReviewCenterSnapshot;
  private readonly reviewService: PullRequestReviewCenterService;
  private readonly managementService: PullRequestManagementService;
  private readonly draftService: PullRequestReviewDraftService;
  private readonly draftCoordinator: ReviewCenterDraftCoordinator;
  private readonly reviewMutationService: PullRequestReviewMutationService;
  private readonly fileCommentCoordinator: ReviewCenterFileCommentCoordinator;
  private readonly threadReplyCoordinator: ReviewCenterThreadReplyCoordinator;
  private readonly lineCommentCoordinator: ReviewCenterLineCommentCoordinator;
  private readonly commentCoordinator: ReviewCenterCommentCoordinator;
  private readonly checksCoordinator: ReviewCenterChecksCoordinator;
  private readonly commitsCoordinator: ReviewCenterCommitsCoordinator;
  private readonly activityCoordinator: ReviewCenterActivityCoordinator;
  private readonly suggestionApplyCoordinator: ReviewCenterSuggestionApplyCoordinator;
  /**
   * 선택 PR의 Center를 열거나 이미 열린 같은 Center를 앞으로 가져온다.
   * @param extensionUri media resource 기준 URI
   * @param repoRoot gh와 local ref를 실행할 저장소 루트
   * @param number 열 Pull Request 번호
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    repoRoot: string,
    number: number,
    workspaceState?: vscode.Memento,
    repository?: string
  ): void {
    if (ReviewCenterPanel.current?.matches(repoRoot, number, repository)) {
      ReviewCenterPanel.current.panel.reveal(vscode.ViewColumn.Active);
      void ReviewCenterPanel.current.refresh("reveal");
      return;
    }
    ReviewCenterPanel.current?.dispose();
    const panel = vscode.window.createWebviewPanel(
      "gitSimpleCompare.reviewCenter",
      vscode.l10n.t("Review Center: Pull Request #{0}", number),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")] }
    );
    const draftState = workspaceState ?? ReviewCenterPanel.workspaceState;
    if (!draftState) {
      panel.dispose();
      throw new Error("Review Center draft storage is unavailable.");
    }
    ReviewCenterPanel.current = new ReviewCenterPanel(panel, extensionUri, repoRoot, number, draftState, repository);
  }

  /** extension 활성화 시 workspace draft storage를 등록해 Graph 같은 보조 surface도 같은 Review Center를 열게 한다. */
  public static configureWorkspaceState(workspaceState: vscode.Memento): void {
    ReviewCenterPanel.workspaceState = workspaceState;
  }
  /** 생성 직후 HTML과 message/lifecycle listener를 연결한다. */
  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly repoRoot: string,
    private readonly number: number,
    workspaceState: vscode.Memento,
    private readonly repository?: string
  ) {
    this.reviewService = new PullRequestReviewCenterService(repoRoot);
    this.managementService = new PullRequestManagementService(repoRoot);
    this.draftService = new PullRequestReviewDraftService(repoRoot, new WorkspaceReviewDraftStorage(workspaceState));
    this.draftCoordinator = new ReviewCenterDraftCoordinator(this.draftService, (message) => this.post(message), () => ReviewCenterPanel.current === this);
    this.reviewMutationService = new PullRequestReviewMutationService(repoRoot, this.draftService);
    this.fileCommentCoordinator = new ReviewCenterFileCommentCoordinator(this.reviewMutationService, {
      post: (message) => this.post(message), refresh: () => this.refresh("fileCommentAdded"), isCurrent: () => ReviewCenterPanel.current === this,
    });
    this.threadReplyCoordinator = new ReviewCenterThreadReplyCoordinator(this.reviewMutationService, { post: (message) => this.post(message), refresh: () => this.refresh("threadReplyAdded"), isCurrent: () => ReviewCenterPanel.current === this });
    this.lineCommentCoordinator = new ReviewCenterLineCommentCoordinator(this.reviewMutationService, { post: (message) => this.post(message), refresh: () => this.refresh("lineCommentAdded"), isCurrent: () => ReviewCenterPanel.current === this });
    this.commentCoordinator = new ReviewCenterCommentCoordinator(this.reviewMutationService, {
      post: (message) => this.post(message), refresh: () => this.refresh("commentMutated"), isCurrent: () => ReviewCenterPanel.current === this,
    });
    this.checksCoordinator = new ReviewCenterChecksCoordinator(new PullRequestReviewChecksService(repoRoot), {
      post: (message) => this.post(message),
      isCurrent: (snapshot) => ReviewCenterPanel.current === this && this.snapshot === snapshot,
    });
    this.commitsCoordinator = new ReviewCenterCommitsCoordinator(this.reviewService, {
      post: (message) => this.post(message), isCurrent: (snapshot) => ReviewCenterPanel.current === this && this.snapshot === snapshot,
    });
    this.activityCoordinator = new ReviewCenterActivityCoordinator(this.reviewService, {
      post: (message) => this.post(message), isCurrent: (snapshot) => ReviewCenterPanel.current === this && this.snapshot === snapshot,
    });
    this.suggestionApplyCoordinator = new ReviewCenterSuggestionApplyCoordinator(repoRoot, new GitService(repoRoot), {
      post: (message) => this.post(message), isCurrent: (snapshot) => ReviewCenterPanel.current === this && this.snapshot === snapshot,
    });
    panel.webview.html = buildReviewCenterHtml(extensionUri, panel.webview, reviewWritesEnabled());
    panel.webview.onDidReceiveMessage((message: ReviewCenterWebviewMessage) => {
      void this.handleMessage(message);
    }, undefined, this.disposables);
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    logInfo("review center panel opened", { number });
  }

  /** 현재 panel이 같은 repository/PR 조합인지 확인한다. */
  private matches(repoRoot: string, number: number, repository?: string): boolean {
    return this.repoRoot === repoRoot && this.number === number && this.repository === repository;
  }

  /** 최신 데이터를 읽고 stale 요청은 조용히 폐기한다. */
  private refresh(reason: string): Promise<void> {
    this.refreshController?.abort();
    const controller = new AbortController();
    this.refreshController = controller;
    const requestId = ++this.requestId;
    this.post({ type: "loading" });
    logInfo("review center refresh started", { number: this.number, reason, requestId });
    this.filesPageController?.abort();
    this.threadsPageController?.abort();
    this.managementController?.abort();
    this.checksCoordinator.abort();
    this.commitsCoordinator.abort();
    this.activityCoordinator.abort();
    this.suggestionApplyCoordinator.clear();
    this.draftCoordinator.abort();
    if (this.snapshot) {
      const target = reviewDraftTarget(this.snapshot);
      if (target) void this.draftCoordinator.flush(this.snapshot);
    }
    this.managementPreview = undefined;
    return this.reviewService.getSnapshot(this.number, { signal: controller.signal, repository: this.repository })
      .then((snapshot) => {
        if (!this.isCurrent(requestId, controller)) return;
        const renderSnapshot = { ...snapshot, canOpenNativeDiff: !this.repository };
        this.snapshot = renderSnapshot;
        this.panel.title = vscode.l10n.t("Review Center: Pull Request #{0}", renderSnapshot.number);
        this.post({ type: "snapshot", snapshot: renderSnapshot });
        void this.draftCoordinator.reconcile(renderSnapshot);
        logInfo("review center refresh completed", { number: renderSnapshot.number, files: renderSnapshot.files.length, threads: renderSnapshot.threads.length });
      })
      .catch((error) => {
        if (!this.isCurrent(requestId, controller) || isAbortError(error)) return;
        logError("review center refresh failed", error, { number: this.number, reason });
        this.post({ type: "error", message: displayError(error) });
      })
      .finally(() => {
        if (this.refreshController === controller) this.refreshController = undefined;
      });
  }

  /** 웹뷰 의도를 refresh/native diff/GitHub browser 보조 동작으로 분기한다. */
  private async handleMessage(message: ReviewCenterWebviewMessage): Promise<void> {
    if (isReviewCenterWriteMessage(message) && !reviewWritesEnabled()) {
      logInfo("review center write skipped", { number: this.number, type: message.type, reason: "reviewWritesDisabled" });
      return;
    }
    if (message.type === "ready" || message.type === "refresh") {
      await this.refresh(message.type);
      return;
    }
    if (message.type === "loadMoreFiles") {
      await this.loadMoreFiles();
      return;
    }
    if (message.type === "loadMoreThreads") {
      await this.loadMoreThreads();
      return;
    }
    if (message.type === "loadReviewChecks") {
      await this.checksCoordinator.load(this.snapshot);
      return;
    }
    if (message.type === "loadReviewCommits") {
      await this.commitsCoordinator.load(this.snapshot);
      return;
    }
    if (message.type === "loadReviewActivity") {
      await this.activityCoordinator.load(this.snapshot);
      return;
    }
    if (message.type === "toggleViewed" && message.path && typeof message.viewed === "boolean") {
      await this.setFileViewed(message.path, message.viewed);
      return;
    }
    if (message.type === "toggleThreadResolved" && message.threadId && typeof message.resolved === "boolean") {
      await this.setThreadResolved(message.threadId, message.resolved);
      return;
    }
    if (message.type === "previewManagement") {
      this.previewManagement(message.kind, message.values);
      return;
    }
    if (message.type === "applyManagement") {
      await this.applyManagement(message.previewId);
      return;
    }
    if (message.type === "cancelManagementPreview") {
      if (this.managementPreview?.id === message.previewId) this.managementPreview = undefined;
      return;
    }
    if (message.type === "saveReviewDraft") {
      this.draftCoordinator.saveLocal(this.snapshot, message.body, message.event);
      return;
    }
    if (message.type === "startReviewDraft") {
      await this.draftCoordinator.start(this.snapshot, message.body, message.event);
      return;
    }
    if (message.type === "submitReviewDraft") {
      if (await this.draftCoordinator.submit(this.snapshot, message.reviewId, message.body, message.event)) {
        await this.refresh("reviewSubmitted");
      }
      return;
    }
    if (message.type === "discardReviewDraft") {
      await this.draftCoordinator.discard(this.snapshot, message.reviewId);
      return;
    }
    if (message.type === "addFileReviewComment") {
      await this.fileCommentCoordinator.add(this.snapshot, message.path, message.body, message.reviewBody);
      return;
    }
    if (message.type === "addLineReviewComment") {
      await this.lineCommentCoordinator.add(this.snapshot, message);
      return;
    }
    if (message.type === "addReviewThreadReply") {
      await this.threadReplyCoordinator.reply(this.snapshot, message.threadId, message.body, message.reviewBody);
      return;
    }
    if (message.type === "updateReviewComment") {
      await this.commentCoordinator.update(this.snapshot, message.commentId, message.body);
      return;
    }
    if (message.type === "deleteReviewComment") {
      await this.commentCoordinator.delete(this.snapshot, message.commentId);
      return;
    }
    if (message.type === "previewSuggestionApply") {
      await this.suggestionApplyCoordinator.preview(this.snapshot, message.threadId, message.commentId, message.suggestionIndex);
      return;
    }
    if (message.type === "applySuggestion") {
      await this.suggestionApplyCoordinator.apply(this.snapshot, message.previewId);
      return;
    }
    if (message.type === "openGitHub" && this.snapshot?.url) {
      await vscode.env.openExternal(vscode.Uri.parse(this.snapshot.url));
      return;
    }
    if (message.type === "openCheckUrl" && /^https:\/\/github(?:\.com|\.[^/]+)\//.test(message.url)) {
      await vscode.env.openExternal(vscode.Uri.parse(message.url));
      return;
    }
    if (message.type === "openFile" && message.path) {
      await this.openFile(message.path);
    }
  }

  /** 현재 PR metadata와 사용자 입력을 비교해 side-effect 없는 management preview를 만든다. */
  private previewManagement(
    kind: Extract<ReviewCenterWebviewMessage, { type: "previewManagement" }>["kind"],
    values: string[]
  ): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    if (!snapshot.viewerCanUpdate) {
      this.post({ type: "managementError", message: vscode.l10n.t("You do not have permission to update this pull request metadata.") });
      return;
    }
    try {
      const mutation = managementMutationFromInput(kind, values);
      const preview = previewPullRequestManagementMutation(
        {
          assignees: snapshot.assignees,
          labels: snapshot.labels,
          requestedReviewers: snapshot.requestedReviewers,
          isDraft: snapshot.isDraft,
          milestone: snapshot.milestone,
        },
        mutation
      );
      const id = `management-${++this.managementPreviewSequence}`;
      this.managementPreview = { id, snapshot, preview };
      this.post({ type: "managementPreview", previewId: id, preview });
    } catch (error) {
      this.post({ type: "managementError", message: displayError(error) });
    }
  }

  /** 확인된 preview만 write하고 GitHub post-read 결과를 snapshot에 반영한다. */
  private async applyManagement(previewId: string): Promise<void> {
    const pending = this.managementPreview;
    if (!pending || pending.id !== previewId || this.managementController) return;
    if (!pending.preview.canApply) {
      this.post({ type: "managementError", message: vscode.l10n.t("All selected metadata values are already in the requested state.") });
      return;
    }
    if (this.snapshot !== pending.snapshot) {
      this.managementPreview = undefined;
      this.post({ type: "managementError", message: vscode.l10n.t("Pull request metadata changed. Create a new preview before applying changes.") });
      return;
    }
    const controller = new AbortController();
    this.managementController = controller;
    try {
      const result = await this.managementService.apply(
        { repository: pending.snapshot.repository, number: pending.snapshot.number, pullRequestId: pending.snapshot.pullRequestId },
        managementMutationToApply(pending.preview),
        controller.signal
      );
      if (ReviewCenterPanel.current !== this || this.managementController !== controller) return;
      const nextSnapshot: ReviewCenterSnapshot = {
        ...pending.snapshot,
        assignees: result.metadata.assignees,
        labels: result.metadata.labels,
        requestedReviewers: result.metadata.requestedReviewers,
        isDraft: result.metadata.isDraft,
        milestone: result.metadata.milestone,
      };
      this.snapshot = nextSnapshot;
      this.managementPreview = undefined;
      this.post({ type: "managementResult", snapshot: nextSnapshot, verified: result.verified, mismatches: result.mismatches });
      logInfo("review center management mutation completed", { number: nextSnapshot.number, kind: result.mutation.kind, verified: result.verified, mismatches: result.mismatches.length });
    } catch (error) {
      if (!isAbortError(error) && ReviewCenterPanel.current === this && this.managementController === controller) {
        logError("review center management mutation failed", error, { number: pending.snapshot.number, kind: pending.preview.mutation.kind });
        this.post({ type: "managementError", message: displayError(error) });
      }
    } finally {
      if (this.managementController === controller) this.managementController = undefined;
    }
  }

  /** review thread의 resolve 상태를 optimistic하게 바꾸고 오류면 해당 thread만 원복한다. */
  private async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
    const snapshot = this.snapshot;
    const thread = snapshot?.threads.find((item) => item.id === threadId);
    if (!snapshot || !thread || this.threadControllers.has(threadId)) return;
    const controller = new AbortController();
    this.threadControllers.set(threadId, controller);
    this.snapshot = { ...snapshot, threads: replaceResolvedState(snapshot.threads, threadId, resolved) };
    try {
      await this.reviewService.setThreadResolved(threadId, resolved, { signal: controller.signal });
      if (!this.isCurrentThread(threadId, controller)) return;
      this.post({ type: "threadUpdate", threadId, resolved });
      logInfo("review center thread resolve state updated", { number: snapshot.number, threadId, resolved });
    } catch (error) {
      if (isAbortError(error) || !this.isCurrentThread(threadId, controller)) return;
      this.snapshot = this.snapshot ? { ...this.snapshot, threads: replaceResolvedState(this.snapshot.threads, threadId, thread.isResolved) } : undefined;
      logError("review center thread resolve state failed", error, { number: snapshot.number, threadId, resolved });
      this.post({ type: "threadError", threadId, resolved: thread.isResolved, message: displayError(error) });
    } finally {
      if (this.threadControllers.get(threadId) === controller) this.threadControllers.delete(threadId);
    }
  }

  /** GitHub viewer의 Viewed 상태를 optimistic하게 바꾸고 실패하면 해당 파일만 되돌린다. */
  private async setFileViewed(path: string, viewed: boolean): Promise<void> {
    const snapshot = this.snapshot;
    const file = snapshot?.files.find((item) => item.path === path);
    if (!snapshot || !file || this.viewedControllers.has(path)) return;
    if (!snapshot.pullRequestId) {
      this.post({ type: "viewError", path, viewed: file.isViewed, message: vscode.l10n.t("Unable to update Viewed state because the pull request id is unavailable.") });
      return;
    }
    const controller = new AbortController();
    this.viewedControllers.set(path, controller);
    this.snapshot = { ...snapshot, files: replaceViewedState(snapshot.files, path, viewed) };
    try {
      await this.reviewService.setFileViewed(snapshot.pullRequestId, path, viewed, { signal: controller.signal });
      if (!this.isCurrentViewed(path, controller)) return;
      this.post({ type: "viewUpdate", path, viewed });
      logInfo("review center file Viewed state updated", { number: snapshot.number, path, viewed });
    } catch (error) {
      if (isAbortError(error) || !this.isCurrentViewed(path, controller)) return;
      this.snapshot = this.snapshot ? { ...this.snapshot, files: replaceViewedState(this.snapshot.files, path, file.isViewed) } : undefined;
      logError("review center file Viewed state failed", error, { number: snapshot.number, path, viewed });
      this.post({ type: "viewError", path, viewed: file.isViewed, message: displayError(error) });
    } finally {
      if (this.viewedControllers.get(path) === controller) this.viewedControllers.delete(path);
    }
  }
  /** files의 다음 GraphQL page를 현재 snapshot에 중복 없이 병합한다. */
  private async loadMoreFiles(): Promise<void> {
    const snapshot = this.snapshot;
    const cursor = snapshot?.filesEndCursor;
    if (!snapshot || !cursor || this.filesPageController) return;
    const controller = new AbortController();
    this.filesPageController = controller;
    try {
      const page = await this.reviewService.getFilesPage(snapshot.repository, snapshot.number, cursor, { signal: controller.signal });
      if (!this.isCurrentPage(snapshot, controller, "files")) return;
      const nextSnapshot: ReviewCenterSnapshot = {
        ...snapshot,
        files: mergeByPath(snapshot.files, page.files),
        filesTruncated: page.hasNextPage,
        filesEndCursor: page.endCursor,
      };
      this.snapshot = nextSnapshot;
      this.post({ type: "pageLoaded", scope: "files", snapshot: nextSnapshot });
      logInfo("review center files page loaded", { number: snapshot.number, files: page.files.length, hasNextPage: page.hasNextPage });
    } catch (error) {
      if (!isAbortError(error)) {
        logError("review center files page failed", error, { number: snapshot.number });
        this.post({ type: "pageError", scope: "files", message: displayError(error) });
      }
    } finally {
      if (this.filesPageController === controller) this.filesPageController = undefined;
    }
  }

  /** review thread의 다음 GraphQL page를 현재 snapshot에 중복 없이 병합한다. */
  private async loadMoreThreads(): Promise<void> {
    const snapshot = this.snapshot;
    const cursor = snapshot?.threadsEndCursor;
    if (!snapshot || !cursor || this.threadsPageController) return;
    const controller = new AbortController();
    this.threadsPageController = controller;
    try {
      const page = await this.reviewService.getThreadsPage(snapshot.repository, snapshot.number, cursor, { signal: controller.signal });
      if (!this.isCurrentPage(snapshot, controller, "threads")) return;
      const nextSnapshot: ReviewCenterSnapshot = {
        ...snapshot,
        threads: mergeById(snapshot.threads, page.threads),
        threadsTruncated: page.hasNextPage,
        threadsEndCursor: page.endCursor,
      };
      this.snapshot = nextSnapshot;
      this.post({ type: "pageLoaded", scope: "threads", snapshot: nextSnapshot });
      logInfo("review center threads page loaded", { number: snapshot.number, threads: page.threads.length, hasNextPage: page.hasNextPage });
    } catch (error) {
      if (!isAbortError(error)) {
        logError("review center threads page failed", error, { number: snapshot.number });
        this.post({ type: "pageError", scope: "threads", message: displayError(error) });
      }
    } finally {
      if (this.threadsPageController === controller) this.threadsPageController = undefined;
    }
  }

  /** 선택 파일을 base↔head native diff로 열고 이후 review 작업공간과 같은 문맥을 보존한다. */
  private async openFile(path: string): Promise<void> {
    if (this.repository) {
      vscode.window.showWarningMessage(vscode.l10n.t("Native diff is unavailable for a pull request from another repository."));
      return;
    }
    const snapshot = this.snapshot;
    const file = snapshot?.files.find((item) => item.path === path);
    if (!snapshot || !file || !snapshot.baseRefName || !snapshot.headRefName) return;
    try {
      const [baseRef, headRef] = await Promise.all([
        resolvePreviewTargetRef(this.repoRoot, snapshot.baseRefName),
        resolvePreviewHeadRef(this.repoRoot, snapshot.headRefName, snapshot.headOid),
      ]);
      await openPullRequestPreviewDiff(this.repoRoot, {
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        baseRef,
        headRef,
        comments: reviewCenterPreviewCommentsForFile(snapshot, file.path),
      });
      logInfo("review center file diff opened", { number: snapshot.number, path: file.path });
    } catch (error) {
      logError("review center file diff failed", error, { number: snapshot.number, path });
      vscode.window.showErrorMessage(vscode.l10n.t("Unable to open this pull request file diff."));
    }
  }

  /** panel dispose 시 진행 중 gh와 모든 event listener를 정리한다. */
  private dispose(): void {
    this.refreshController?.abort();
    this.filesPageController?.abort();
    this.threadsPageController?.abort();
    this.managementController?.abort();
    this.fileCommentCoordinator.abort();
    this.threadReplyCoordinator.abort();
    this.lineCommentCoordinator.abort();
    this.commentCoordinator.abort();
    this.checksCoordinator.abort();
    this.commitsCoordinator.abort();
    this.activityCoordinator.abort();
    this.suggestionApplyCoordinator.clear();
    this.managementPreview = undefined;
    this.viewedControllers.forEach((controller) => controller.abort());
    this.viewedControllers.clear();
    this.threadControllers.forEach((controller) => controller.abort());
    this.threadControllers.clear();
    this.refreshController = undefined;
    this.filesPageController = undefined;
    this.threadsPageController = undefined;
    this.managementController = undefined;
    this.draftCoordinator.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
    if (ReviewCenterPanel.current === this) ReviewCenterPanel.current = undefined;
    logInfo("review center panel disposed", { number: this.number });
  }

  /** refresh fence와 panel 생존 여부를 동시에 확인한다. */
  private isCurrent(requestId: number, controller: AbortController): boolean {
    return ReviewCenterPanel.current === this && this.requestId === requestId && this.refreshController === controller;
  }

  /** page 요청이 refresh/close 뒤의 오래된 snapshot에 쓰지 않도록 검사한다. */
  private isCurrentPage(snapshot: ReviewCenterSnapshot, controller: AbortController, scope: "files" | "threads"): boolean {
    const currentController = scope === "files" ? this.filesPageController : this.threadsPageController;
    return ReviewCenterPanel.current === this && this.snapshot === snapshot && currentController === controller;
  }

  /** 경합하는 refresh/page 요청이 있어도 동일 파일의 최신 Viewed mutation만 UI에 반영한다. */
  private isCurrentViewed(path: string, controller: AbortController): boolean {
    return ReviewCenterPanel.current === this && this.viewedControllers.get(path) === controller;
  }

  /** 같은 thread의 최신 resolve mutation만 화면으로 되돌린다. */
  private isCurrentThread(threadId: string, controller: AbortController): boolean {
    return ReviewCenterPanel.current === this && this.threadControllers.get(threadId) === controller;
  }

  /** panel이 살아 있을 때만 UI message를 전송한다. */
  private post(message: ReviewCenterRenderMessage): void {
    void this.panel.webview.postMessage(message);
  }
}

/** 파일 path를 key로 삼아 재요청/rename 경계에서도 중복 없이 page를 합친다. */
function mergeByPath<T extends { path: string }>(current: readonly T[], next: readonly T[]): T[] {
  const merged = new Map(current.map((item) => [item.path, item]));
  next.forEach((item) => merged.set(item.path, item));
  return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/** review thread node id를 key로 삼아 이전 페이지의 답글을 유지하며 page를 합친다. */
function mergeById<T extends { id: string }>(current: readonly T[], next: readonly T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  next.forEach((item) => merged.set(item.id, item));
  return [...merged.values()];
}

/** path가 같은 파일 하나의 GitHub Viewed 상태만 불변으로 바꾼다. */
function replaceViewedState(
  files: readonly ReviewCenterSnapshot["files"][number][],
  path: string,
  isViewed: boolean
): ReviewCenterSnapshot["files"] {
  return files.map((file) => file.path === path ? { ...file, isViewed } : file);
}

/** id가 같은 review thread 하나의 resolve 상태만 불변으로 바꾼다. */
function replaceResolvedState(
  threads: readonly ReviewCenterSnapshot["threads"][number][],
  threadId: string,
  isResolved: boolean
): ReviewCenterSnapshot["threads"] {
  return threads.map((thread) => thread.id === threadId ? { ...thread, isResolved } : thread);
}
/** gh 취소 오류는 panel lifecycle의 정상 stale 상태로 처리한다. */
function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ABORTED";
}

/** stderr 대신 UI에 적합한 단일 오류 문구를 제공한다. */
function displayError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.replace(/\s+/g, " ").slice(0, 320)
    : vscode.l10n.t("Unable to load the pull request review. Check GitHub CLI authentication and try again.");
}
