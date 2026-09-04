// git 그래프를 보여주는 웹뷰 패널을 관리하는 모듈.
// - 패널 생애주기(생성/표시/해제)와 웹뷰↔확장 메시지 라우팅만 담당한다.
//   그래프 계산은 graphLayout, git 접근은 GitLogService 에 위임한다(경계 분리).
import * as vscode from "vscode";
import { GitLogService } from "../git/gitLogService";
import { graphRemoteRefVersion, readGraphRefreshFingerprint } from "../git/graphRefreshFingerprint";
import type { GraphRemoteBranchTip } from "../git/graphBranchCatalog";
import { Commit, GraphInvalidRef, LocalBranchStatus } from "../graph/graphTypes";
import { logError, logInfo } from "../ui/outputLog";
import { filterCommitRefs, normalizeBranchFilterState, shouldShowVirtualCommits } from "./graphBranchFilter";
import type { GraphBranchFilterState, GraphBranchRef, ResolvedGraphBranchFilter } from "./graphBranchFilter";
import { createGraphRefreshErrorNotice, publishInvalidGraphRefs } from "./graphHealth";
import { buildGraphHtml } from "./graphHtml";
import { FromWebviewMessage, GraphLoadDirection, GraphLoadState, ToWebviewMessage } from "./graphProtocol";
import { GraphPanelMessageRouter } from "./graphPanelMessageRouter";
import { sendGraphTagStatus } from "./graphTagStatus";
import { readGraphWorktreeBranchStatus } from "./graphWorktrees";
import { syncGraphLocalRefs } from "./graphLocalRefs";
import { createGraphBranchFilterSnapshot, GraphBranchLoadingCoordinator, GraphRemoteCatalogStatus, isCurrentGraphLoad, loadGraphLocalBranchData, mergeGraphBranchRefs, refreshGraphCheckout, resolveGraphBranchFilter } from "./graphBranchLoading";
import { beginGraphPerformanceTrace, GraphPerformanceTrace, logGraphPerformancePhase } from "./graphPerformance";
import { loadFilteredGraphCommitWindow, loadReflogGraphWindow } from "./graphCommitWindowLoading";
import { postGraphWebviewMessage, publishGraphRender } from "./graphPanelRendering";
import { GraphRefreshContext, GraphRefreshLifecycleCoordinator, GraphRefreshMode } from "./graphRefreshCoordinator";
/** 그래프 무한 스크롤에서 한 번에 읽을 커밋 수. 히스토리 끝까지 반복 로드한다. */
const GRAPH_PAGE_SIZE = 300;
/**
 * git 그래프 웹뷰 패널. 동시에 하나만 유지한다(있으면 재사용).
 */
