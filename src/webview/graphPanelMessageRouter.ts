// Git Graph 웹뷰에서 들어오는 메시지를 기능별 서비스와 패널 callback으로 연결하는 모듈.
// - GraphPanel은 패널 수명주기와 커밋 paging 상태만 소유하고, 명령 분기는 이 router에 위임한다.
import * as vscode from "vscode";
import { GitLogService, EMPTY_TREE } from "../git/gitLogService";
import type { LocalBranchStatus } from "../graph/graphTypes";
import { openRefVsRefDiff } from "../ui/diffPresenter";
import { logError, logInfo } from "../ui/outputLog";
import {
  handleGraphAction,
  isGraphActionMessage,
  type GraphActionMessage,
} from "./graphActions";
import { ensureGraphCommitVisible, ensureGraphHeadVisible } from "./graphCommitFocus";
import { GraphCommitDetailSender } from "./graphCommitDetails";
import { generateGraphRebaseAiPlan } from "./graphRebaseAiActions";
import { handleGraphRebaseMessage, isGraphRebaseMessage } from "./graphRebaseRouter";
import { restoreGraphRebaseSession } from "./graphRebaseSession";
import { sendGraphReflog } from "./graphReflog";
import type {
  FromWebviewMessage,
  GraphLoadDirection,
  ToWebviewMessage,
} from "./graphProtocol";
import {
  GraphPullRequestPager,
  openGraphPullRequest,
  openGraphPullRequestFileDiff,
  openStagedPullRequestPreview,
  sendGraphPullRequestDetail,
  sendGraphPullRequestStacks,
} from "./graphPullRequests";
import { fetchRefsForGraphSearch, sendGraphRepositorySearch } from "./graphSearchActions";
import { openGraphVirtualFileDiff } from "./graphVirtualDiff";

/** git action 메시지 타입과 진행중 스피너를 표시할 고정 툴바 버튼 DOM id의 대응표. */
const GRAPH_BUSY_BUTTON_IDS: Record<string, string> = {
  fetch: "fetch-graph",
  fetchTags: "fetch-tags-graph",
  pull: "pull-graph",
  push: "push-graph",
  forcePush: "force-push-graph",
};

/**
 * 웹뷰 액션이 직접 지정한 busy 버튼 id를 안전하게 읽는다.
 * @param message 웹뷰에서 받은 protocol 메시지
 * @returns 문자열 busyId가 있으면 해당 값, 없으면 undefined
 */
