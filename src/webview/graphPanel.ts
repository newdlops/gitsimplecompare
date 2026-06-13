// git 그래프를 보여주는 웹뷰 패널을 관리하는 모듈.
// - 패널 생애주기(생성/표시/해제)와 웹뷰↔확장 메시지 라우팅만 담당한다.
//   그래프 계산은 graphLayout, git 접근은 GitLogService 에 위임한다(경계 분리).
import * as vscode from "vscode";
import {
  GitLogService,
  EMPTY_TREE,
  ONGOING_COMMIT_HASH,
  STAGED_COMMIT_HASH,
} from "../git/gitLogService";
import { RebaseService } from "../git/rebaseService";
import { layoutGraph } from "../graph/graphLayout";
import { Commit, LocalBranchStatus } from "../graph/graphTypes";
import {
  openHeadVsIndexDiff,
  openRefVsRefDiff,
  openRefVsWorkingDiff,
} from "../ui/diffPresenter";
import { logError, logInfo } from "../ui/outputLog";
import { handleGraphAction, isGraphActionMessage } from "./graphActions";
import { RebasePanel } from "./rebasePanel";
import {
  FromWebviewMessage,
  GraphLoadState,
  ToWebviewMessage,
} from "./graphProtocol";

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

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private logService: GitLogService
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
        logInfo("graph reload requested", {
          repoRoot: this.logService.repoRoot,
          reason: msg.type,
        });
        this.resetLoadedGraph();
        await this.reloadGraph();
      } else if (msg.type === "loadMore") {
        await this.loadNextPage(false);
      } else if (msg.type === "selectCommit") {
        const detail = await this.logService.getCommitDetail(msg.hash);
        this.post({ type: "commitDetail", detail });
      } else if (isGraphActionMessage(msg)) {
        await handleGraphAction(msg, {
          logService: this.logService,
          refreshCheckout: () => this.refreshAfterCheckoutAction(),
          refreshGraph: () => this.refreshAfterGraphAction(),
        });
      } else if (msg.type === "openFileDiff") {
        if (await this.openVirtualFileDiff(msg.hash, msg.path)) {
          return;
        }
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
      logError("graph message handling failed", err, { type: msg.type });
      this.post({ type: "error", message });
    }
  }

  /**
   * ongoing/staged 가상 커밋의 파일 diff 를 실제 의미에 맞게 연다.
   * @param hash 선택한 그래프 노드 해시
   * @param path diff 를 열 파일 경로
   * @returns 가상 커밋으로 처리했으면 true
   */
  private async openVirtualFileDiff(hash: string, path: string): Promise<boolean> {
    if (hash === ONGOING_COMMIT_HASH) {
      await openRefVsWorkingDiff(
        this.logService.repoRoot,
        "HEAD",
        vscode.Uri.file(`${this.logService.repoRoot}/${path}`),
        path
      );
      return true;
    }
    if (hash === STAGED_COMMIT_HASH) {
      await openHeadVsIndexDiff(this.logService.repoRoot, path);
      return true;
    }
    return false;
  }

  /** git graph action 이후 그래프와 Changes 뷰를 다시 읽는다. */
  private async refreshAfterGraphAction(): Promise<void> {
    this.resetLoadedGraph();
    await this.reloadGraph();
    void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason: "graphAction",
    });
  }

  /** checkout 이후에는 기존 graph 페이지를 재사용해 HEAD/가상 노드만 빠르게 갱신한다. */
  private async refreshAfterCheckoutAction(): Promise<void> {
    const branches = await this.sendBranches();
    if (!this.syncLocalRefs(branches)) {
      this.resetLoadedGraph();
      await this.reloadGraph();
      return;
    }
    this.virtualCommits = await this.logService.getVirtualCommits();
    this.post({
      type: "graph",
      data: layoutGraph(this.graphCommits()),
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
    const branches = await this.logService.getLocalBranches();
    this.post({ type: "branchStatus", branches });
    logInfo("graph branch status sent", {
      repoRoot: this.logService.repoRoot,
      branches: branches.length,
      current: branches.find((branch) => branch.current)?.name,
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
    const skip = this.commits.length;
    const pageLimit = GRAPH_PAGE_SIZE;

    this.loading = true;
    this.postLoadState(reset);
    logInfo("graph page load started", {
      repoRoot: this.logService.repoRoot,
      skip,
      limit: pageLimit,
    });

    let postedGraph = false;
    try {
      if (reset) {
        this.virtualCommits = await this.logService.getVirtualCommits();
      }
      const page = await this.logService.getCommitPage(pageLimit + 1, skip);
      if (generation !== this.loadGeneration) {
        logInfo("graph page load ignored", {
          reason: "staleGeneration",
          skip,
          limit: pageLimit,
        });
        return;
      }

      const nextCommits = page.slice(0, pageLimit);
      this.commits.push(...nextCommits);
      this.exhausted = page.length <= pageLimit;
      this.loading = false;
      this.post({
        type: "graph",
        data: layoutGraph(this.graphCommits()),
        state: this.makeLoadState(reset),
      });
      postedGraph = true;
      logInfo("graph page load finished", {
        fetchedCount: nextCommits.length,
        loadedCount: this.commits.length,
        hasMore: this.hasMore(),
      });
    } finally {
      if (!postedGraph && generation === this.loadGeneration) {
        this.loading = false;
        this.postLoadState(reset);
      }
    }
  }

  /** 현재 패널의 누적 커밋/종료 상태를 초기화하고 이전 비동기 로드 결과를 무효화한다. */
  private resetLoadedGraph(): void {
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

  /** 이미 로드된 커밋 목록에 최신 로컬 브랜치/HEAD 참조를 반영한다. */
  private syncLocalRefs(branches: LocalBranchStatus[]): boolean {
    const localNames = new Set(branches.map((branch) => branch.name));
    for (const commit of this.commits) {
      commit.refs = commit.refs.filter(
        (ref) => ref !== "HEAD" && !localNames.has(ref)
      );
    }

    let currentLoaded = false;
    for (const branch of branches) {
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
    return currentLoaded || branches.every((branch) => !branch.current);
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
    this.post({ type: "graphLoadState", state: this.makeLoadState(reset) });
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
    const featureScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "graphFeatures.js")
    );
    const detailScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "graphDetail.js")
    );
    const virtualHeaderScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "graphVirtualHeader.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "graph.css")
    );
    const controlsStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "graphControls.css")
    );
    const detailStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "graphDetail.css")
    );
    const virtualHeaderStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, "graphVirtualHeader.css")
    );
    const codiconStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "codicons", "codicon.css")
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
  <link href="${codiconStyleUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <link href="${controlsStyleUri}" rel="stylesheet" />
  <link href="${detailStyleUri}" rel="stylesheet" />
  <link href="${virtualHeaderStyleUri}" rel="stylesheet" />
  <title>Git Graph</title>
