// git 그래프를 보여주는 웹뷰 패널을 관리하는 모듈.
// - 패널 생애주기(생성/표시/해제)와 웹뷰↔확장 메시지 라우팅만 담당한다.
//   그래프 계산은 graphLayout, git 접근은 GitLogService 에 위임한다(경계 분리).
import * as vscode from "vscode";
import { compactGraphData } from "../graph/graphCompact";
import { GitLogService, EMPTY_TREE, STAGED_COMMIT_HASH } from "../git/gitLogService";
import { layoutGraph } from "../graph/graphLayout";
import { Commit, GraphData, LocalBranchStatus } from "../graph/graphTypes";
import { openRefVsRefDiff } from "../ui/diffPresenter";
import { logError, logInfo } from "../ui/outputLog";
import { handleGraphAction, isGraphActionMessage } from "./graphActions";
import {
  buildBranchFilterSnapshot,
  filterCommitRefs,
  normalizeBranchFilterState,
  resolveBranchFilter,
  shouldShowVirtualCommits,
} from "./graphBranchFilter";
import type { GraphBranchFilterState, GraphBranchRef, ResolvedGraphBranchFilter } from "./graphBranchFilter";
import { buildGraphHtml } from "./graphHtml";
import { handleGraphRebaseMessage, isGraphRebaseMessage } from "./graphRebaseRouter";
import { restoreGraphRebaseSession } from "./graphRebaseSession";
import { generateGraphRebaseAiPlan } from "./graphRebaseAiActions";
import { FromWebviewMessage, GraphLoadState, ToWebviewMessage } from "./graphProtocol";
import { openGraphPullRequest, openStagedPullRequestPreview, GraphPullRequestPager, sendGraphPullRequestDetail } from "./graphPullRequests";
import { ensureGraphCommitVisible, ensureGraphHeadVisible } from "./graphCommitFocus";
import { GraphCommitDetailSender } from "./graphCommitDetails";
import { fetchRefsForGraphSearch, sendGraphRepositorySearch } from "./graphSearchActions";
import { openGraphVirtualFileDiff } from "./graphVirtualDiff";

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
  private loading = false;
  private exhausted = false;
  private loadGeneration = 0;
  private branchFilter: GraphBranchFilterState = {
    mode: "all",
    selected: [],
    compact: true,
  };
  private lastLocalBranches: LocalBranchStatus[] = [];
  private lastBranchRefs: GraphBranchRef[] = [];
  private readonly pullRequests = new GraphPullRequestPager();
  private readonly commitDetails = new GraphCommitDetailSender();

  /**
   * 패널을 만들거나, 이미 있으면 앞으로 가져온다.
   * - 대상 저장소(logService)가 바뀌면 새 데이터를 다시 로드한다.
   * @param extensionUri 확장 루트 URI(미디어 리소스 경로 계산용)
   * @param logService   대상 저장소의 로그 서비스
   */
  static createOrShow(
    extensionUri: vscode.Uri,
    logService: GitLogService
  ): void {
    if (GitGraphPanel.current) {
      GitGraphPanel.current.logService = logService;
      GitGraphPanel.current.resetLoadedGraph();
      GitGraphPanel.current.panel.reveal();
      void GitGraphPanel.current.reloadGraph();
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
      logService
    );
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
    if (current.loading) {
      logInfo("graph external refresh skipped", { repoRoot, reason, active: "pageLoad" });
      return true;
    }
    logInfo("graph external refresh requested", { repoRoot, reason });
    current.resetLoadedGraph();
    void current.reloadGraph();
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
  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private logService: GitLogService
  ) {
    this.panel.webview.html = buildGraphHtml(panel, extensionUri);
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
        logInfo("graph reload requested", {
          repoRoot: this.logService.repoRoot,
          reason: msg.type,
        });
        this.resetLoadedGraph();
        await this.reloadGraph();
        await restoreGraphRebaseSession({
          extensionUri: this.extensionUri,
          logService: this.logService,
          refreshGraph: () => this.refreshAfterGraphAction(),
          post: (message) => this.post(message),
        });
        void this.pullRequests.refresh(this.logService.repoRoot, this.lastLocalBranches, msg.type, (message) => this.post(message));
      } else if (msg.type === "loadMore") {
        await this.loadNextPage(false);
      } else if (msg.type === "setBranchFilter") {
        this.branchFilter = normalizeBranchFilterState(
          msg.mode,
          msg.branches ?? [],
          msg.compact ?? this.branchFilter.compact
        );
        logInfo("graph branch filter changed", {
          repoRoot: this.logService.repoRoot,
          mode: this.branchFilter.mode,
          selectedCount: this.branchFilter.selected.length,
        });
        this.resetLoadedGraph();
        await this.reloadGraph();
      } else if (msg.type === "selectCommit") {
        await this.commitDetails.send(msg.hash, this.logService, (message) => this.post(message));
      } else if (msg.type === "refreshPullRequests") {
        await this.pullRequests.refresh(this.logService.repoRoot, this.lastLocalBranches, "manual", (message) => this.post(message));
      } else if (msg.type === "searchPullRequests") {
        await this.pullRequests.search(this.logService.repoRoot, msg.requestId, msg.query, msg.cursor, (message) => this.post(message));
      } else if (msg.type === "loadMorePullRequests") {
        await this.pullRequests.loadMore(this.logService.repoRoot, this.lastLocalBranches, (message) => this.post(message));
      } else if (msg.type === "refreshPullRequestDetail") {
        await sendGraphPullRequestDetail(this.logService.repoRoot, msg.number, (message) => this.post(message));
      } else if (msg.type === "ensureCommitVisible") {
        await ensureGraphCommitVisible({
          repoRoot: this.logService.repoRoot,
          requestId: msg.requestId,
          hashes: msg.hashes,
          loadedHash: (hashes) => hashes.find((hash) => this.commits.some((commit) => commit.hash === hash)),
          loadWindow: (hashes) => this.loadCommitWindow(hashes),
          post: (message) => this.post(message),
        });
      } else if (msg.type === "ensureHeadVisible") {
        await ensureGraphHeadVisible({
          repoRoot: this.logService.repoRoot, requestId: msg.requestId,
          loadedHash: (hashes) => hashes.find((hash) => this.commits.some((commit) => commit.hash === hash)),
          loadWindow: (hashes) => this.loadCommitWindow(hashes), post: (message) => this.post(message),
        });
      } else if (msg.type === "graphRepositorySearch") {
        await sendGraphRepositorySearch(
          { logService: this.logService, post: (message) => this.post(message) },
          msg.requestId,
          msg.query,
          msg.scope
        );
      } else if (msg.type === "fetchGraphSearchRefs") {
        await fetchRefsForGraphSearch(
          {
            logService: this.logService,
            post: (message) => this.post(message),
            refreshGraph: () => this.refreshAfterFetchAction(),
          },
          msg.requestId,
          msg.query,
          msg.scope,
          msg.target
        );
      } else if (msg.type === "openPullRequest") {
        await openGraphPullRequest(this.pullRequests.items, msg.number);
      } else if (msg.type === "previewStagedPullRequest") {
        openStagedPullRequestPreview(this.extensionUri, this.logService.repoRoot, this.pullRequests.items, msg.number);
      } else if (isGraphActionMessage(msg)) {
        await handleGraphAction(msg, {
          logService: this.logService,
          pullRequests: () => this.pullRequests.items,
          refreshCheckout: () => this.refreshAfterCheckoutAction(),
          refreshGraph: () => this.refreshAfterGraphAction(),
          post: (message) => this.post(message),
        });
      } else if (msg.type === "openFileDiff") {
        if (await openGraphVirtualFileDiff(this.logService.repoRoot, msg.hash, msg.path)) {
          return;
        }
        const base = msg.parent && msg.parent.length > 0 ? msg.parent : EMPTY_TREE;
        await openRefVsRefDiff(
          this.logService.repoRoot,
          base,
          msg.hash,
          msg.path
        );
      } else if (isGraphRebaseMessage(msg)) {
        await handleGraphRebaseMessage(msg, {
          extensionUri: this.extensionUri,
          logService: this.logService,
          refreshGraph: () => this.refreshAfterGraphAction(),
          post: (message) => this.post(message),
        });
      } else if (msg.type === "generateGraphRebaseAiPlan") {
        const result = await generateGraphRebaseAiPlan(msg.plan, { logService: this.logService });
        if (result) this.post({ type: "graphRebaseAiPlan", result });
      } else if (msg.type === "configureAiCli") {
        await vscode.commands.executeCommand("gitSimpleCompare.configureAiCli");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("graph message handling failed", err, { type: msg.type });
      this.post({ type: "error", message });
    }
  }

  /** git graph action 이후 그래프와 Changes 뷰를 다시 읽는다. */
  private async refreshAfterGraphAction(): Promise<void> {
    this.resetLoadedGraph();
    await this.reloadGraph();
    void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason: "graphAction",
    });
  }

  /** 검색에서 명시적으로 fetch 한 뒤 그래프만 최신 ref 기준으로 다시 읽는다. */
  private async refreshAfterFetchAction(): Promise<void> {
    this.resetLoadedGraph();
    await this.reloadGraph();
  }

  /** checkout 이후에는 기존 graph 페이지를 재사용해 HEAD/가상 노드만 빠르게 갱신한다. */
  private async refreshAfterCheckoutAction(): Promise<void> {
    const branches = await this.sendBranches();
    if (!this.syncLocalRefs(branches, this.currentBranchFilter().visibleRefs)) {
      this.resetLoadedGraph();
      await this.reloadGraph();
      return;
    }
    this.virtualCommits = await this.logService.getVirtualCommits();
    this.post({
      type: "graph",
      data: this.layoutVisibleGraph(),
      state: this.makeLoadState(false),
    });
    logInfo("graph checkout refresh finished", {
      repoRoot: this.logService.repoRoot,
      loadedCount: this.commits.length,
    });
    void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason: "graphCheckout",
    });
  }

  /** 브랜치 상태를 먼저 동기화한 뒤 첫 페이지 그래프를 다시 보낸다. */
  private async reloadGraph(): Promise<void> {
    await this.sendBranches();
    await this.sendGraph();
  }

  /** 첫 페이지부터 다시 읽어 레이아웃한 뒤 그래프 데이터를 웹뷰로 보낸다. */
  private async sendGraph(): Promise<void> {
    await this.loadNextPage(true);
  }

  /** 로컬 브랜치 현황을 읽어 웹뷰의 그래프 ref 배지 렌더러로 보낸다. */
  private async sendBranches(): Promise<LocalBranchStatus[]> {
    const [branches, branchRefs] = await Promise.all([
      this.logService.getLocalBranches(),
      this.logService.getBranches(),
    ]);
    this.lastLocalBranches = branches;
    this.lastBranchRefs = branchRefs;
    this.post({ type: "branchStatus", branches });
    this.post({
      type: "branchFilterOptions",
      filter: buildBranchFilterSnapshot(branchRefs, branches, this.branchFilter),
    });
    logInfo("graph branch status sent", {
      repoRoot: this.logService.repoRoot,
      branches: branches.length,
      current: branches.find((branch) => branch.current)?.name,
      filterMode: this.branchFilter.mode,
    });
    return branches;
  }

  /**
   * 다음 커밋 페이지를 읽어 누적 목록에 붙이고, 현재까지의 그래프를 웹뷰로 보낸다.
   * - git log 는 skip/limit 으로 필요한 페이지만 읽는다.
   * - 레이아웃은 지금까지 로드된 커밋 전체를 기준으로 다시 계산한다. 새 부모 커밋이
   *   들어오면 이전 페이지의 "바닥으로 이어지던" 간선 도착점이 자연스럽게 보정된다.
   * @param reset true 면 첫 페이지 로드로 간주해 웹뷰 선택/스크롤 상태를 초기화한다.
   */
  private async loadNextPage(reset: boolean): Promise<void> {
    if (this.loading) {
      logInfo("graph page load skipped", {
        reason: "alreadyLoading",
        loadedCount: this.commits.length,
      });
      this.postLoadState(reset);
      return;
    }
    if (!reset && (!this.hasMore() || this.exhausted)) {
      logInfo("graph page load skipped", {
        reason: "noMoreCommits",
        loadedCount: this.commits.length,
      });
      this.postLoadState(reset);
      return;
    }

    const generation = this.loadGeneration;
    const started = Date.now();
    const skip = this.commits.length;
    const pageLimit = GRAPH_PAGE_SIZE;
    const branchFilter = this.currentBranchFilter();
    if (branchFilter.empty) {
      this.virtualCommits = [];
      this.exhausted = true;
      this.post({
        type: "graph",
        data: this.layoutVisibleGraph([]),
        state: this.makeLoadState(reset),
      });
      return;
    }
    this.loading = true;
    this.postLoadState(reset);
    logInfo("graph page load started", {
      repoRoot: this.logService.repoRoot,
      skip,
      limit: pageLimit,
      filterMode: branchFilter.mode,
      refCount: branchFilter.refs.length,
    });
    let postedGraph = false;
    try {
      if (reset) {
        this.virtualCommits = shouldShowVirtualCommits(
          branchFilter,
          this.lastLocalBranches
        )
          ? await this.logService.getVirtualCommits()
          : [];
      }
      const page = await this.logService.getCommitPage(
        pageLimit + 1,
        skip,
        branchFilter.refs,
        false
      );
      if (generation !== this.loadGeneration) {
        logInfo("graph page load ignored", {
          reason: "staleGeneration",
          skip,
          limit: pageLimit,
        });
        return;
      }
      const nextCommits = filterCommitRefs(
        page.slice(0, pageLimit),
        branchFilter
      );
      this.commits.push(...nextCommits);
      this.exhausted = page.length <= pageLimit;
      this.loading = false;
      this.post({
        type: "graph",
        data: this.layoutVisibleGraph(),
        state: this.makeLoadState(reset),
      });
      postedGraph = true;
      const localOnlyStarted = Date.now();
      void this.logService.attachLocalOnlyBranches(this.commits).then((changedCount) => {
        if (generation !== this.loadGeneration || changedCount === 0) {
          return;
        }
        this.post({ type: "graph", data: this.layoutVisibleGraph(), state: this.makeLoadState(false) });
        logInfo("graph local-only markers sent", {
          repoRoot: this.logService.repoRoot,
          changedCount,
          loadedCount: this.commits.length,
          elapsed: Date.now() - localOnlyStarted,
        });
      }).catch((err) => logError("graph local-only markers failed", err, { repoRoot: this.logService.repoRoot }));
      logInfo("graph page load finished", {
        fetchedCount: nextCommits.length,
        loadedCount: this.commits.length,
        hasMore: this.hasMore(),
        elapsed: Date.now() - started,
      });
    } finally {
      if (!postedGraph && generation === this.loadGeneration) {
        this.loading = false;
        this.postLoadState(reset);
      }
    }
  }

  /** 특정 commit 후보 주변 window 를 새 graph 로 그려 오래된 PR 점프 때 중간 페이지 누적을 피한다. */
  private async loadCommitWindow(hashes: string[]): Promise<string | undefined> {
    const generation = ++this.loadGeneration;
    this.loading = true;
    try {
      for (const hash of hashes) {
        const commits = await this.logService.getCommitWindowAround(hash, 80, GRAPH_PAGE_SIZE, []).catch(() => []);
        if (generation !== this.loadGeneration) return undefined;
        if (!commits.some((commit) => commit.hash === hash)) continue;
        this.virtualCommits = [];
        this.commits = commits; this.loading = false; this.exhausted = true;
        this.post({ type: "graph", data: this.layoutVisibleGraph(), state: this.makeLoadState(true) });
        logInfo("graph commit window sent", { repoRoot: this.logService.repoRoot, hash, count: commits.length });
        return hash;
      }
      return undefined;
    } finally {
      if (generation === this.loadGeneration && this.loading) this.loading = false;
    }
  }

  /** 현재 패널의 누적 커밋/종료 상태를 초기화하고 이전 비동기 로드 결과를 무효화한다. */
  private resetLoadedGraph(): void {
    this.logService.invalidateCaches();
    this.commits = [];
    this.virtualCommits = [];
    this.loading = false;
    this.exhausted = false;
    this.loadGeneration++;
  }

  /** 실제 git 로그 끝에 도달했는지 기준으로 추가 페이지를 읽을 수 있는지 판단한다. */
  private hasMore(): boolean {
    return !this.exhausted;
  }

  /** 현재 브랜치 필터 상태를 git log 와 ref 표시 필터에 쓸 수 있는 형태로 변환한다. */
  private currentBranchFilter(): ResolvedGraphBranchFilter {
    return resolveBranchFilter(
      this.branchFilter,
      this.lastBranchRefs
    );
  }

  /** 이미 로드된 커밋 목록에 최신 로컬 브랜치/HEAD 참조를 반영한다. */
  private syncLocalRefs(
    branches: LocalBranchStatus[],
    visibleRefs: Set<string>
  ): boolean {
    const localNames = new Set(branches.map((branch) => branch.name));
    for (const commit of this.commits) {
      commit.refs = commit.refs.filter(
        (ref) => ref !== "HEAD" && !localNames.has(ref)
      );
    }

    let currentLoaded = false;
    const currentBranch = branches.find((branch) => branch.current);
    for (const branch of branches) {
      if (!visibleRefs.has(branch.name)) {
        continue;
      }
      const commit = this.commits.find((item) => item.hash === branch.hash);
      if (!commit) {
        continue;
      }
      if (branch.current) {
        commit.refs.unshift("HEAD");
        currentLoaded = true;
      }
      if (!commit.refs.includes(branch.name)) {
        commit.refs.push(branch.name);
      }
    }
    return (
      currentLoaded ||
      !currentBranch ||
      !visibleRefs.has(currentBranch.name)
    );
  }

  /** 레이아웃용 커밋 목록을 만든다. 가상 커밋은 HEAD 바로 위 두 row 에 끼워 넣는다. */
  private graphCommits(): Commit[] {
    if (this.virtualCommits.length === 0) {
      return this.commits;
    }
    const headHash = this.virtualCommits.find(
      (commit) => commit.hash === STAGED_COMMIT_HASH
    )?.parents[0];
    const headIndex = this.commits.findIndex(
      (commit) => commit.hash === headHash || commit.refs.includes("HEAD")
    );
    if (headIndex < 0) {
      return [...this.virtualCommits, ...this.commits];
    }
    return [
      ...this.commits.slice(0, headIndex),
      ...this.virtualCommits,
      ...this.commits.slice(headIndex),
    ];
  }

  /**
   * 현재 필터의 compact 설정을 반영한 그래프 레이아웃을 만든다.
   * @param commits 명시적으로 레이아웃할 커밋 목록. 생략하면 현재 누적 그래프 커밋을 쓴다.
   * @returns 웹뷰로 보낼 GraphData
   */
  private layoutVisibleGraph(commits = this.graphCommits()): GraphData {
    const graph = layoutGraph(commits);
    return this.branchFilter.compact ? compactGraphData(graph) : graph;
  }

  /**
   * 웹뷰가 무한 스크롤 상태를 갱신할 수 있도록 현재 로딩 상태를 만든다.
   * @param reset true 면 웹뷰가 선택/스크롤을 초기화해야 하는 로드임을 뜻한다.
   */
  private makeLoadState(reset: boolean): GraphLoadState {
    return {
      loadedCount: this.commits.length,
      hasMore: this.hasMore(),
      loading: this.loading,
      reset,
    };
  }

  /**
   * 그래프 데이터가 바뀌지 않고 로딩 상태만 바뀔 때 웹뷰로 상태 메시지를 보낸다.
   * @param reset true 면 첫 페이지 로드 중인 상태임을 뜻한다.
   */
  private postLoadState(reset: boolean): void {
    this.post({ type: "graphLoadState", state: this.makeLoadState(reset && !this.loading) });
  }

  /** 타입이 보장된 메시지를 웹뷰로 전송한다. */
  private post(message: ToWebviewMessage): void {
    void this.panel.webview.postMessage(message);
  }
}
