// GitHub Pull Request Reviews 사이드바의 상태·생명주기 관리자.
// - GitHub 읽기/정규화는 git 서비스에, 화면 렌더는 media/review-queue에 위임한다.
import * as vscode from "vscode";
import { PullRequestManagementBulkService, type PullRequestManagementBulkPreview, type PullRequestManagementBulkSummary, type PullRequestManagementBulkTarget } from "../git/pullRequestManagementBulkService";
import { PullRequestManagementService, type PullRequestManagementMutation } from "../git/pullRequestManagementService";
import { PullRequestReviewQueueService, type ReviewQueueIdentity } from "../git/pullRequestReviewQueueService";
import { isReviewQueueAbort } from "../git/pullRequestReviewQueueFailure";
import type { ReviewQueueLane, ReviewQueueSnapshot } from "../git/pullRequestReviewModel";
import { logError, logInfo, showOutputLog } from "../ui/outputLog";
import { isReviewQueueWriteMessage, reviewWritesEnabled } from "../ui/reviewWriteGate";
import { buildReviewsHtml } from "./reviewsHtml";
import type { ReviewsWebviewMessage } from "./reviewsProtocol";
import { ReviewCenterPanel } from "./reviewCenterPanel";
import { ReviewQueueStorage, type SavedReviewQueue } from "./reviewQueueStorage";
import { managementMutationFromInput } from "./reviewManagementMutationInput";
import { mergeReviewQueuePage } from "./reviewQueuePaginationModel";
import { ReviewQueueCountCache, type ReviewQueueCountProjection } from "./reviewQueueCountCache";
import {
  reviewQueueCountProjection,
  reviewQueueErrorPresentation,
  selectedReviewQueueBulkTargets,
  type ReviewsShellFailureKind,
} from "./reviewsViewPresentation";
/** Reviews 홈 웹뷰가 받을 상태 메시지. */
type ReviewsRenderMessage =
  | { type: "loading" }
  | { type: "cachedCounts"; repository: string; viewer: string; counts: ReviewQueueCountProjection; fetchedAt: number; freshness: "fresh" | "stale" }
  | { type: "snapshot"; snapshot: ReviewQueueSnapshot }
  | { type: "queuePageLoaded"; lane: ReviewQueueLane; snapshot: ReviewQueueSnapshot }
  | { type: "queuePageError"; lane: ReviewQueueLane; message: string }
  | { type: "savedQueues"; queues: SavedReviewQueue[]; activeId?: string }
  | { type: "managementScope"; kind: "repository" | "owner" | "team"; value?: string }
  | { type: "savedQueueError"; message: string }
  | { type: "bulkManagementPreview"; previewId: string; preview: PullRequestManagementBulkPreview }
  | { type: "bulkManagementResult"; summary: PullRequestManagementBulkSummary; retryableCount: number }
  | { type: "bulkManagementError"; message: string }
  | { type: "error"; message: string; kind: ReviewsShellFailureKind };

/** Personal과 Management를 같은 깊이로 제공하는 GitHub Reviews 웹뷰 provider. */
export class ReviewsViewProvider implements vscode.WebviewViewProvider {
  /** package.json에 기여하는 webview view 식별자. */
  public static readonly viewId = "gitSimpleCompare.reviews";
  private view?: vscode.WebviewView;
  private refreshController?: AbortController;
  private requestId = 0;
  private readonly pageControllers = new Map<ReviewQueueLane, AbortController>();
  private snapshot?: ReviewQueueSnapshot;
  private activeSavedQueue?: SavedReviewQueue;
  private managementScope: { kind: "repository" } | { kind: "owner"; owner: string } | { kind: "team"; team: string } = { kind: "repository" };
  private bulkController?: AbortController;
  private bulkPreview?: { id: string; preview: PullRequestManagementBulkPreview };
  private bulkRetry?: { targets: PullRequestManagementBulkTarget[]; mutation: PullRequestManagementMutation };
  /** 숨겨진 sidebar에서 완료된 bulk 결과를 다음 visible webview에도 복원한다. */
  private bulkResult?: { summary: PullRequestManagementBulkSummary; retryableCount: number };
  private bulkPreviewSequence = 0;
  private readonly savedQueues: ReviewQueueStorage;
  /** PR metadata 없이 Personal/Management count만 보관하는 workspace-local cache. */
  private readonly countCache: ReviewQueueCountCache;
  /** 현재 process에서 identity가 확인된 cache key. revoked auth 때만 이 key를 삭제한다. */
  private lastCountCacheIdentity?: { repository: string; account: string };

