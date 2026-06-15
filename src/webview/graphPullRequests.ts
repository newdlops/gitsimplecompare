// git graph 웹뷰의 PR 관련 메시지 처리를 돕는 모듈.
// - graphPanel 이 패널 수명주기와 그래프 로딩에 집중하도록 PR 조회/열기/preview 동작을 분리한다.
import * as vscode from "vscode";
import { LocalBranchStatus } from "../graph/graphTypes";
import { PullRequestInfo, PullRequestService } from "../git/pullRequestService";
import { logError, logInfo } from "../ui/outputLog";
import { PullRequestPreviewPanel } from "./pullRequestPreviewPanel";
import { ToWebviewMessage } from "./graphProtocol";

type PostGraphMessage = (message: ToWebviewMessage) => void;

/**
 * GitHub PR overview 를 읽어 웹뷰에 보낸다.
 * @param repoRoot      대상 저장소 루트
 * @param localBranches 현재 로컬 브랜치 상태
 * @param reason        OUTPUT 로그에 남길 조회 원인
 * @param post          graph 웹뷰 메시지 전송 함수
 * @returns 다음 open/preview 동작에서 재사용할 PR 목록
 */
export async function sendGraphPullRequests(
  repoRoot: string,
  localBranches: LocalBranchStatus[],
  reason: string,
  post: PostGraphMessage
): Promise<PullRequestInfo[]> {
  const service = new PullRequestService(repoRoot);
  const overview = await service.getOverview(localBranches);
  post({ type: "pullRequestOverview", overview });
  logInfo("graph pull request overview sent", {
    repoRoot,
    reason,
    available: overview.available,
    count: overview.pullRequests.length,
  });
  return overview.pullRequests;
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
  repoRoot: string,
  pullRequests: PullRequestInfo[],
  number?: number
): void {
  const pr = pullRequests.find((item) => item.number === number);
  PullRequestPreviewPanel.createOrShow(
    new PullRequestService(repoRoot),
    pr?.baseRefName,
    pr
  );
}