export class GitGraphPanel {
  private static current: GitGraphPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private commits: Commit[] = [];
  private virtualCommits: Commit[] = [];
  private disposed = false;
  private loading = false;
  private exhausted = false;
  private rangeStartIndex = 0;
  private rangeTotalCount: number | undefined;
  private loadGeneration = 0;
  private branchFilter: GraphBranchFilterState = { mode: "all", selected: [], compact: true };
  private lastLocalBranches: LocalBranchStatus[] = [];
  private invalidLocalRefs: GraphInvalidRef[] = [];
  private lastBranchRefs: GraphBranchRef[] = [];
  private lastRemoteTips: GraphRemoteBranchTip[] = [];
  private remoteCatalogStatus: GraphRemoteCatalogStatus = "ready";
  private remoteCatalogError: string | undefined;
  private readonly branchLoading = new GraphBranchLoadingCoordinator();
  private activePerformance: GraphPerformanceTrace | undefined;
  private readonly refreshCoordinator: GraphRefreshLifecycleCoordinator;
  private readonly messages: GraphPanelMessageRouter;
  /**
   * 패널을 만들거나, 이미 있으면 앞으로 가져온다.
   * - 대상 저장소(logService)가 바뀌면 새 데이터를 다시 로드한다.
   * @param extensionUri 확장 루트 URI(미디어 리소스 경로 계산용)
   * @param logService   대상 저장소의 로그 서비스
   */
  static createOrShow(extensionUri: vscode.Uri, logService: GitLogService): void {
    if (GitGraphPanel.current) {
      GitGraphPanel.current.messages.cancelPullRequestLoading("repositoryChanged");
      GitGraphPanel.current.branchLoading.cancel("repositoryChanged");
      GitGraphPanel.current.logService.cancelGraphBranchContainment("repositoryChanged");
      GitGraphPanel.current.logService = logService;
      GitGraphPanel.current.lastRemoteTips = [];
      GitGraphPanel.current.refreshCoordinator.setRepository(logService.repoRoot);
      GitGraphPanel.current.panel.reveal();
      void GitGraphPanel.current.reloadRepository();
      return;
    }
    const panel = vscode.window.createWebviewPanel("gitSimpleCompare.graph", vscode.l10n.t("Git Graph"), vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    GitGraphPanel.current = new GitGraphPanel(panel, extensionUri, logService);
  }
  /**
   * 현재 열린 Graph가 표시하는 저장소 root를 Git 조회 없이 반환한다.
   * - refresh routing 전용 read-only accessor이며 panel 상태나 log cache를 변경하지 않는다.
   * @returns 열린 Graph의 정확한 repository root, 패널이 없으면 undefined
   */
  static getOpenRepositoryRoot(): string | undefined {
    return GitGraphPanel.current?.logService.repoRoot;
  }
  /**
   * 이미 열린 그래프 패널이 같은 저장소를 보고 있으면 최신 상태를 즉시 다시 읽는다.
   * @param repoRoot 변경이 발생한 저장소 루트
   * @param reason   OUTPUT 로그에 남길 새로고침 원인
   * @returns 열린 그래프 패널에 새로고침을 요청했으면 true
   */
  static refreshOpen(repoRoot: string, reason: string): boolean {
    const current = GitGraphPanel.current;
    if (!current || current.logService.repoRoot !== repoRoot) {
      return false;
    }
    void current.requestExternalRefresh(repoRoot, reason);
    return true;
  }
  /**
   * 이미 열린 그래프 패널이 같은 저장소를 보고 있으면 웹뷰 메시지를 보낸다.
   * @param repoRoot 대상 저장소 루트
   * @param message 웹뷰에 보낼 메시지
   * @returns 메시지를 보냈으면 true
   */
  static postOpen(repoRoot: string, message: ToWebviewMessage): boolean {
    const current = GitGraphPanel.current;
    if (!current || current.logService.repoRoot !== repoRoot) {
      return false;
    }
    current.post(message);
    return true;
  }
  private constructor(private readonly panel: vscode.WebviewPanel, private readonly extensionUri: vscode.Uri, private logService: GitLogService) {
    this.messages = new GraphPanelMessageRouter({
      logService: () => this.logService,
      localBranches: () => this.lastLocalBranches,
      extensionUri: this.extensionUri,
      post: (message) => this.post(message),
      withBusy: (key, action) => this.withBusy(key, action),
      reloadGraph: (cause) => this.runDirectGraph(cause),
      setBranchFilter: (message) => this.setBranchFilter(message),
      loadNextPage: (reset, direction) => this.loadNextPage(reset, direction),
      loadedCommitHash: (hashes) => hashes
        .map((hash) => hash.trim())
        .find((hash) => this.commits.some((commit) => commit.hash === hash)),
      loadCommitWindow: (hashes) => this.loadCommitWindow(hashes),
      loadReflogCommitWindow: (hash) => this.loadReflogCommitWindow(hash),
      refreshAfterGraphAction: () => this.refreshAfterGraphAction(),
      refreshAfterFetchAction: () => this.refreshAfterFetchAction(),
      refreshAfterCheckoutAction: () => this.refreshAfterCheckoutAction(),
    });
    this.refreshCoordinator = new GraphRefreshLifecycleCoordinator({
      readFingerprint: readGraphRefreshFingerprint,
      reloadGraph: async (context) => {
        this.resetLoadedGraph();
        await this.reloadGraph(context);
      },
      publishAfterReload: async (context, mode) => {
        if (mode === "pullRequests") await this.messages.refreshPullRequests(context.cause);
        else if (mode === "stacks") await this.messages.sendPullRequestStacks();
      },
      invalidateReload: (reason) => this.invalidateRefreshWork(reason),
      info: (event, fields) => logInfo(event, fields),
      error: (event, error, fields) => {
        logError(event, error, fields);
        const hasExistingGraph = this.commits.length > 0;
        this.loading = false;
        if (!hasExistingGraph) this.exhausted = true;
        this.post({ type: "graphHealth", notice: createGraphRefreshErrorNotice(error, hasExistingGraph) });
        this.postLoadState(false);
      },
    });
    this.refreshCoordinator.setRepository(this.logService.repoRoot);
    this.panel.webview.html = buildGraphHtml(panel, extensionUri);
    // 웹뷰에서 오는 메시지 처리
    this.panel.webview.onDidReceiveMessage(
      (msg: FromWebviewMessage) => this.messages.handle(msg),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.onDidChangeViewState((event) => this.handleViewStateChange(event), undefined, this.disposables);
    vscode.window.onDidChangeWindowState((state) => this.handleWindowFocusChange(state.focused), undefined, this.disposables);
  }
  /** 패널과 리스너를 정리한다. */
  private dispose(): void {
    this.disposed = true;
    this.refreshCoordinator.dispose();
    this.messages.cancelPullRequestLoading("dispose");
    this.branchLoading.cancel("dispose"); this.logService.cancelGraphBranchContainment("dispose");
    GitGraphPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
  /** 숨김/표시 전환을 lifecycle coordinator와 remote branch 작업에 함께 반영한다. */
  private handleViewStateChange(event: vscode.WebviewPanelOnDidChangeViewStateEvent): void {
    if (!event.webviewPanel.visible) {
      this.refreshCoordinator.setVisible(false);
      return;
    }
    const resumedRefresh = this.refreshCoordinator.setVisible(true);
    if (!resumedRefresh && this.remoteCatalogStatus === "pending" && vscode.window.state.focused) this.resumeBranchLoading();
  }
  /** 창 포커스가 빠지면 원격 read를 중단하고 복귀 시 local-first 세대를 다시 연다. */
  private handleWindowFocusChange(focused: boolean): void {
    const resumedRefresh = this.refreshCoordinator.setFocused(focused);
    if (!focused) return;
    if (!resumedRefresh && this.panel.visible && this.remoteCatalogStatus === "pending") this.resumeBranchLoading();
  }
  /** hide/focus 취소 뒤 fingerprint를 다시 확인하는 direct lifecycle로 안전하게 재개한다. */
  private resumeBranchLoading(): void { void this.runDirectGraph("ready"); }
  /** watcher 원인을 의미 fingerprint와 함께 lifecycle coordinator에 전달한다. */
  private async requestExternalRefresh(repoRoot: string, reason: string): Promise<void> {
    // stack mutation만 PR 첫 페이지 refresh로 승격한다.
    const mode: GraphRefreshMode = reason === "stackSubmitted" || reason === "stackAdvanced" ? "pullRequests" : "stacks";
    await this.refreshCoordinator.request({ repoRoot, cause: reason, mode });
  }
  /** ready/manual 요청은 한 번의 직접 Graph reload와 fingerprint baseline을 완료할 때까지 기다린다. */
  private async runDirectGraph(cause: string): Promise<boolean> {
    return this.refreshCoordinator.runDirect({ repoRoot: this.logService.repoRoot, cause });
  }
  /** 저장소 교체도 직접 baseline을 확정한 뒤 local stack과 비차단 PR hydration을 같은 순서로 복원한다. */
  private async reloadRepository(): Promise<void> {
    if (!await this.runDirectGraph("ready") || this.disposed) return;
    await this.messages.sendPullRequestStacks();
    void this.messages.refreshPullRequests("ready");
  }
  /** lifecycle 취소 시 PR/branch/Git containment의 늦은 결과를 같은 이유로 무효화한다. */
  private invalidateRefreshWork(reason: string): void {
    this.resetLoadedGraph();
    this.messages.cancelPullRequestLoading(reason);
    this.branchLoading.cancel(reason);
    this.logService.cancelGraphBranchContainment(reason);
    logInfo("graph refresh lifecycle invalidated", { repoRoot: this.logService.repoRoot, reason });
  }
  /** branch filter 메시지를 패널 소유 상태에 반영한 뒤 첫 페이지를 다시 읽는다. */
  private async setBranchFilter(message: Extract<FromWebviewMessage, { type: "setBranchFilter" }>): Promise<void> {
    this.branchFilter = normalizeBranchFilterState(message.mode, message.branches ?? [], message.compact ?? this.branchFilter.compact);
    logInfo("graph branch filter changed", {
      repoRoot: this.logService.repoRoot,
      mode: this.branchFilter.mode,
      selectedCount: this.branchFilter.selected.length,
    });
    this.resetLoadedGraph();
    if (this.remoteCatalogStatus === "ready") {
      this.logService.seedGraphBranchTips(this.lastLocalBranches, this.lastRemoteTips);
    } else {
      this.logService.seedGraphBranchTips(this.lastLocalBranches);
      this.logService.markGraphRemoteBranchesUnavailable();
    }
    const trace = beginGraphPerformanceTrace(this.logService.repoRoot, "branchFilter", this.loadGeneration);
    this.activePerformance = trace;
    await this.loadNextPage(true, "older", trace);
  }
  /** git graph action 이후 그래프와 Changes 뷰를 다시 읽는다. */
  private async refreshAfterGraphAction(): Promise<void> {
    await this.runDirectGraph("graphAction");
    void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason: "graphAction",
    });
  }
  /** 검색에서 명시적으로 fetch 한 뒤 그래프만 최신 ref 기준으로 다시 읽는다. */
  private async refreshAfterFetchAction(): Promise<void> {
    await this.runDirectGraph("fetch");
  }
  /** checkout 이후에는 기존 graph 페이지를 재사용해 HEAD/가상 노드만 빠르게 갱신한다. */
  private async refreshAfterCheckoutAction(): Promise<void> {
    const trace = beginGraphPerformanceTrace(this.logService.repoRoot, "checkout", this.loadGeneration);
    this.activePerformance = trace;
    const branches = await this.sendBranches(this.loadGeneration, trace);
    const refreshed = await refreshGraphCheckout(this.logService.repoRoot, this.commits, branches, this.currentBranchFilter().visibleRefs, syncGraphLocalRefs, () => this.logService.getVirtualCommits());
    if (!refreshed.reused) {
      await this.runDirectGraph("checkout");
      return;
    }
    this.virtualCommits = refreshed.virtualCommits;
    await this.logService.reindexGraphBranchContainment(this.commits, this.rangeStartIndex, this.currentBranchFilter().refs);
    this.postGraph(false, "older", trace, "checkout");
    void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason: "graphCheckout",
    });
  }
  /** 로컬 상태를 먼저 보내고 remote catalog까지 확정한 뒤 최종 첫 페이지를 정확히 한 번 읽는다. */
  private async reloadGraph(context: GraphRefreshContext): Promise<void> {
    const graphGeneration = this.loadGeneration;
    const repoRoot = this.logService.repoRoot, generation = this.branchLoading.begin(repoRoot);
    const trace = beginGraphPerformanceTrace(repoRoot, context.cause, graphGeneration);
    this.activePerformance = trace;
    this.invalidLocalRefs = [];
    this.post({ type: "graphHealth" });
    this.remoteCatalogStatus = "pending"; this.remoteCatalogError = undefined;
    const remoteStarted = Date.now();
    const remoteRead = this.branchLoading.loadRemote(
      repoRoot,
      generation,
      graphRemoteRefVersion(context.fingerprint),
      () => this.panel.visible && vscode.window.state.focused
    );
    await this.sendBranches(graphGeneration, trace);
    if (!this.isGraphGenerationActive(graphGeneration)) return;
    const remote = await remoteRead;
    logGraphPerformancePhase(trace, "remoteBranches", Date.now() - remoteStarted, {
      status: remote?.status ?? "cancelled",
      count: remote?.status === "ready" ? remote.branches.length : 0,
    });
    if (!remote || !this.isGraphGenerationActive(graphGeneration)) return;
    if (remote.status === "ready") {
      this.lastRemoteTips = remote.branches;
      this.lastBranchRefs = mergeGraphBranchRefs(this.lastBranchRefs, remote.branches);
      this.remoteCatalogStatus = "ready";
      this.logService.seedGraphBranchTips(this.lastLocalBranches, remote.branches);
    } else {
      this.lastRemoteTips = [];
      this.remoteCatalogStatus = "error";
      this.remoteCatalogError = remote.error instanceof Error ? remote.error.message : String(remote.error);
      this.logService.markGraphRemoteBranchesUnavailable();
    }
    this.postBranchFilterOptions();
    await this.loadNextPage(true, "older", trace);
    if (!this.isGraphGenerationActive(graphGeneration)) return;
    void sendGraphTagStatus(repoRoot, (message) => {
      if (this.isGraphGenerationActive(graphGeneration)) this.post(message);
    }, { forceRemote: context.cause === "refresh" });
  }
  /** 로컬 브랜치 현황을 읽어 웹뷰의 그래프 ref 배지 렌더러로 보낸다. */
  private async sendBranches(
    expectedGeneration = this.loadGeneration,
    trace: GraphPerformanceTrace | undefined = this.activePerformance
  ): Promise<LocalBranchStatus[]> {
    const { branches, refs: branchRefs, worktrees, invalidRefs, timings } = await loadGraphLocalBranchData(
      this.logService.repoRoot,
      () => this.logService.getLocalBranchSnapshot(),
      () => readGraphWorktreeBranchStatus(this.logService.repoRoot)
    );
    if (!this.isGraphGenerationActive(expectedGeneration)) return [];
    this.lastLocalBranches = branches;
    this.invalidLocalRefs = invalidRefs;
    this.logService.seedGraphBranchTips(branches);
    this.lastBranchRefs = this.remoteCatalogStatus === "ready" ? mergeGraphBranchRefs(branchRefs, this.lastBranchRefs.filter((branch) => branch.kind === "remote")) : branchRefs;
    this.post({ type: "branchStatus", branches, worktrees });
    this.postBranchFilterOptions();
    publishInvalidGraphRefs(this.logService.repoRoot, invalidRefs, (message) => this.post(message));
    logGraphPerformancePhase(trace, "localBranches", timings.localBranchesMs, { count: branches.length });
    logGraphPerformancePhase(trace, "worktrees", timings.worktreesMs, { count: worktrees.length });
    logGraphPerformancePhase(trace, "branchSnapshot", timings.totalMs);
    logInfo("graph branch status sent", {
      repoRoot: this.logService.repoRoot,
      branches: branches.length,
      worktrees: worktrees.length,
      current: branches.find((branch) => branch.current)?.name,
      filterMode: this.branchFilter.mode,
    });
    return branches;
  }
  /**
   * 다음 커밋 페이지를 읽어 누적 목록에 붙이고, 현재까지의 그래프를 웹뷰로 보낸다.
   * - git log 는 skip/limit 으로 필요한 페이지만 읽고, 전체 누적 커밋으로 레이아웃을 보정한다.
   * @param reset true 면 첫 페이지 로드로 간주해 웹뷰 선택/스크롤 상태를 초기화한다.
   * @param direction older/newer 중 어느 쪽으로 페이지를 확장할지 지정한다.
   */
  private async loadNextPage(
    reset: boolean,
    direction: GraphLoadDirection = "older",
    trace?: GraphPerformanceTrace
  ): Promise<void> {
    const pageService = this.logService;
    if (this.loading) {
      logInfo("graph page load skipped", {
        reason: "alreadyLoading",
        direction,
        loadedCount: this.commits.length,
      });
      this.postLoadState(reset, direction);
      return;
    }
    if (!reset && direction === "newer" && this.rangeStartIndex <= 0) {
      logInfo("graph page load skipped", {
        reason: "noNewerCommits",
        loadedCount: this.commits.length,
        rangeStartIndex: this.rangeStartIndex,
      });
      this.postLoadState(reset, direction);
      return;
    }
    if (!reset && direction === "older" && this.exhausted) {
      logInfo("graph page load skipped", {
        reason: "noMoreCommits",
        direction,
        loadedCount: this.commits.length,
      });
      this.postLoadState(reset, direction);
      return;
    }
    const generation = this.loadGeneration, started = Date.now();
    const performanceTrace = trace ?? beginGraphPerformanceTrace(
      this.logService.repoRoot,
      reset ? "reload" : `pagination:${direction}`,
      generation
    );
    const pageLimit = GRAPH_PAGE_SIZE, branchFilter = this.currentBranchFilter();
    if (branchFilter.empty) {
      this.virtualCommits = [];
      this.exhausted = true;
      this.rangeStartIndex = 0;
      this.rangeTotalCount = 0;
      this.postGraph(reset, direction, performanceTrace, "initial", []);
      return;
    }
    if (reset) {
      this.rangeStartIndex = 0;
      this.rangeTotalCount = undefined;
      this.exhausted = false;
      direction = "older";
    }
    const prependCount = Math.min(pageLimit, this.rangeStartIndex);
    const skip = direction === "newer"
      ? this.rangeStartIndex - prependCount
      : this.rangeStartIndex + this.commits.length;
    const readLimit = direction === "newer" ? prependCount : pageLimit + 1;
    if (readLimit <= 0) {
      this.postLoadState(reset, direction);
      return;
    }
    this.loading = true;
    this.postLoadState(reset, direction);
    logInfo("graph page load started", {
      repoRoot: this.logService.repoRoot,
      direction,
      skip,
      limit: readLimit,
      filterMode: branchFilter.mode,
      refCount: branchFilter.refs.length,
    });
    let postedGraph = false;
    try {
      if (reset) {
        const virtualStarted = Date.now();
        this.virtualCommits = shouldShowVirtualCommits(
          branchFilter,
          this.lastLocalBranches
        )
          ? await pageService.getVirtualCommits()
          : [];
        logGraphPerformancePhase(performanceTrace, "status", Date.now() - virtualStarted, {
          virtualCommits: this.virtualCommits.length,
        });
      }
      const logStarted = Date.now();
      const page = await pageService.getCommitPage(
        readLimit,
        skip,
        branchFilter.refs,
        false
      );
      logGraphPerformancePhase(performanceTrace, "gitLog", Date.now() - logStarted, {
        skip, limit: readLimit, fetchedCount: page.length, refCount: branchFilter.refs.length,
      });
      if (!this.isGraphGenerationActive(generation, pageService)) {
        pageService.cancelGraphBranchContainment("stalePage");
        logInfo("graph page load ignored", {
          reason: "staleGeneration",
          skip,
          limit: pageLimit,
        });
        return;
      }
      const pageCommits = direction === "older" ? page.slice(0, pageLimit) : page;
      const nextCommits = filterCommitRefs(pageCommits, branchFilter);
      if (direction === "newer") {
        this.commits.unshift(...nextCommits);
        this.rangeStartIndex = skip;
      } else {
        this.commits.push(...nextCommits);
        this.exhausted = page.length <= pageLimit;
        if (this.exhausted) {
          this.rangeTotalCount = this.rangeStartIndex + this.commits.length;
        }
      }
      if (this.rangeTotalCount !== undefined) {
        this.exhausted = this.rangeStartIndex + this.commits.length >= this.rangeTotalCount;
      }
      this.loading = false;
      this.postGraph(
        reset,
        direction,
        performanceTrace,
        reset ? "initial" : "pagination"
      );
      postedGraph = true;
      const localOnlyStarted = Date.now();
      void this.logService.attachLocalOnlyBranches(this.commits).then((changedCount) => {
        if (!this.isGraphGenerationActive(generation, pageService) || changedCount === 0) {
          return;
        }
        this.postGraph(false, direction, performanceTrace, "localOnly");
        logInfo("graph local-only markers sent", {
          repoRoot: this.logService.repoRoot,
          changedCount,
          loadedCount: this.commits.length,
          elapsed: Date.now() - localOnlyStarted,
        });
      }).catch((err) => logError("graph local-only markers failed", err, { repoRoot: this.logService.repoRoot }));
      logInfo("graph page load finished", {
        direction,
        fetchedCount: nextCommits.length,
        loadedCount: this.commits.length,
        rangeStartIndex: this.rangeStartIndex,
        hasMore: !this.exhausted,
        hasMoreBefore: this.rangeStartIndex > 0,
        elapsed: Date.now() - started,
      });
    } finally {
      if (!postedGraph && this.isGraphGenerationActive(generation, pageService)) {
        this.loading = false;
        this.postLoadState(reset, direction);
      }
    }
  }
  /** 특정 commit 후보 주변 window 를 새 graph 로 그려 오래된 PR 점프 때 중간 페이지 누적을 피한다. */
  private async loadCommitWindow(hashes: string[]): Promise<string | undefined> {
    const generation = ++this.loadGeneration;
    const trace = beginGraphPerformanceTrace(this.logService.repoRoot, "commitWindow", generation);
    this.loading = true;
    try {
      const window = await loadFilteredGraphCommitWindow(
        this.logService.repoRoot, hashes, this.currentBranchFilter(), GRAPH_PAGE_SIZE
      );
      if (generation !== this.loadGeneration || !window) return undefined;
      this.virtualCommits = []; this.commits = window.commits;
      this.rangeStartIndex = window.startIndex; this.rangeTotalCount = window.totalCount;
      this.loading = false;
      this.exhausted = this.rangeStartIndex + this.commits.length >= window.totalCount;
      this.postGraph(true, "older", trace, "window");
      logInfo("graph commit window sent", {
        repoRoot: this.logService.repoRoot, hash: window.hash, count: this.commits.length,
        rangeStartIndex: this.rangeStartIndex, totalCount: this.rangeTotalCount,
      });
      return window.hash;
    } finally {
      if (generation === this.loadGeneration && this.loading) this.loading = false;
    }
  }
  /**
   * reflog commit 을 현재 ref 필터와 무관한 복구용 graph window 로 표시한다.
   * @param hash reflog 항목이 가리키는 commit hash
   * @returns 그래프에 표시한 commit hash. Git 이 찾지 못하면 undefined
   */
  private async loadReflogCommitWindow(hash: string): Promise<string | undefined> {
    const generation = ++this.loadGeneration;
    const trace = beginGraphPerformanceTrace(this.logService.repoRoot, "reflogWindow", generation);
    this.loading = true;
    try {
      const window = await loadReflogGraphWindow(this.logService.repoRoot, hash, GRAPH_PAGE_SIZE);
      if (generation !== this.loadGeneration || !window) return undefined;
      this.virtualCommits = []; this.commits = window.commits; this.rangeStartIndex = 0;
      this.rangeTotalCount = window.commits.length;
      this.loading = false; this.exhausted = true;
      this.postGraph(true, "older", trace, "window");
      logInfo("graph reflog commit window sent", {
        repoRoot: this.logService.repoRoot, hash: window.hash, count: this.commits.length,
      });
      return window.hash;
    } finally {
      if (generation === this.loadGeneration && this.loading) this.loading = false;
    }
  }
  /** 현재 패널의 누적 커밋/종료 상태를 초기화하고 이전 비동기 로드 결과를 무효화한다. */
  private resetLoadedGraph(): void {
    this.logService.resetGraphBranchIndex();
    this.commits = []; this.virtualCommits = [];
    this.loading = false; this.exhausted = false;
    this.rangeStartIndex = 0; this.rangeTotalCount = undefined;
    this.loadGeneration++;
  }
  /** 비동기 local/page 결과가 현재 패널과 같은 Graph 세대인지 판정한다. */
  private isGraphGenerationActive(generation: number, service = this.logService): boolean { return isCurrentGraphLoad(service, this.logService, generation, this.loadGeneration, this.disposed); }
  /** 현재 브랜치 필터 상태를 git log 와 ref 표시 필터에 쓸 수 있는 형태로 변환한다. */
  private currentBranchFilter(): ResolvedGraphBranchFilter {
    return resolveGraphBranchFilter(this.branchFilter, this.lastBranchRefs, this.remoteCatalogStatus, this.invalidLocalRefs.length > 0);
  }
  /** 현재 remote hydration 상태를 포함한 filter snapshot을 웹뷰에 보낸다. */
  private postBranchFilterOptions(): void {
    this.post({
      type: "branchFilterOptions",
      filter: createGraphBranchFilterSnapshot(this.lastBranchRefs, this.lastLocalBranches, this.branchFilter,
        this.remoteCatalogStatus, this.remoteCatalogError, this.invalidLocalRefs.length > 0),
    });
  }
  /** Graph layout과 render trace를 게시한다. commits는 빈 필터처럼 현재 목록을 대체할 때만 전달한다. */
  private postGraph(reset: boolean, direction: GraphLoadDirection, trace: GraphPerformanceTrace | undefined,
    kind: "initial" | "pagination" | "localOnly" | "checkout" | "window", commits = this.commits): void {
    publishGraphRender({
      commits, virtualCommits: commits === this.commits ? this.virtualCommits : [],
      compact: this.branchFilter.compact, state: this.makeLoadState(reset, direction), trace, kind,
    }, (message) => this.post(message));
  }
  /** 웹뷰가 무한 스크롤을 갱신하도록 현재 count/loading/reset/direction 상태를 만든다. */
  private makeLoadState(reset: boolean, direction?: GraphLoadDirection): GraphLoadState {
    return {
      loadedCount: this.commits.length, hasMore: !this.exhausted,
      hasMoreBefore: this.rangeStartIndex > 0, loading: this.loading,
      loadDirection: direction, reset, colorScope: this.logService.repoRoot,
    };
  }
  /** commit 데이터가 같을 때 loading/reset/direction만 웹뷰로 보내 불필요한 DOM rebuild를 피한다. */
  private postLoadState(reset: boolean, direction?: GraphLoadDirection): void {
    this.post({ type: "graphLoadState", state: this.makeLoadState(reset && !this.loading, direction) });
  }
  /** 지정 toolbar key에 스피너를 켜고 fn의 성공/실패가 끝나면 반드시 원래 버튼 상태로 복원한다. */
  private async withBusy<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.post({ type: "graphBusy", key, busy: true });
    try { return await fn(); }
    finally { this.post({ type: "graphBusy", key, busy: false }); }
  }

  /** 타입이 보장된 메시지를 공통 transport/수락 계측 경계로 전송한다. */
  private post(message: ToWebviewMessage): void {
    postGraphWebviewMessage(this.panel.webview, this.logService.repoRoot, message);
  }
}
