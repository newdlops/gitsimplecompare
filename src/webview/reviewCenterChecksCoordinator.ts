// Review Center Checks 탭의 lazy read와 stale response 방지 조정기.
// - tab이 보일 때만 GitHub check rollup을 요청하고 panel 종료·새 snapshot 뒤 결과를 버린다.
import { PullRequestReviewChecksService, type PullRequestReviewChecksSnapshot } from "../git/pullRequestReviewChecksService";
import type { ReviewCenterSnapshot } from "../git/pullRequestReviewCenterModel";
import { logError, logInfo } from "../ui/outputLog";

/** Checks 탭 renderer가 받는 비동기 결과 메시지. */
export type ReviewCenterChecksCoordinatorMessage =
  | { type: "checksLoaded"; checks: PullRequestReviewChecksSnapshot }
  | { type: "checksError"; message: string };

/** panel lifecycle과 renderer message를 coordinator에 제공하는 callback. */
export interface ReviewCenterChecksCoordinatorOptions {
  /** webview에 lazy read 상태를 안전하게 전달한다. */
  post(message: ReviewCenterChecksCoordinatorMessage): void;
  /** snapshot 교체·dispose 뒤 stale 응답을 버린다. */
  isCurrent(snapshot: ReviewCenterSnapshot): boolean;
}

/** Checks 탭에서 단일 check rollup request만 유지하는 coordinator. */
export class ReviewCenterChecksCoordinator {
  private controller?: AbortController;

  /** check service와 panel lifecycle callback을 연결한다. */
  public constructor(
    private readonly checks: PullRequestReviewChecksService,
    private readonly options: ReviewCenterChecksCoordinatorOptions
  ) {}

  /** 현재 PR snapshot의 latest head All checks를 읽는다. */
  public async load(snapshot: ReviewCenterSnapshot | undefined): Promise<void> {
    if (!snapshot || this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const checks = await this.checks.getSnapshot(snapshot.repository, snapshot.number, snapshot.baseRefName, controller.signal);
      if (!this.isCurrent(snapshot, controller)) return;
      this.options.post({ type: "checksLoaded", checks });
      logInfo("review center checks loaded", { number: snapshot.number, count: checks.checks.length });
    } catch (error) {
      if (!isAbortError(error) && this.isCurrent(snapshot, controller)) {
        logError("review center checks failed", error, { number: snapshot.number });
        this.options.post({ type: "checksError", message: displayError(error) });
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  /** refresh 또는 panel dispose가 진행 중인 check read를 취소한다. */
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
    : "Unable to load pull request checks. Try again.";
}
