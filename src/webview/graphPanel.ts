// git 그래프를 보여주는 웹뷰 패널을 관리하는 모듈.
// - 패널 생애주기(생성/표시/해제)와 웹뷰↔확장 메시지 라우팅만 담당한다.
//   그래프 계산은 graphLayout, git 접근은 GitLogService 에 위임한다(경계 분리).
import * as vscode from "vscode";
import { GitLogService } from "../git/gitLogService";
import { graphRemoteRefVersion, readGraphRefreshSnapshot } from "../git/graphRefreshFingerprint";
import type { GraphRemoteBranchTip } from "../git/graphBranchCatalog";
import { graphReferenceIdentity, matchesGraphReferenceIdentity, type GraphReferenceIdentity } from "../git/graphReferenceIdentity";
import { Commit, GraphInvalidRef, LocalBranchStatus } from "../graph/graphTypes";
import { logError, logInfo } from "../ui/outputLog";
import { normalizeBranchFilterState, shouldShowVirtualCommits } from "./graphBranchFilter";
import type { GraphBranchFilterState, GraphBranchRef, ResolvedGraphBranchFilter } from "./graphBranchFilter";
import { createGraphRefreshErrorNotice, publishInvalidGraphRefs } from "./graphHealth";
import { buildGraphHtml } from "./graphHtml";
import { FromWebviewMessage, GraphLoadDirection, GraphLoadState, ToWebviewMessage } from "./graphProtocol";
import { GraphPanelMessageRouter } from "./graphPanelMessageRouter";
import { sendGraphTagStatus } from "./graphTagStatus";
import { canReuseGraphSnapshot, syncGraphReferenceTips } from "./graphHistoryReuse";
import { canIncludeGraphBranchMetadata } from "../git/graphRefSnapshot";
import type { GraphActionRefreshKind } from "./graphActionRefresh";
import { completeGraphRemoteBranches, createGraphBranchFilterSnapshot, GraphBranchLoadingCoordinator, GraphRemoteCatalogStatus, isCurrentGraphLoad, readGraphLocalBranchData, mergeGraphBranchRefs, resolveGraphBranchFilter } from "./graphBranchLoading";
import { beginGraphPerformanceTrace, GraphPerformanceTrace, logGraphBranchSnapshot } from "./graphPerformance";
import { loadFilteredGraphCommitWindow, loadReflogGraphWindow } from "./graphCommitWindowLoading";
import { postGraphWebviewMessage, publishGraphRender, withGraphBusy } from "./graphPanelRendering";
import { GraphRenderCache } from "./graphRenderCache";
import { GraphRefreshContext, GraphRefreshLifecycleCoordinator, GraphRefreshMode, graphInvalidationPlan } from "./graphRefreshCoordinator";
import { GraphReadLifecycleCoordinator } from "./graphPageLoading";
import { executeGraphPageRequest } from "./graphPageRequest";
import { executeGraphWindowRequest } from "./graphWindowRequest";
import { GraphBranchDetailsLoading, readProgressiveGraphBranches } from "./graphBranchDetailsLoading";
import { GraphWorkingTreeLoading } from "./graphWorkingTreeLoading";
import { attachGraphLocalOnlyMarkers } from "./graphLocalOnlyLoading";
/** 그래프 무한 스크롤에서 한 번에 읽을 커밋 수. 히스토리 끝까지 반복 로드한다. */
const GRAPH_PAGE_SIZE = 300;
/** git 그래프 웹뷰 패널. 동시에 하나만 유지한다(있으면 재사용). */
export class GitGraphPanel {
  private static current: GitGraphPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private commits: Commit[] = [];
  private virtualCommits: Commit[] = [];
  private disposed = false;
  private readonly renderCache = new GraphRenderCache();
  private loading = false;
  private exhausted = false;
  private rangeStartIndex = 0;
  private rangeTotalCount: number | undefined;
  private loadGeneration = 0;
  private reconcilePageOrder = false;
  private branchFilter: GraphBranchFilterState = { mode: "all", selected: [], compact: true };
  private lastLocalBranches: LocalBranchStatus[] = [];
  private invalidLocalRefs: GraphInvalidRef[] = [];
  private lastBranchRefs: GraphBranchRef[] = [];
  private lastRemoteTips: GraphRemoteBranchTip[] = [];
  private remoteCatalogStatus: GraphRemoteCatalogStatus = "ready";
  private remoteCatalogError: string | undefined;
  private readonly branchLoading = new GraphBranchLoadingCoordinator();
  private readonly graphReads = new GraphReadLifecycleCoordinator();
  private readonly branchDetails = new GraphBranchDetailsLoading();
  private readonly workingTree = new GraphWorkingTreeLoading({
    service: () => this.logService, generation: () => this.loadGeneration, isAlive: () => !this.disposed,
    update: (commits, trace) => {
      this.virtualCommits = commits;
      if (!this.loading && this.rangeStartIndex === 0) this.postGraph(false, "newer", trace, "workingTree");
      else this.postLoadState(false);
    },
    changed: () => this.postLoadState(false),
  });
  private activePerformance: GraphPerformanceTrace | undefined;
  /** 숨김/포커스 해제로 첫 페이지 게시 전 reload 가 끊겼으면 복귀 때 다시 읽는다. */
  private resumeReloadOnFocus = false;
  private activeReloadGeneration: number | undefined;
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
  /** refresh routing에 필요한 Graph root만 Git/cache 변경 없이 반환한다. 패널이 없으면 undefined다. */
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
      withBusy: (key, action) => withGraphBusy(key, action, message => this.post(message)),
      reloadGraph: (cause) => this.runDirectGraph(cause),
      setBranchFilter: (message) => this.setBranchFilter(message),
      loadNextPage: (reset, direction) => this.loadNextPage(reset, direction),
      resyncGraph: () => { logInfo("graph transport resync", { repoRoot: this.logService.repoRoot }); this.renderCache.resetTransport(); this.postGraph(false, "older", undefined, "localOnly"); },
      loadedCommitHash: (hashes) => hashes
        .map((hash) => hash.trim())
        .find((hash) => this.commits.some((commit) => commit.hash === hash)),
      loadCommitWindow: (hashes) => this.loadCommitWindow(hashes),
      loadReflogCommitWindow: (hash) => this.loadReflogCommitWindow(hash),
      refreshAfterGraphAction: (kind) => this.refreshAfterGraphAction(kind),
      refreshAfterFetchAction: () => this.refreshAfterFetchAction(),
      refreshAfterCheckoutAction: () => this.refreshAfterCheckoutAction(),
    });
    this.refreshCoordinator = new GraphRefreshLifecycleCoordinator({
      readFingerprint: (repoRoot, signal, options) => readGraphRefreshSnapshot(repoRoot, undefined, signal, !!options?.includeLocalBranches && !this.invalidLocalRefs.length && canIncludeGraphBranchMetadata(this.lastLocalBranches, options.previousRefCount ?? this.lastBranchRefs.length)),
      reloadGraph: (context) => this.refreshGraphReferences(context),
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
        this.branchDetails.fail(error);
        if (!hasExistingGraph) this.exhausted = true;
        this.post({ type: "graphHealth", notice: createGraphRefreshErrorNotice(error, hasExistingGraph) });
        this.postLoadState(false);
      },
    });
    this.refreshCoordinator.setRepository(this.logService.repoRoot);
    this.refreshCoordinator.setFocused(vscode.window.state.focused);
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
    this.renderCache.clear();
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
    if (vscode.window.state.focused) this.messages.resumeDetailLoading();
    if (vscode.window.state.focused) void this.messages.synchronizeRebaseSession("panelVisible");
    if (!resumedRefresh && this.needsResumedReload() && vscode.window.state.focused) this.resumeBranchLoading();
    else if (vscode.window.state.focused) this.workingTree.resume(this.activePerformance);
  }
  /** 창 포커스가 빠지면 원격 read를 중단하고 복귀 시 local-first 세대를 다시 연다. */
  private handleWindowFocusChange(focused: boolean): void {
    const resumedRefresh = this.refreshCoordinator.setFocused(focused);
    if (!focused) return;
    if (this.panel.visible) this.messages.resumeDetailLoading();
    if (this.panel.visible) void this.messages.synchronizeRebaseSession("windowFocusedReconcile");
    if (!resumedRefresh && this.panel.visible && this.needsResumedReload()) this.resumeBranchLoading();
    else if (this.panel.visible) this.workingTree.resume(this.activePerformance);
  }
  /** remote catalog 대기 중이거나 reload 가 첫 게시 전에 끊겼으면 복귀 때 직접 reload 가 필요하다. */
  private needsResumedReload(): boolean { return this.remoteCatalogStatus === "pending" || this.resumeReloadOnFocus; }
  /** hide/focus 취소 뒤 fingerprint를 다시 확인하는 direct lifecycle로 안전하게 재개한다. */
  private resumeBranchLoading(): void { void this.runDirectGraph("ready"); }
  /** watcher 원인을 의미 fingerprint와 함께 lifecycle coordinator에 전달한다. */
  private async requestExternalRefresh(repoRoot: string, reason: string): Promise<void> {
    const rebaseRead = this.panel.visible && vscode.window.state.focused
      ? this.messages.synchronizeRebaseSession(reason) : undefined;
    // stack mutation만 PR 첫 페이지 refresh로 승격한다.
    const mode: GraphRefreshMode = reason === "stackSubmitted" || reason === "stackAdvanced" ? "pullRequests" : "stacks";
    await Promise.all([rebaseRead, this.refreshCoordinator.request({ repoRoot, cause: reason, mode })]);
  }
  /** ready/manual 요청은 한 번의 직접 Graph reload와 fingerprint baseline을 완료할 때까지 기다린다. */
  private async runDirectGraph(cause: string): Promise<boolean> {
    return this.refreshCoordinator.runDirect({ repoRoot: this.logService.repoRoot, cause });
  }
  /** 저장소 교체도 직접 baseline 확정 뒤 공통 수명에서 local stack과 원격 PR을 병렬 복원한다. */
  private async reloadRepository(): Promise<void> {
    if (!await this.runDirectGraph("ready") || this.disposed) return;
    void this.messages.refreshPullRequests("ready", true);
  }
  /** lifecycle 경계에서 늦은 결과를 무효화한다. 숨김/포커스 해제는 화면의 그래프와 PR 조회를 보존한다. */
  private invalidateRefreshWork(reason: string): void {
    const plan = graphInvalidationPlan(reason);
    if (plan.keepLoadedGraph) this.pauseLoadedGraph(); else this.resetLoadedGraph();
    if (plan.cancelPullRequests) this.messages.cancelPullRequestLoading(reason);
    else this.messages.pausePullRequestLifecycle(reason);
    this.branchLoading.cancel(reason);
    this.logService.cancelGraphBranchContainment(reason);
    logInfo("graph refresh lifecycle invalidated", { repoRoot: this.logService.repoRoot, reason });
  }
  /** branch filter 메시지를 패널 소유 상태에 반영한 뒤 첫 페이지를 다시 읽는다. */
  private async setBranchFilter(message: Extract<FromWebviewMessage, { type: "setBranchFilter" }>): Promise<void> {
    const detailsPending = !!this.branchDetails.identity;
    this.branchFilter = normalizeBranchFilterState(message.mode, message.branches ?? [], message.compact ?? this.branchFilter.compact);
    logInfo("graph branch filter changed", {
      repoRoot: this.logService.repoRoot,
      mode: this.branchFilter.mode,
      selectedCount: this.branchFilter.selected.length,
    });
    this.resetLoadedGraph();
    if (detailsPending) { await this.runDirectGraph("branchFilter"); return; }
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
  private async refreshAfterGraphAction(kind: GraphActionRefreshKind = "graph"): Promise<void> {
    await this.runDirectGraph(kind === "references" ? "references" : "graphAction");
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
    await this.runDirectGraph("checkout");
    void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", { reason: "graphCheckout" });
  }
  /** 같은 도달 가능 이력은 보존하고 ref/HEAD부터 게시한다. 증명하지 못하면 전체 Git log를 읽는다. */
  private async refreshGraphReferences(context: GraphRefreshContext): Promise<void> {
    if (context.historyUncertain || (context.previous && context.previous.historyIdentity !== context.historyIdentity))
      this.logService.invalidateCaches("graphHistoryBoundaryChangedOrUnknown");
    if (this.rangeStartIndex !== 0 || this.branchFilter.mode !== "all" || this.invalidLocalRefs.length || !context.previous ||
      !context.remoteTips || !canReuseGraphSnapshot(context, this.commits)) {
      this.resetLoadedGraph(); await this.reloadGraph(context); return;
    }
    this.workingTree.cancel("checkout");
    this.graphReads.cancel("checkout"); this.branchLoading.cancel("checkout");
    const service = this.logService, repoRoot = service.repoRoot, generation = ++this.loadGeneration;
    service.cancelGraphBranchContainment("checkout");
    this.loading = false;
    /** 같은 패널 저장소·세대가 유지되면 true이고, 뒤늦은 checkout 조회를 버릴 때 원인을 기록한다. */
    const current = () => { const active = this.isGraphGenerationActive(generation, service); if (!active) logInfo("graph checkout refresh skipped", { repoRoot, generation, reason: "staleGeneration" }); return active; };
    const trace = beginGraphPerformanceTrace(repoRoot, context.cause, generation);
    this.activePerformance = trace;
    this.branchDetails.clear();
    const read = this.readBranches(context);
    const data = await read;
    if (!current()) return;
    if (!data || !this.acceptBranchDetails(data)) return;
    const branches = this.publishBranches(data, trace, context);
    const commits = this.commits, filter = this.currentBranchFilter();
    if (this.invalidLocalRefs.length) { this.resetLoadedGraph(); await this.reloadGraph(context); return; }
    this.lastRemoteTips = context.remoteTips.map(tip => ({ ...tip }));
    this.lastBranchRefs = mergeGraphBranchRefs(this.lastBranchRefs.filter(ref => ref.kind === "local"), this.lastRemoteTips);
    this.remoteCatalogStatus = "ready"; this.remoteCatalogError = undefined;
    service.seedGraphBranchTips(branches, this.lastRemoteTips);
    this.reconcilePageOrder = true;
    syncGraphReferenceTips(commits, context.previous.fingerprint, context.fingerprint);
    this.postBranchFilterOptions();
    this.virtualCommits = [];
    if (shouldShowVirtualCommits(filter, branches)) this.workingTree.start(trace);
    this.postGraph(false, "older", trace, "checkout");
    // HEAD를 먼저 보내고 상세용 포함 관계를 준비한다. 후속 조회가 queue 전체를 붙잡지 않는다.
    void service.reindexGraphBranchContainment(commits, this.rangeStartIndex, filter.refs)
      .catch(error => { if (current()) logError("graph checkout containment failed", error, { repoRoot, generation }); });
    this.attachLocalOnlyMarkers(generation, service, "older", trace);
    logInfo("graph history reused", { repoRoot, cause: context.cause, loadedCount: commits.length, generation });
  }
  /** 로컬 상태를 먼저 보내고 remote catalog까지 확정한 뒤 최종 첫 페이지를 정확히 한 번 읽는다. */
  private async reloadGraph(context: GraphRefreshContext): Promise<void> {
    const graphGeneration = this.loadGeneration;
    this.resumeReloadOnFocus = false;
    this.activeReloadGeneration = graphGeneration;
    try { await this.graphReads.withFirstPagePrefetch(this.logService, context, this.branchFilter.mode === "all" && !this.invalidLocalRefs.length, GRAPH_PAGE_SIZE + 1, () => this.reloadGraphOnce(context, graphGeneration)); }
    finally { if (this.activeReloadGeneration === graphGeneration) this.activeReloadGeneration = undefined; }
  }
  /** reloadGraph 의 실제 단계(local → remote → 첫 페이지 → tag)를 한 세대 안에서 실행한다. */
  private async reloadGraphOnce(context: GraphRefreshContext, graphGeneration: number): Promise<void> {
    const repoRoot = this.logService.repoRoot, generation = this.branchLoading.begin(repoRoot);
    const trace = beginGraphPerformanceTrace(repoRoot, context.cause, graphGeneration);
    this.activePerformance = trace;
    this.invalidLocalRefs = [];
    this.branchDetails.clear();
    this.post({ type: "graphHealth" });
    this.remoteCatalogStatus = "pending"; this.remoteCatalogError = undefined;
    const remoteStarted = Date.now();
    const remoteRead = this.branchLoading.loadRemote(
      repoRoot,
      generation,
      graphRemoteRefVersion(context.fingerprint),
      () => this.panel.visible && vscode.window.state.focused,
      context.remoteTips
    ).then(remote => ({ remote, elapsedMs: Date.now() - remoteStarted }));
    const service = this.logService;
    const { data, early } = await readProgressiveGraphBranches({
      read: this.readBranches(context), identity: graphReferenceIdentity(context.fingerprint),
      candidate: this.graphReads.firstPageCandidate(service),
      current: () => this.isGraphGenerationActive(graphGeneration, service),
      cancel: () => this.graphReads.cancel("earlyPublishFailed"),
      publish: (candidate, identity) => {
        this.beginBranchDetails(identity, context);
        const page = candidate.adopt(identity, trace)?.page;
        if (!page) return false;
        this.commits = page.slice(0, GRAPH_PAGE_SIZE); this.virtualCommits = [];
        this.rangeStartIndex = 0; this.exhausted = page.length <= GRAPH_PAGE_SIZE;
        this.rangeTotalCount = this.exhausted ? this.commits.length : undefined;
        this.loading = true; this.postGraph(true, "older", trace, "initial"); return true;
      },
    });
    if (!this.isGraphGenerationActive(graphGeneration)) return;
    if (!data || !this.acceptBranchDetails(data)) return;
    this.publishBranches(data, trace, context);
    const { remote, elapsedMs } = await remoteRead;
    if (!remote || !this.isGraphGenerationActive(graphGeneration)) return;
    Object.assign(this, completeGraphRemoteBranches(service, this.lastLocalBranches, this.lastBranchRefs,
      { remote, elapsedMs }, trace, context.remoteTips !== undefined));
    if (!early) this.postBranchFilterOptions();
    if (early) {
      this.loading = false;
      if (shouldShowVirtualCommits(this.currentBranchFilter(), this.lastLocalBranches)) this.workingTree.start(trace);
      this.postLoadState(false);
      this.attachLocalOnlyMarkers(graphGeneration, service, "older", trace);
    } else await this.loadNextPage(true, "older", trace);
    if (!this.isGraphGenerationActive(graphGeneration)) return;
    void sendGraphTagStatus(repoRoot, (message) => {
      if (this.isGraphGenerationActive(graphGeneration)) this.post(message);
    }, { forceRemote: context.cause === "refresh" });
  }
  /** 상세 조회만 시작한다. 조기 페이지와 경쟁하는 동안에는 표시·색인 상태를 변경하지 않는다. */
  private readBranches(context: GraphRefreshContext): Promise<Awaited<ReturnType<typeof readGraphLocalBranchData>> | undefined> {
    const service = this.logService, generation = this.loadGeneration;
    return this.graphReads.run(service.repoRoot, "branches", signal =>
      readGraphLocalBranchData(service, context.worktrees, signal, context.localBranches)).catch(error => {
        if (this.isGraphGenerationActive(generation, service)) {
          this.branchDetails.fail(error); this.loading = false; this.postLoadState(false);
        }
        throw error;
      });
  }
  /** 같은 세대로 검증한 상세를 실제 배지/필터에 적용한다. */
  private publishBranches(data: Awaited<ReturnType<typeof readGraphLocalBranchData>>, trace: GraphPerformanceTrace, context: GraphRefreshContext): LocalBranchStatus[] {
    const { branches, refs: branchRefs, worktrees, invalidRefs } = data;
    this.lastLocalBranches = branches;
    this.invalidLocalRefs = invalidRefs;
    this.logService.seedGraphBranchTips(branches);
    this.lastBranchRefs = this.remoteCatalogStatus === "ready" ? mergeGraphBranchRefs(branchRefs, this.lastBranchRefs.filter((branch) => branch.kind === "remote")) : branchRefs;
    this.post({ type: "branchStatus", branches, worktrees });
    // 같은 fingerprint의 remote가 이미 있으면 caller가 최종 scope로 한 번만 게시한다.
    if (context.remoteTips === undefined) this.postBranchFilterOptions();
    publishInvalidGraphRefs(this.logService.repoRoot, invalidRefs, (message) => this.post(message));
    logGraphBranchSnapshot(trace, data, context.worktrees !== undefined, this.logService.repoRoot, this.branchFilter.mode, context.localBranches !== undefined);
    return branches;
  }
  /** 실제 identity만 색인하고 상세가 없다는 안내를 게시한다. 기존 상세의 local-only 수치를 재사용하지 않는다. */
  private beginBranchDetails(identity: GraphReferenceIdentity, context: GraphRefreshContext): void {
    this.lastLocalBranches = []; this.lastRemoteTips = context.remoteTips!.map(tip => ({ ...tip }));
    this.lastBranchRefs = mergeGraphBranchRefs(identity.branches.map(branch => ({ name: branch.name, kind: "local" as const })), this.lastRemoteTips);
    this.remoteCatalogStatus = "ready"; this.remoteCatalogError = undefined;
    this.logService.seedGraphReferenceIdentities(identity.branches, this.lastRemoteTips);
    this.branchDetails.start(identity, context.worktrees, message => this.post(message));
    this.postBranchFilterOptions();
  }
  /** 상세를 읽는 사이 checkout/ref가 달라지면 기존 frame을 덮어쓰지 않고 새 fingerprint로 재조정한다. */
  private acceptBranchDetails(data: Awaited<ReturnType<typeof readGraphLocalBranchData>>): boolean {
    const identity = this.branchDetails.identity;
    if (!identity || (!data.invalidRefs.length && matchesGraphReferenceIdentity(identity, data.branches))) {
      this.branchDetails.clear(); return true;
    }
    this.invalidLocalRefs = data.invalidRefs; this.branchDetails.pause(); this.loading = false; this.postLoadState(false);
    publishInvalidGraphRefs(this.logService.repoRoot, data.invalidRefs, message => this.post(message));
    logInfo("graph branch details changed during read", { repoRoot: this.logService.repoRoot });
    void this.runDirectGraph("references"); return false;
  }
  /**
   * 다음 커밋 페이지를 읽어 누적 목록에 붙이고, 현재까지의 그래프를 웹뷰로 보낸다.
   * - git log 는 skip/limit 으로 필요한 페이지만 읽고, 전체 누적 커밋으로 레이아웃을 보정한다.
   * - 첫 페이지는 작업트리 status 와 git log 를 병렬로 시작하되 이력부터 게시한다.
   * @param reset true 면 첫 페이지 로드로 간주해 웹뷰 선택/스크롤 상태를 초기화한다.
   * @param direction older/newer 중 어느 쪽으로 페이지를 확장할지 지정한다.
   */
  private async loadNextPage(reset: boolean, direction: GraphLoadDirection = "older", trace?: GraphPerformanceTrace): Promise<void> {
    const pageService = this.logService;
    const generation = this.loadGeneration;
    const performanceTrace = trace ?? beginGraphPerformanceTrace(pageService.repoRoot, reset ? "reload" : `pagination:${direction}`, generation);
    if (reset) direction = "older";
    const filter = this.currentBranchFilter();
    await executeGraphPageRequest({
      repoRoot: pageService.repoRoot, reset, direction, pageSize: GRAPH_PAGE_SIZE, loading: this.loading,
      reconcile: this.reconcilePageOrder, filter, trace: performanceTrace,
      progress: { commits: this.commits, rangeStartIndex: this.rangeStartIndex, rangeTotalCount: this.rangeTotalCount, exhausted: this.exhausted },
      current: () => this.isGraphGenerationActive(generation, pageService),
      read: (skip, readLimit) => this.graphReads.run(pageService.repoRoot, "page", signal => this.graphReads.readPageData(pageService, {
        skip, readLimit, refs: filter.refs, trace: performanceTrace,
        readVirtualCommits: false, signal,
      }, this.lastLocalBranches)),
      state: () => this.postLoadState(reset, direction),
      empty: () => {
        this.virtualCommits = []; this.exhausted = true; this.rangeStartIndex = 0; this.rangeTotalCount = 0;
        this.postGraph(reset, direction, performanceTrace, "initial", []);
      },
      begin: progress => {
        Object.assign(this, progress); this.loading = true;
        if (reset && shouldShowVirtualCommits(filter, this.lastLocalBranches)) this.workingTree.start(performanceTrace);
        this.postLoadState(reset, direction);
      },
      accept: progress => {
        Object.assign(this, progress); this.reconcilePageOrder = false;
        const localOnlyWarm = pageService.applyWarmLocalOnlyBranches(this.commits);
        this.loading = false; this.postGraph(reset, direction, performanceTrace, reset ? "initial" : "pagination");
        if (!localOnlyWarm) this.attachLocalOnlyMarkers(generation, pageService, direction, performanceTrace);
      },
      stale: () => pageService.cancelGraphBranchContainment("stalePage"),
      failed: () => {
        if (reset) this.workingTree.cancel("pageFailed");
        this.loading = false; this.postLoadState(reset, direction);
      },
    });
  }
  /** local-only 표시를 백그라운드로 계산하고, 표시가 실제로 바뀐 경우에만 그래프를 다시 게시한다. */
  private attachLocalOnlyMarkers(generation: number, pageService: GitLogService, direction: GraphLoadDirection, trace: GraphPerformanceTrace | undefined): void {
    attachGraphLocalOnlyMarkers(pageService, this.commits, () => this.isGraphGenerationActive(generation, pageService),
      () => this.postGraph(false, direction, trace, "localOnly"));
  }
  /** 특정 commit 후보 주변 window 를 새 graph 로 그려 오래된 PR 점프 때 중간 페이지 누적을 피한다. */
  private loadCommitWindow(hashes: string[]): Promise<string | undefined> {
    return this.showCommitWindow("commitWindow", signal => loadFilteredGraphCommitWindow(
      this.logService.repoRoot, hashes, this.currentBranchFilter(), GRAPH_PAGE_SIZE, signal
    ));
  }
  /**
   * reflog commit 을 현재 ref 필터와 무관한 복구용 graph window 로 표시한다.
   * @param hash reflog 항목이 가리키는 commit hash
   * @returns 그래프에 표시한 commit hash. Git 이 찾지 못하면 undefined
   */
  private loadReflogCommitWindow(hash: string): Promise<string | undefined> {
    return this.showCommitWindow("reflogWindow", async signal => {
      const window = await loadReflogGraphWindow(this.logService.repoRoot, hash, GRAPH_PAGE_SIZE, signal);
      return window && { ...window, startIndex: 0, totalCount: window.commits.length };
    });
  }
  /**
   * 읽어 온 commit window 로 누적 그래프를 대체해 게시한다(PR 점프·reflog 복구 공용).
   * @param cause 성능 trace/OUTPUT 에 남길 원인
   * @param load window 를 읽는 함수. 찾지 못하면 undefined
   * @returns 표시한 commit hash. 오래된 세대이거나 찾지 못하면 undefined
   */
  private async showCommitWindow(
    cause: "commitWindow" | "reflogWindow",
    load: (signal: AbortSignal) => Promise<{ commits: Commit[]; startIndex: number; totalCount: number; hash: string } | undefined>
  ): Promise<string | undefined> {
    this.workingTree.pause(cause);
    if (this.branchDetails.identity) this.resumeReloadOnFocus = true;
    this.branchDetails.pause();
    const generation = ++this.loadGeneration;
    const trace = beginGraphPerformanceTrace(this.logService.repoRoot, cause, generation);
    this.loading = true;
    return executeGraphWindowRequest({
      repoRoot: this.logService.repoRoot, cause,
      read: () => this.graphReads.run(this.logService.repoRoot, cause, load),
      current: () => this.isGraphGenerationActive(generation),
      accept: window => {
        this.workingTree.cancel(cause); this.virtualCommits = []; this.commits = window.commits;
        this.rangeStartIndex = window.startIndex; this.rangeTotalCount = window.totalCount; this.loading = false;
        this.exhausted = this.rangeStartIndex + this.commits.length >= window.totalCount;
        this.postGraph(true, "older", trace, "window");
      },
      finish: () => { if (this.loading) { this.loading = false; this.workingTree.resume(trace); this.postLoadState(false); } },
    });
  }
  /** 현재 패널의 누적 커밋/종료 상태를 초기화하고 이전 비동기 로드 결과를 무효화한다. */
  private resetLoadedGraph(): void {
    this.workingTree.cancel("reset");
    this.branchDetails.clear();
    this.graphReads.cancel("reset");
    this.logService.resetGraphBranchIndex();
    this.commits = []; this.virtualCommits = [];
    this.reconcilePageOrder = false;
    this.loading = false; this.exhausted = false;
    this.rangeStartIndex = 0; this.rangeTotalCount = undefined;
    this.loadGeneration++;
  }
  /**
   * 숨김/포커스 해제 동안 늦게 도착할 페이지·reload 결과만 버리고 화면에 있는 그래프 상태는 유지한다.
   * - 첫 페이지 게시 전 reload 가 끊겼으면 복귀 때 직접 reload 를 다시 하도록 표시한다.
   * - 로딩 표시가 남지 않도록 현재 상태를 다시 알린다.
   */
  private pauseLoadedGraph(): void {
    this.workingTree.pause("paused");
    this.branchDetails.pause();
    this.graphReads.cancel("paused");
    if (this.activeReloadGeneration !== undefined || this.commits.length === 0 || this.branchDetails.identity) this.resumeReloadOnFocus = true;
    this.loadGeneration++;
    if (this.loading || this.workingTree.state || this.branchDetails.state) { this.loading = false; this.postLoadState(false); }
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
      filter: createGraphBranchFilterSnapshot(this.lastBranchRefs, this.branchDetails.identity?.branches ?? this.lastLocalBranches, this.branchFilter,
        this.remoteCatalogStatus, this.remoteCatalogError, this.invalidLocalRefs.length > 0),
    });
  }
  /** Graph layout과 render trace를 게시한다. commits는 빈 필터처럼 현재 목록을 대체할 때만 전달한다. */
  private postGraph(reset: boolean, direction: GraphLoadDirection, trace: GraphPerformanceTrace | undefined,
    kind: "initial" | "pagination" | "localOnly" | "checkout" | "window" | "workingTree", commits = this.commits): void {
    publishGraphRender({
      commits, virtualCommits: commits === this.commits ? this.virtualCommits : [],
      compact: this.branchFilter.compact, state: this.makeLoadState(reset, direction), trace, kind,
    }, (message) => this.post(message), this.renderCache);
  }
  /** 웹뷰가 무한 스크롤을 갱신하도록 현재 count/loading/reset/direction 상태를 만든다. */
  private makeLoadState(reset: boolean, direction?: GraphLoadDirection): GraphLoadState {
    return {
      loadedCount: this.commits.length, hasMore: !this.exhausted,
      hasMoreBefore: this.rangeStartIndex > 0, loading: this.loading,
      loadDirection: direction, reset, colorScope: this.logService.repoRoot,
      workingTree: this.workingTree.state ?? null,
      branchDetails: this.branchDetails.state ?? null,
    };
  }
  /** commit 데이터가 같을 때 loading/reset/direction만 웹뷰로 보내 불필요한 DOM rebuild를 피한다. */
  private postLoadState(reset: boolean, direction?: GraphLoadDirection): void {
    this.post({ type: "graphLoadState", state: this.makeLoadState(reset && !this.loading, direction) });
  }
  /** 타입이 보장된 메시지를 공통 transport/수락 계측 경계로 전송한다. */
  private post(message: ToWebviewMessage): void {
    if (this.disposed) return;
    this.messages.observeRebaseMessage(message);
    postGraphWebviewMessage(this.panel.webview, this.logService.repoRoot, message);
  }
}
