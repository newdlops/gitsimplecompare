// Review Center Commits 탭의 lazy read와 stale response 방지 조정기.
// - 탭을 열었을 때만 첫 commit page를 요청하고 panel 종료·새 snapshot 뒤 응답을 버린다.
import { PullRequestReviewCenterService } from "../git/pullRequestReviewCenterService";
import type { ReviewCenterCommitsPage, ReviewCenterSnapshot } from "../git/pullRequestReviewCenterModel";
import { logError, logInfo } from "../ui/outputLog";

/** Commits 탭 renderer가 받는 비동기 결과 메시지. */
export type ReviewCenterCommitsCoordinatorMessage =
  | { type: "commitsLoaded"; commits: ReviewCenterCommitsPage }
  | { type: "commitsError"; message: string };

/** panel lifecycle과 renderer message를 coordinator에 제공하는 callback. */
export interface ReviewCenterCommitsCoordinatorOptions {
  /** webview에 lazy read 결과를 안전하게 전달한다. */
  post(message: ReviewCenterCommitsCoordinatorMessage): void;
  /** snapshot 교체·dispose 뒤 stale 응답을 버린다. */
  isCurrent(snapshot: ReviewCenterSnapshot): boolean;
}

/** Commits 탭에서 단일 첫-page request만 유지하는 coordinator. */
export class ReviewCenterCommitsCoordinator {
  private controller?: AbortController;

  /** center read service와 panel lifecycle callback을 연결한다. */
  public constructor(
    private readonly center: PullRequestReviewCenterService,
    private readonly options: ReviewCenterCommitsCoordinatorOptions
  ) {}

  /** 현재 PR snapshot의 commit 첫 페이지를 lazy로 읽는다. */
  public async load(snapshot: ReviewCenterSnapshot | undefined): Promise<void> {
    if (!snapshot || this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const commits = await this.center.getCommitsPage(snapshot.repository, snapshot.number, { signal: controller.signal });
      if (!this.isCurrent(snapshot, controller)) return;
      this.options.post({ type: "commitsLoaded", commits });
      logInfo("review center commits loaded", { number: snapshot.number, count: commits.commits.length, truncated: commits.hasNextPage });
    } catch (error) {
      if (!isAbortError(error) && this.isCurrent(snapshot, controller)) {
        logError("review center commits failed", error, { number: snapshot.number });
        this.options.post({ type: "commitsError", message: displayError(error) });
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  /** refresh 또는 panel dispose가 진행 중인 commit read를 취소한다. */
  public abort(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  /** coordinator 최신 요청인지와 snapshot identity를 함께 확인한다. */
  private isCurrent(snapshot: ReviewCenterSnapshot, controller: AbortController): boolean {
    return this.controller === controller && this.options.isCurrent(snapshot);
  }
}

/** gh runner cancellation은 stale lifecycle의 정상 경로다. */
function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ABORTED";
}

/** renderer에는 token/error payload 대신 한 줄짜리 재시도 문구만 전달한다. */
function displayError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.replace(/\s+/g, " ").slice(0, 320)
    : "Unable to load pull request commits. Try again.";
}