function actionBusyId(message: FromWebviewMessage): string | undefined {
  const value = (message as { busyId?: unknown }).busyId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** GraphPanel의 동적 상태와 paging 동작을 router가 호출하기 위한 의존성 모음. */
export interface GraphPanelMessageRouterDeps {
  /** 현재 패널이 바라보는 저장소의 GitLogService를 반환한다. */
  logService: () => GitLogService;
  /** 마지막 branchStatus에 포함된 로컬 브랜치 배열을 반환한다. */
  localBranches: () => LocalBranchStatus[];
  /** staged PR preview와 rebase UI 리소스를 찾을 확장 URI. */
  extensionUri: vscode.Uri;
  /** 타입이 검증된 extension→webview 메시지를 전송한다. */
  post: (message: ToWebviewMessage) => void;
  /** 지정 버튼의 busy 상태를 감싸 비동기 작업을 실행한다. */
  withBusy: <T>(key: string, action: () => Promise<T>) => Promise<T>;
  /** 누적 커밋과 비동기 세대를 초기화한다. */
  resetLoadedGraph: () => void;
  /** 브랜치와 첫 커밋 페이지를 다시 읽는다. */
  reloadGraph: () => Promise<void>;
  /** branch filter 메시지를 패널 소유 상태에 반영하고 다시 로드한다. */
  setBranchFilter: (
    message: Extract<FromWebviewMessage, { type: "setBranchFilter" }>
  ) => Promise<void>;
  /** 이전/다음 커밋 페이지를 요청한다. */
  loadNextPage: (reset: boolean, direction?: GraphLoadDirection) => Promise<void>;
  /** 후보 hash 중 이미 누적 그래프에 있는 첫 hash를 반환한다. */
  loadedCommitHash: (hashes: string[]) => string | undefined;
  /** 후보 commit 주변 window를 새 그래프로 불러온다. */
  loadCommitWindow: (hashes: string[]) => Promise<string | undefined>;
  /** reflog commit 주변 복구용 window를 불러온다. */
  loadReflogCommitWindow: (hash: string) => Promise<string | undefined>;
  /** 일반 Git action 뒤 Graph와 Changes를 갱신한다. */
  refreshAfterGraphAction: () => Promise<void>;
  /** fetch 뒤 Graph ref와 commit을 갱신한다. */
  refreshAfterFetchAction: () => Promise<void>;
  /** checkout 뒤 가능한 경우 현재 Graph paging을 재사용한다. */
  refreshAfterCheckoutAction: () => Promise<void>;
}

/** PR pager 상태와 Graph 웹뷰의 모든 incoming message 분기를 관리하는 router. */
export class GraphPanelMessageRouter {
  private readonly pullRequestPager = new GraphPullRequestPager();
  private readonly commitDetails = new GraphCommitDetailSender();

  constructor(private readonly deps: GraphPanelMessageRouterDeps) {}

  /** graph git action이 PR 번호를 실제 PR 정보로 해석할 현재 누적 목록을 반환한다. */
  get pullRequests() {
    return this.pullRequestPager.items;
  }

  /**
   * 현재 pager PR과 local parent 메타데이터를 합친 stack graph snapshot을 보낸다.
   * - branch 생성/restack처럼 GitHub 목록을 다시 읽지 않아도 되는 mutation 뒤에 사용한다.
   */
  async sendPullRequestStacks(): Promise<void> {
    await sendGraphPullRequestStacks(
      this.repoRoot,
      this.pullRequestPager.items,
      this.pullRequestPager.repositoryName,
      this.deps.post
    );
  }

  /**
   * GitHub PR 첫 페이지와 그 결과를 반영한 stack snapshot을 차례로 보낸다.
   * @param reason OUTPUT 로그와 stale generation 식별에 남길 갱신 원인
   */
  async refreshPullRequests(reason: string): Promise<void> {
    await this.pullRequestPager.refresh(
      this.repoRoot,
      this.deps.localBranches(),
      reason,
      this.deps.post
    );
    await this.sendPullRequestStacks();
  }

  /**
   * Graph protocol 메시지를 알맞은 서비스나 패널 callback으로 전달한다.
   * - 실패는 이 경계에서 OUTPUT 로그와 공통 error 메시지로 변환한다.
   * @param message 웹뷰에서 받은 타입 검증 메시지
   */
  async handle(message: FromWebviewMessage): Promise<void> {
    try {
      if (message.type === "ready" || message.type === "refresh") {
        await this.handleReload(message.type);
      } else if (message.type === "loadMore") {
        await this.deps.loadNextPage(false, message.direction || "older");
      } else if (message.type === "setBranchFilter") {
        await this.deps.setBranchFilter(message);
      } else if (message.type === "selectCommit") {
        await this.commitDetails.send(message.hash, this.deps.logService(), this.deps.post);
      } else if (await this.handlePullRequestMessage(message)) {
        return;
      } else if (message.type === "refreshReflog") {
        await sendGraphReflog(
          { repoRoot: this.repoRoot, post: this.deps.post },
          { includeUnreachable: message.includeUnreachable }
        );
      } else if (message.type === "ensureCommitVisible") {
        await ensureGraphCommitVisible({
          repoRoot: this.repoRoot,
          requestId: message.requestId,
          hashes: message.hashes,
          loadedHash: this.deps.loadedCommitHash,
          loadWindow: this.deps.loadCommitWindow,
          post: this.deps.post,
        });
      } else if (message.type === "showReflogCommit") {
        await this.showReflogCommit(message);
      } else if (message.type === "ensureHeadVisible") {
        await ensureGraphHeadVisible({
          repoRoot: this.repoRoot,
          requestId: message.requestId,
          loadedHash: this.deps.loadedCommitHash,
          loadWindow: this.deps.loadCommitWindow,
          post: this.deps.post,
        });
      } else if (message.type === "graphRepositorySearch") {
        await sendGraphRepositorySearch(
          { logService: this.deps.logService(), post: this.deps.post },
          message.requestId,
          message.query,
          message.scope
        );
      } else if (message.type === "fetchGraphSearchRefs") {
        await this.fetchSearchRefs(message);
      } else if (isGraphActionMessage(message)) {
        await this.handleGitAction(message);
      } else if (message.type === "openFileDiff") {
        await this.openFileDiff(message);
      } else if (isGraphRebaseMessage(message)) {
        await handleGraphRebaseMessage(message, this.rebaseDeps());
      } else if (message.type === "generateGraphRebaseAiPlan") {
        const result = await generateGraphRebaseAiPlan(message.plan, {
          logService: this.deps.logService(),
        });
        if (result) this.deps.post({ type: "graphRebaseAiPlan", result });
      } else if (message.type === "configureAiCli") {
        await vscode.commands.executeCommand("gitSimpleCompare.configureAiCli");
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      logError("graph message handling failed", error, { type: message.type });
      this.deps.post({ type: "error", message: text });
    }
  }

  /** 현재 LogService가 가리키는 저장소 루트를 편의상 반환한다. */
  private get repoRoot(): string {
    return this.deps.logService().repoRoot;
  }

  /** ready/manual refresh에서 Graph와 rebase session을 복원하고 PR 갱신을 병렬 시작한다. */
  private async handleReload(reason: "ready" | "refresh"): Promise<void> {
    logInfo("graph reload requested", { repoRoot: this.repoRoot, reason });
    this.deps.resetLoadedGraph();
    await this.deps.withBusy("refresh-graph", this.deps.reloadGraph);
    await restoreGraphRebaseSession(this.rebaseDeps());
    void this.deps.withBusy("graph-pr-list", () => this.refreshPullRequests(reason));
  }

  /**
   * PR 목록·검색·상세·stack action 메시지를 처리한다.
   * @param message Graph protocol 전체 메시지
   * @returns PR 영역에서 메시지를 소비했으면 true
   */
  private async handlePullRequestMessage(message: FromWebviewMessage): Promise<boolean> {
    if (message.type === "refreshPullRequests") {
      await this.deps.withBusy("graph-pr-list", () => this.refreshPullRequests("manual"));
    } else if (message.type === "searchPullRequests") {
      await this.pullRequestPager.search(
        this.repoRoot,
        message.requestId,
        message.query,
        message.cursor,
        this.deps.post
      );
    } else if (message.type === "loadMorePullRequests") {
      await this.pullRequestPager.loadMore(
        this.repoRoot,
        this.deps.localBranches(),
        this.deps.post
      );
      await this.sendPullRequestStacks();
    } else if (message.type === "refreshPullRequestDetail") {
      await sendGraphPullRequestDetail(this.repoRoot, message.number, this.deps.post);
    } else if (message.type === "openPullRequest") {
      await openGraphPullRequest(this.pullRequestPager.items, message.number);
    } else if (message.type === "previewStagedPullRequest") {
      openStagedPullRequestPreview(
        this.deps.extensionUri,
        this.repoRoot,
        this.pullRequestPager.items,
        message.number
      );
    } else if (message.type === "openPullRequestFileDiff") {
      await openGraphPullRequestFileDiff(
        this.repoRoot,
        this.pullRequestPager.items,
        message.number,
        { path: message.path, oldPath: message.oldPath, status: message.status }
      );
    } else if (message.type === "pullRequestStackAction") {
      await this.runStackAction(message);
    } else {
      return false;
    }
    return true;
  }

  /** Graph stack chip/detail 버튼을 공개 command로 전달해 Command Palette와 같은 흐름을 재사용한다. */
  private async runStackAction(
    message: Extract<FromWebviewMessage, { type: "pullRequestStackAction" }>
  ): Promise<void> {
    const commands = {
      addLayer: "gitSimpleCompare.addPullRequestStackLayer",
      restack: "gitSimpleCompare.restackPullRequestStack",
      submit: "gitSimpleCompare.submitPullRequestStack",
      advance: "gitSimpleCompare.advancePullRequestStack",
    } as const;
    await vscode.commands.executeCommand(commands[message.action], {
      repoRoot: this.repoRoot,
      branch: message.branch,
      parentBranch: message.action === "addLayer" ? message.branch : undefined,
      parentHash: message.parentHash,
    });
  }

  /** reflog commit window를 표시한 뒤 요청 ID와 함께 검색 결과를 웹뷰에 반환한다. */
  private async showReflogCommit(
    message: Extract<FromWebviewMessage, { type: "showReflogCommit" }>
  ): Promise<void> {
    const hash = await this.deps.loadReflogCommitWindow(message.hash.trim());
    this.deps.post({
      type: "commitVisibility",
      requestId: message.requestId,
      hash,
      found: Boolean(hash),
    });
  }

  /** 검색 결과가 요구한 remote ref를 fetch하고 Graph 새로고침 callback까지 연결한다. */
  private async fetchSearchRefs(
    message: Extract<FromWebviewMessage, { type: "fetchGraphSearchRefs" }>
  ): Promise<void> {
    await fetchRefsForGraphSearch(
      {
        logService: this.deps.logService(),
        post: this.deps.post,
        refreshGraph: this.deps.refreshAfterFetchAction,
      },
      message.requestId,
      message.query,
      message.scope,
      message.target
    );
  }

  /** 일반 checkout/fetch/push 같은 Graph action을 busy 표시와 함께 실행한다. */
  private async handleGitAction(message: GraphActionMessage): Promise<void> {
    const busyKey = actionBusyId(message) ?? GRAPH_BUSY_BUTTON_IDS[message.type];
    const action = () => handleGraphAction(message, {
      logService: this.deps.logService(),
      pullRequests: () => this.pullRequestPager.items,
      refreshCheckout: this.deps.refreshAfterCheckoutAction,
      refreshGraph: this.deps.refreshAfterGraphAction,
      post: this.deps.post,
    });
    await (busyKey ? this.deps.withBusy(busyKey, action) : action());
  }

  /** virtual commit 또는 일반 부모→commit 파일 diff를 연다. */
  private async openFileDiff(
    message: Extract<FromWebviewMessage, { type: "openFileDiff" }>
  ): Promise<void> {
    if (await openGraphVirtualFileDiff(this.repoRoot, message.hash, message.path)) return;
    const base = message.parent && message.parent.length > 0 ? message.parent : EMPTY_TREE;
    await openRefVsRefDiff(this.repoRoot, base, message.hash, message.path);
  }

  /** rebase handler와 session 복원에서 공유하는 현재 패널 의존성을 만든다. */
  private rebaseDeps() {
    return {
      extensionUri: this.deps.extensionUri,
      logService: this.deps.logService(),
      refreshGraph: this.deps.refreshAfterGraphAction,
      post: this.deps.post,
    };
  }
}
