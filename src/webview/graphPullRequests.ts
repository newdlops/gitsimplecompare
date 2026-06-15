// git graph 웹뷰의 PR 관련 메시지 처리를 돕는 모듈.
// - graphPanel 이 패널 수명주기와 그래프 로딩에 집중하도록 PR 조회/열기/preview 동작을 분리한다.
import * as vscode from "vscode";
import { LocalBranchStatus } from "../graph/graphTypes";
import { PullRequestInfo, PullRequestService } from "../git/pullRequestService";
import { logError, logInfo } from "../ui/outputLog";
import { PullRequestPreviewPanel } from "./pullRequestPreviewPanel";
import { ToWebviewMessage } from "./graphProtocol";

type PostGraphMessage = (message: ToWebviewMessage) => void;

/** graph PR 목록의 cursor/누적 상태를 관리한다. */
export class GraphPullRequestPager {
  private pullRequests: PullRequestInfo[] = [];
  private nextCursor: string | undefined;
  private hasMore = false;
  private loading = false;

  /** open/preview 동작에서 사용할 현재 누적 PR 목록을 반환한다. */
  get items(): PullRequestInfo[] {
    return this.pullRequests;
  }

  /**
   * PR 목록을 첫 페이지부터 다시 읽고 기존 누적 상태를 교체한다.
   * @param repoRoot      대상 저장소 루트
   * @param localBranches 현재 로컬 브랜치 상태
   * @param reason        OUTPUT 로그에 남길 조회 원인
   * @param post          graph 웹뷰 메시지 전송 함수
   */
  async refresh(
    repoRoot: string,
    localBranches: LocalBranchStatus[],
    reason: string,
    post: PostGraphMessage
  ): Promise<void> {
    this.pullRequests = [];
    this.nextCursor = undefined;
    this.hasMore = false;
    await this.fetchPage(repoRoot, localBranches, reason, post, undefined);
  }

  /**
   * 다음 PR 페이지가 있으면 이어 읽어 기존 목록 뒤에 붙인다.
   * @param repoRoot      대상 저장소 루트
   * @param localBranches 현재 로컬 브랜치 상태
   * @param post          graph 웹뷰 메시지 전송 함수
   */
  async loadMore(
    repoRoot: string,
    localBranches: LocalBranchStatus[],
    post: PostGraphMessage
  ): Promise<void> {
    if (this.loading || !this.hasMore || !this.nextCursor) {
      return;
    }
    await this.fetchPage(repoRoot, localBranches, "loadMore", post, this.nextCursor);
  }

  /**
   * GitHub PR 한 페이지를 읽고 누적 목록/커서를 갱신해 웹뷰에 보낸다.
   * @param repoRoot      대상 저장소 루트
   * @param localBranches 현재 로컬 브랜치 상태
   * @param reason        OUTPUT 로그에 남길 조회 원인
   * @param post          graph 웹뷰 메시지 전송 함수
   * @param cursor        이어 읽을 GitHub GraphQL cursor
   */
  private async fetchPage(
    repoRoot: string,
    localBranches: LocalBranchStatus[],
    reason: string,
    post: PostGraphMessage,
    cursor: string | undefined
  ): Promise<void> {
    this.loading = true;
    try {
      const service = new PullRequestService(repoRoot);
      const overview = await service.getOverview(localBranches, cursor);
      this.pullRequests = overview.available
        ? mergePullRequests(this.pullRequests, overview.pullRequests)
        : this.pullRequests;
      this.nextCursor = overview.available ? overview.nextCursor : this.nextCursor;
      this.hasMore = overview.available ? overview.hasMore : this.hasMore;
      post({ type: "pullRequestOverview", overview: { ...overview, pullRequests: this.pullRequests, hasMore: this.hasMore, nextCursor: this.nextCursor } });
      logInfo("graph pull request overview sent", {
        repoRoot,
        reason,
        available: overview.available,
        pageCount: overview.pullRequests.length,
        totalCount: this.pullRequests.length,
        hasMore: this.hasMore,
      });
    } finally {
      this.loading = false;
    }
  }
}

/**
 * PR 상세 drawer 용 changed files 데이터를 읽어 웹뷰에 보낸다.
 * @param repoRoot 대상 저장소 루트
 * @param number   조회할 PR 번호
 * @param post     graph 웹뷰 메시지 전송 함수
 */
export async function sendGraphPullRequestDetail(
  repoRoot: string,
  number: number,
  post: PostGraphMessage
): Promise<void> {
  const service = new PullRequestService(repoRoot);
  try {
    const detail = await service.getDetail(number);
    post({ type: "pullRequestDetail", number, detail });
    logInfo("graph pull request detail sent", {
      repoRoot,
      number,
      files: detail.files.length,
      fileCommentCount: detail.fileCommentCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError("graph pull request detail failed", error, { repoRoot, number });
    post({ type: "pullRequestDetailError", number, message });
  }
}

/**
 * PR 번호에 해당하는 URL 을 브라우저에서 연다.
 * @param pullRequests 마지막으로 조회한 PR 목록
 * @param number       열 PR 번호
 */
export async function openGraphPullRequest(
  pullRequests: PullRequestInfo[],
  number: number
): Promise<void> {
  const pr = pullRequests.find((item) => item.number === number);
  if (!pr?.url) {
    vscode.window.showWarningMessage(vscode.l10n.t("Pull request URL is not available."));
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(pr.url));
}

/**
 * staged 상태를 PR 로 만든다고 가정한 preview 패널을 연다.
 * @param repoRoot      대상 저장소 루트
 * @param pullRequests 마지막으로 조회한 PR 목록
 * @param number        기존 PR 기준으로 열 경우의 PR 번호
 */
export function openStagedPullRequestPreview(
  extensionUri: vscode.Uri,
  repoRoot: string,
  pullRequests: PullRequestInfo[],
  number?: number
): void {
  const pr = pullRequests.find((item) => item.number === number);
  PullRequestPreviewPanel.createOrShow(
    extensionUri,
    new PullRequestService(repoRoot),
    pr?.baseRefName,
    pr
  );
}

/** PR 번호 기준으로 중복 없이 기존 목록 뒤에 새 페이지를 붙인다. */
function mergePullRequests(
  previous: PullRequestInfo[],
  next: PullRequestInfo[]
): PullRequestInfo[] {
  const byNumber = new Map<number, PullRequestInfo>();
  for (const pr of previous) {
    byNumber.set(pr.number, pr);
  }
  for (const pr of next) {
    byNumber.set(pr.number, pr);
  }
  return Array.from(byNumber.values());
}