</head>
<body class="detail-open">
  <div id="app">
    <main id="graph-pane">
      <div id="graph-toolbar">
        <div class="toolbar-group">
          <button id="refresh-graph" class="icon-button" type="button" title="${vscode.l10n.t(
            "Refresh graph"
          )}" aria-label="${vscode.l10n.t("Refresh graph")}">
            <span class="codicon codicon-refresh" aria-hidden="true"></span>
          </button>
          <button id="fetch-graph" class="icon-button" type="button" title="${vscode.l10n.t(
            "Fetch"
          )}" aria-label="${vscode.l10n.t("Fetch")}">
            <span class="codicon codicon-repo-fetch" aria-hidden="true"></span>
          </button>
          <button id="pull-graph" class="icon-button" type="button" title="${vscode.l10n.t(
            "Pull"
          )}" aria-label="${vscode.l10n.t("Pull")}">
            <span class="codicon codicon-repo-pull" aria-hidden="true"></span>
          </button>
          <button id="push-graph" class="icon-button" type="button" title="${vscode.l10n.t(
            "Push"
          )}" aria-label="${vscode.l10n.t("Push")}">
            <span class="codicon codicon-repo-push" aria-hidden="true"></span>
          </button>
          <button id="open-remote-branch" class="icon-button" type="button" hidden disabled title="${vscode.l10n.t(
            "Open Remote Branch"
          )}" aria-label="${vscode.l10n.t("Open Remote Branch")}">
            <span class="codicon codicon-link-external" aria-hidden="true"></span>
          </button>
          <button id="jump-head" class="icon-button" type="button" title="${vscode.l10n.t(
            "Jump to HEAD"
          )}" aria-label="${vscode.l10n.t("Jump to HEAD")}">
            <span class="codicon codicon-target" aria-hidden="true"></span>
          </button>
          <button id="toggle-detail" class="icon-button" type="button" title="${vscode.l10n.t(
            "Toggle commit details"
          )}" aria-label="${vscode.l10n.t("Toggle commit details")}">
            <span class="codicon codicon-layout-sidebar-right" aria-hidden="true"></span>
          </button>
        </div>
        <div id="graph-search" role="search">
          <span class="codicon codicon-search" aria-hidden="true"></span>
          <input id="graph-search-input" type="search" placeholder="${vscode.l10n.t(
            "Search commits, branches"
          )}" title="${vscode.l10n.t(
      "Search by commit hash, commit title, or branch name"
    )}" aria-label="${vscode.l10n.t(
      "Search by commit hash, commit title, or branch name"
    )}" />
          <div id="graph-search-results" role="listbox" hidden></div>
        </div>
        <span id="load-status" aria-live="polite"></span>
      </div>
      <div id="graph" tabindex="0"><div id="graph-content"></div></div>
    </main>
    <div id="main-splitter" class="splitter" role="separator" aria-orientation="vertical" tabindex="0"
      title="${vscode.l10n.t("Resize commit details")}" aria-label="${vscode.l10n.t(
      "Resize commit details"
    )}"></div>
    <div id="detail"><p class="placeholder">${vscode.l10n.t(
      "Select a commit to see details."
    )}</p></div>
  </div>
  <div id="drawer-backdrop"></div>
  <script nonce="${nonce}" src="${featureScriptUri}"></script>
  <script nonce="${nonce}" src="${detailScriptUri}"></script>
  <script nonce="${nonce}" src="${virtualHeaderScriptUri}"></script>
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