  /**
   * provider를 만들고 workspace/active editor 변경 시 보이는 화면만 새로고침한다.
   * @param extensionUri media 리소스 기준 확장 URI
   */
  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceState: vscode.Memento,
    globalState: vscode.Memento
  ) {
    this.savedQueues = new ReviewQueueStorage(globalState);
    this.countCache = new ReviewQueueCountCache(workspaceState);
    ReviewCenterPanel.configureWorkspaceState(workspaceState);
  }

  /**
   * VS Code가 Reviews view를 표시할 때 webview 보안 옵션과 이벤트를 연결한다.
   * @param view VS Code가 만든 sidebar webview view
   */
  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = buildReviewsHtml(this.extensionUri, view.webview, reviewWritesEnabled());
    view.webview.onDidReceiveMessage((message: ReviewsWebviewMessage) => {
      void this.handleMessage(message);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.refresh("viewVisible");
      } else {
        this.cancelRefresh("viewHidden");
      }
    });
    view.onDidDispose(() => {
      this.cancelRefresh("viewDisposed");
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  /** Reviews view가 보이는지 반환한다. */
  public isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  /** 외부 Git 상태 이벤트가 필요할 때 최신 queue를 다시 읽도록 공개하는 진입점. */
  public refresh(reason = "manual"): Promise<void> {
    if (!this.view?.visible) {
      logInfo("review queue refresh skipped", { reason, cause: "viewHidden" });
      return Promise.resolve();
    }
    const root = this.resolveRepositoryRoot();
    if (!root) {
      this.post({
        type: "error",
        kind: "noRepository",
        message: vscode.l10n.t("Open a folder that contains a GitHub repository to load pull request reviews."),
      });
      return Promise.resolve();
    }
    this.cancelRefresh("superseded");
    const controller = new AbortController();
    this.refreshController = controller;
    const requestId = ++this.requestId;
    this.post({ type: "loading" });
    logInfo("review queue refresh started", { reason, requestId });
    const service = new PullRequestReviewQueueService(root);
    return service.getIdentity(controller.signal)
      .then(async (identity) => {
        await this.restoreCachedCounts(identity, requestId, controller);
        if (!this.isCurrentRequest(requestId, controller)) return undefined;
        return service.getSnapshot({
          signal: controller.signal,
          identity,
          managementQuery: this.activeSavedQueue?.query,
          managementScope: this.managementScope,
        });
      })
      .then((snapshot) => {
        if (!snapshot) return;
        if (!this.isCurrentRequest(requestId, controller)) {
          return;
        }
        this.snapshot = snapshot;
        const queues = this.savedQueues.load(snapshot.repository, snapshot.viewer);
        if (this.activeSavedQueue && !queues.some((queue) => queue.id === this.activeSavedQueue?.id)) this.activeSavedQueue = undefined;
        logInfo("review queue refresh completed", {
          requestId,
          repository: snapshot.repository,
          requested: snapshot.personal.requested.length,
          authored: snapshot.personal.authored.length,
          managed: snapshot.management.open.length,
        });
        this.post({ type: "snapshot", snapshot });
        void this.persistCounts(snapshot);
        this.post({ type: "savedQueues", queues, activeId: this.activeSavedQueue?.id });
        this.post({ type: "managementScope", kind: this.managementScope.kind, ...(this.managementScope.kind === "owner" ? { value: this.managementScope.owner } : this.managementScope.kind === "team" ? { value: this.managementScope.team } : {}) });
        if (this.bulkResult) this.post({ type: "bulkManagementResult", ...this.bulkResult });
      })
      .catch((error) => {
        if (!this.isCurrentRequest(requestId, controller) || isAbortError(error)) {
          return;
        }
        const presentation = reviewQueueErrorPresentation(error);
        if (presentation.kind === "authRequired") {
          void this.invalidateLastCountCache();
        }
        logError("review queue refresh failed", error, { reason, requestId });
        this.post({
          type: "error",
          kind: presentation.kind,
          message: presentation.message,
        });
      })
      .finally(() => {
        if (this.refreshController === controller) {
          this.refreshController = undefined;
        }
      });
  }

  /**
   * default repository scope일 때만 authenticated identity에 맞는 count cache를 화면에 복원한다.
   * @param identity GitHub에서 방금 확인한 canonical repository와 viewer
   * @param requestId stale refresh가 cache 복원을 덮지 않게 하는 generation
   * @param controller 현재 refresh의 취소 controller
   */
  private async restoreCachedCounts(
    identity: ReviewQueueIdentity,
    requestId: number,
    controller: AbortController
  ): Promise<void> {
    this.lastCountCacheIdentity = {
      repository: identity.repository,
      account: identity.viewer,
    };
    if (!this.usesDefaultCountCache()) return;
    const cached = await this.countCache.read({
      repository: identity.repository,
      account: identity.viewer,
    });
    if (cached.kind === "missing" || !this.isCurrentRequest(requestId, controller)) return;
    this.post({
      type: "cachedCounts",
      repository: identity.repository,
      viewer: identity.viewer,
      counts: cached.entry.counts,
      fetchedAt: cached.entry.fetchedAt,
      freshness: cached.kind,
    });
    logInfo("review queue cached counts restored", {
      requestId,
      freshness: cached.kind,
      personal: cached.entry.counts.personal,
      management: cached.entry.counts.management,
    });
  }

  /** 성공 snapshot의 count projection만 저장하고 PR metadata는 workspaceState에 남기지 않는다. */
  private async persistCounts(snapshot: ReviewQueueSnapshot): Promise<void> {
    if (!this.usesDefaultCountCache()) return;
    const counts = reviewQueueCountProjection(snapshot);
    try {
      await this.countCache.write(
        { repository: snapshot.repository, account: snapshot.viewer },
        counts
      );
      logInfo("review queue cached counts stored", { ...counts });
    } catch (error) {
      logError("review queue cached counts store failed", error);
    }
  }

  /** saved query나 cross-repository scope는 다른 의미를 가지므로 default cache와 섞지 않는다. */
  private usesDefaultCountCache(): boolean {
    return this.managementScope.kind === "repository" && !this.activeSavedQueue;
  }

  /** 명시적 auth revoke/401 뒤 현재 process에서 확인한 account cache만 삭제한다. */
  private async invalidateLastCountCache(): Promise<void> {
    const identity = this.lastCountCacheIdentity;
    if (!identity) return;
    try {
      await this.countCache.invalidate(identity);
      logInfo("review queue cached counts invalidated", { reason: "authRequired" });
    } catch (error) {
      logError("review queue cached counts invalidation failed", error);
    }
  }

  /** webview에서 온 refresh/Review Center 열기 요청을 작은 액션으로 분기한다. */
  private async handleMessage(message: ReviewsWebviewMessage): Promise<void> {
    if (isReviewQueueWriteMessage(message) && !reviewWritesEnabled()) {
      logInfo("review queue write skipped", { type: message.type, reason: "reviewWritesDisabled" });
      return;
    }
    if (message.type === "selectSidebarMode") {
      await vscode.commands.executeCommand(
        message.mode === "changes"
          ? "gitSimpleCompare.showChanges"
          : "gitSimpleCompare.showReviews"
      );
      return;
    }
    if (message.type === "ready" || message.type === "refresh") {
      await this.refresh(message.type);
      return;
    }
    if (message.type === "startGitHubAuth") {
      this.startGitHubAuth();
      return;
    }
    if (message.type === "showOutputLog") {
      showOutputLog();
      return;
    }
    if (message.type === "loadMoreQueue") {
      await this.loadMoreQueue(message.lane);
      return;
    }
    if (message.type === "openReviewCenter" && Number.isInteger(message.number) && message.number > 0) {
      const root = this.resolveRepositoryRoot();
      if (root) {
        const repository = message.repository?.trim();
        ReviewCenterPanel.createOrShow(this.extensionUri, root, message.number, this.workspaceState, repository);
      }
      return;
    }
    if (message.type === "selectSavedQueue") {
      await this.selectSavedQueue(message.id);
      return;
    }
    if (message.type === "selectManagementScope") {
      const kind = message.kind || "repository";
      const value = message.value?.trim() || "";
      if (kind === "owner" && !/^[A-Za-z0-9-]+$/.test(value)) {
        this.post({ type: "savedQueueError", message: vscode.l10n.t("Enter an organization or user login.") });
        return;
      }
      if (kind === "team" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
        this.post({ type: "savedQueueError", message: vscode.l10n.t("Enter a team as organization/team.") });
        return;
      }
      this.managementScope = kind === "owner" ? { kind, owner: value } : kind === "team" ? { kind, team: value } : { kind: "repository" };
      await this.refresh("managementScopeSelected");
      return;
    }
    if (message.type === "createSavedQueue") {
      await this.createSavedQueue(message.name, message.query);
      return;
    }
    if (message.type === "updateSavedQueue") {
      await this.updateSavedQueue(message.id, message.name, message.query);
      return;
    }
    if (message.type === "moveSavedQueue") {
      await this.moveSavedQueue(message.id, message.direction);
      return;
    }
    if (message.type === "deleteSavedQueue") {
      await this.deleteSavedQueue(message.id);
      return;
    }
    if (message.type === "previewBulkManagement") {
      await this.previewBulkManagement(message.keys, message.kind, message.values);
      return;
    }
    if (message.type === "applyBulkManagement") {
      await this.applyBulkManagement(message.previewId);
      return;
    }
    if (message.type === "retryFailedBulkManagement") {
      await this.retryFailedBulkManagement();
      return;
    }
    if (message.type === "cancelBulkManagement" && this.bulkPreview?.id === message.previewId) {
      if (this.bulkController) {
        this.bulkController.abort();
        logInfo("review queue bulk management cancellation requested", { previewId: message.previewId });
      } else {
        this.bulkPreview = undefined;
      }
    }
  }

  /** 현재 snapshot의 다음 cursor page를 lane별로 직렬 읽고 stale refresh 뒤 결과를 버린다. */
  private async loadMoreQueue(lane: ReviewQueueLane): Promise<void> {
    const snapshot = this.snapshot;
    const root = this.resolveRepositoryRoot();
    const cursor = snapshot?.nextCursors?.[lane];
    if (!snapshot || !root || !cursor || this.pageControllers.has(lane)) return;
    const controller = new AbortController();
    this.pageControllers.set(lane, controller);
    try {
      const result = await new PullRequestReviewQueueService(root).getNextPage(snapshot.repository, lane, cursor, {
        signal: controller.signal,
        managementQuery: this.activeSavedQueue?.query,
        managementScope: this.managementScope,
      });
      if (this.snapshot !== snapshot || this.pageControllers.get(lane) !== controller) return;
      const next = mergeReviewQueuePage(snapshot, lane, result.pullRequests, result.nextCursor);
      this.snapshot = next;
      this.post({ type: "queuePageLoaded", lane, snapshot: next });
      logInfo("review queue page loaded", { lane, count: result.pullRequests.length, hasMore: result.truncated });
    } catch (error) {
      if (this.snapshot === snapshot && this.pageControllers.get(lane) === controller && !isAbortError(error)) {
        logError("review queue page failed", error, { lane });
        this.post({ type: "queuePageError", lane, message: reviewQueueErrorPresentation(error).message });
      }
    } finally {
      if (this.pageControllers.get(lane) === controller) this.pageControllers.delete(lane);
    }
  }

  /** local saved queue 선택을 현재 viewer/repository 목록에서 확인한 뒤 Management 검색을 다시 실행한다. */
  private async selectSavedQueue(id?: string): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const queue = id ? this.savedQueues.load(snapshot.repository, snapshot.viewer).find((item) => item.id === id) : undefined;
    if (id && !queue) {
      this.post({ type: "savedQueueError", message: vscode.l10n.t("The selected saved review queue is no longer available.") });
      return;
    }
    this.activeSavedQueue = queue;
    await this.refresh("savedQueueSelected");
  }

  /** name/query가 검증된 local definition을 만들고 곧바로 선택해 실제 Management 검색에 적용한다. */
  private async createSavedQueue(name: string, query: string): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    try {
      this.activeSavedQueue = await this.savedQueues.create(snapshot.repository, snapshot.viewer, name, query);
      logInfo("review saved queue created", { repository: snapshot.repository, name: this.activeSavedQueue.name });
      await this.refresh("savedQueueCreated");
    } catch (error) {
      this.post({ type: "savedQueueError", message: reviewQueueErrorPresentation(error).message });
    }
  }

  /** 선택한 queue의 definition을 갱신하고 활성 검색도 같은 조건으로 다시 읽는다. */
  private async updateSavedQueue(id: string, name: string, query: string): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot || !id.trim()) return;
    try {
      const updated = await this.savedQueues.update(snapshot.repository, snapshot.viewer, id, name, query);
      if (!updated) {
        this.post({ type: "savedQueueError", message: vscode.l10n.t("The selected saved review queue is no longer available.") });
        return;
      }
      if (this.activeSavedQueue?.id === id) this.activeSavedQueue = updated;
      logInfo("review saved queue updated", { repository: snapshot.repository, id });
      await this.refresh("savedQueueUpdated");
    } catch (error) {
      this.post({ type: "savedQueueError", message: reviewQueueErrorPresentation(error).message });
    }
  }

  /** 저장한 queue의 표시 순서를 한 칸 이동하고 선택/검색 조건은 바꾸지 않는다. */
  private async moveSavedQueue(id: string, direction: "up" | "down"): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot || !id.trim()) return;
    try {
      const moved = await this.savedQueues.move(snapshot.repository, snapshot.viewer, id, direction);
      if (!moved) return;
      logInfo("review saved queue moved", { repository: snapshot.repository, id, direction });
      const queues = this.savedQueues.load(snapshot.repository, snapshot.viewer);
      this.post({ type: "savedQueues", queues, activeId: this.activeSavedQueue?.id });
    } catch (error) {
      this.post({ type: "savedQueueError", message: reviewQueueErrorPresentation(error).message });
    }
  }

  /** 사용자가 확정한 local queue만 지우고 선택 중이었다면 기본 Management 검색으로 되돌린다. */
  private async deleteSavedQueue(id: string): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot || !id.trim()) return;
    try {
      const removed = await this.savedQueues.remove(snapshot.repository, snapshot.viewer, id);
      if (!removed) return;
      if (this.activeSavedQueue?.id === id) this.activeSavedQueue = undefined;
      logInfo("review saved queue deleted", { repository: snapshot.repository, id });
      await this.refresh("savedQueueDeleted");
    } catch (error) {
      this.post({ type: "savedQueueError", message: reviewQueueErrorPresentation(error).message });
    }
  }

  /** 선택한 Management PR을 authoritative read로 preview해 실제 write/skip 수를 먼저 보여 준다. */
  private async previewBulkManagement(
    keys: readonly string[],
    kind: Extract<ReviewsWebviewMessage, { type: "previewBulkManagement" }>["kind"],
    values: string[]
  ): Promise<void> {
    const snapshot = this.snapshot;
    const root = this.resolveRepositoryRoot();
    const targets = snapshot ? selectedReviewQueueBulkTargets(snapshot, keys) : [];
    if (!snapshot || !root || !targets.length) {
      this.post({ type: "bulkManagementError", message: vscode.l10n.t("Select at least one pull request before previewing bulk changes.") });
      return;
    }
    if (kind === "setDraft" || kind === "setReady") {
      this.post({ type: "bulkManagementError", message: vscode.l10n.t("Bulk draft state changes are unavailable because this queue does not load pull request node ids.") });
      return;
    }
    this.bulkController?.abort();
    this.bulkRetry = undefined;
    this.bulkResult = undefined;
    const controller = new AbortController();
    this.bulkController = controller;
    try {
      const mutation = managementMutationFromInput(kind, values);
      const preview = await new PullRequestManagementBulkService(new PullRequestManagementService(root)).preview(targets, mutation, controller.signal);
      if (this.bulkController !== controller || controller.signal.aborted) return;
      const previewId = `bulk-${++this.bulkPreviewSequence}`;
      this.bulkPreview = { id: previewId, preview };
      this.post({ type: "bulkManagementPreview", previewId, preview });
      logInfo("review queue bulk management preview completed", { repository: snapshot.repository, targets: preview.items.length, eligible: preview.eligibleCount });
    } catch (error) {
      if (!isAbortError(error) && this.bulkController === controller) {
        logError("review queue bulk management preview failed", error, { repository: snapshot.repository, targets: targets.length });
        this.post({ type: "bulkManagementError", message: reviewQueueErrorPresentation(error).message });
      }
    } finally {
      if (this.bulkController === controller) this.bulkController = undefined;
    }
  }

  /** 사용자가 확인한 preview만 제한 동시성 scheduler로 실행하고 summary 뒤 queue를 재조회한다. */
  private async applyBulkManagement(previewId: string): Promise<void> {
    const pending = this.bulkPreview;
    const root = this.resolveRepositoryRoot();
    if (!pending || pending.id !== previewId || !root || this.bulkController) return;
    if (!pending.preview.eligibleCount) {
      this.post({ type: "bulkManagementError", message: vscode.l10n.t("No selected pull requests need this metadata change.") });
      return;
    }
    const controller = new AbortController();
    this.bulkController = controller;
    try {
      const summary = await new PullRequestManagementBulkService(new PullRequestManagementService(root)).execute(pending.preview, controller.signal);
      if (this.bulkController !== controller) return;
      this.bulkPreview = undefined;
      const mutation = pending.preview.items.find((item) => item.preview)?.preview?.mutation;
      const targets = summary.items.filter((item) => item.status === "failed").map((item) => item.target);
      this.bulkRetry = mutation && targets.length ? { targets, mutation } : undefined;
      this.bulkResult = { summary, retryableCount: this.bulkRetry?.targets.length || 0 };
      this.post({ type: "bulkManagementResult", ...this.bulkResult });
      logInfo("review queue bulk management completed", {
        applied: summary.appliedCount,
        skipped: summary.skippedCount,
        failed: summary.failedCount,
        cancelled: summary.cancelledCount,
        partiallyVerified: summary.partiallyVerifiedCount,
        retryable: this.bulkRetry?.targets.length || 0,
      });
      await this.refresh("bulkManagementApplied");
    } catch (error) {
      if (!isAbortError(error) && this.bulkController === controller) {
        logError("review queue bulk management failed", error, { previewId });
        this.post({ type: "bulkManagementError", message: reviewQueueErrorPresentation(error).message });
      }
    } finally {
      if (this.bulkController === controller) this.bulkController = undefined;
    }
  }

  /** 직전 bulk write에서 실패한 PR만 최신 metadata를 다시 읽어 새 preview로 복구한다. */
  private async retryFailedBulkManagement(): Promise<void> {
    const retry = this.bulkRetry;
    const root = this.resolveRepositoryRoot();
    if (!retry || !root || this.bulkController) return;
    this.bulkResult = undefined;
    const controller = new AbortController();
    this.bulkController = controller;
    try {
      const preview = await new PullRequestManagementBulkService(new PullRequestManagementService(root)).preview(retry.targets, retry.mutation, controller.signal);
      if (this.bulkController !== controller || controller.signal.aborted) return;
      const previewId = `bulk-${++this.bulkPreviewSequence}`;
      this.bulkPreview = { id: previewId, preview };
      this.post({ type: "bulkManagementPreview", previewId, preview });
      logInfo("review queue bulk management retry preview completed", { targets: preview.items.length, eligible: preview.eligibleCount });
    } catch (error) {
      if (!isAbortError(error) && this.bulkController === controller) {
        logError("review queue bulk management retry preview failed", error, { targets: retry.targets.length });
        this.post({ type: "bulkManagementError", message: reviewQueueErrorPresentation(error).message });
      }
    } finally {
      if (this.bulkController === controller) this.bulkController = undefined;
    }
  }

  /** 사용자가 명시적으로 눌렀을 때만 별도 터미널에서 gh 인증 흐름을 시작한다. */
  private startGitHubAuth(): void {
    const terminal = vscode.window.createTerminal("GitHub CLI Authentication");
    terminal.show(true);
    terminal.sendText("gh auth login", true);
    logInfo("review queue GitHub authentication requested");
  }

  /** 현재 editor가 속한 workspace 폴더를 우선해 gh 실행 경로를 정한다. */
  private resolveRepositoryRoot(): string | undefined {
    const active = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    return activeFolder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** 더 최신 refresh가 시작되거나 view가 사라졌을 때 read 요청만 중단한다.
   *  bulk write는 sidebar 가시성과 독립적으로 끝까지 실행해 결과를 다시 열었을 때 복원한다. */
  private cancelRefresh(reason: string): void {
    if (this.refreshController && !this.refreshController.signal.aborted) {
      logInfo("review queue refresh cancelled", { reason, requestId: this.requestId });
      this.refreshController.abort();
    }
    this.refreshController = undefined;
    this.pageControllers.forEach((controller) => controller.abort());
    this.pageControllers.clear();
  }

  /** 취소된 이전 요청이 최신 화면 상태를 덮지 못하도록 fence를 확인한다. */
  private isCurrentRequest(requestId: number, controller: AbortController): boolean {
    return this.view?.visible === true
      && this.requestId === requestId
      && this.refreshController === controller;
  }

  /** webview가 살아 있을 때만 상태 메시지를 전송한다. */
  private post(message: ReviewsRenderMessage): void {
    void this.view?.webview.postMessage(message);
  }
}

/** GitHub CLI 취소 오류를 사용자 경고가 아닌 정상적인 stale 요청으로 분류한다. */
function isAbortError(error: unknown): boolean {
  return isReviewQueueAbort(error);
}
