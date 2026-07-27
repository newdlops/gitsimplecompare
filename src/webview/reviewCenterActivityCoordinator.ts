// Review Center Activity 탭의 lazy read와 stale response 방지 조정기.
// - PR 상세 snapshot을 불필요하게 무겁게 만들지 않고, 탭이 열릴 때만 timeline 데이터를 읽는다.
import { PullRequestReviewCenterService } from "../git/pullRequestReviewCenterService";
import type { ReviewCenterActivityPage } from "../git/pullRequestReviewActivityModel";
import type { ReviewCenterSnapshot } from "../git/pullRequestReviewCenterModel";
import { logError, logInfo } from "../ui/outputLog";

/** Activity renderer가 받는 지연 조회 결과 메시지. */
export type ReviewCenterActivityCoordinatorMessage =
  | { type: "activityLoaded"; activity: ReviewCenterActivityPage }
  | { type: "activityError"; message: string };

/** panel lifecycle과 renderer 전달 경계를 coordinator에 제공한다. */
export interface ReviewCenterActivityCoordinatorOptions {
  /** webview에 현재 PR의 activity 결과를 안전하게 전달한다. */
  post(message: ReviewCenterActivityCoordinatorMessage): void;
  /** refresh·dispose·PR 교체 뒤 응답을 폐기하는 snapshot identity 확인기 */
  isCurrent(snapshot: ReviewCenterSnapshot): boolean;
}

/** Activity 탭에서 동시에 하나의 first-page 요청만 유지하는 coordinator. */
export class ReviewCenterActivityCoordinator {
  private controller?: AbortController;

  /** activity query service와 panel lifecycle callback을 연결한다. */
  public constructor(
    private readonly center: PullRequestReviewCenterService,
    private readonly options: ReviewCenterActivityCoordinatorOptions
  ) {}

  /** 현재 PR snapshot의 activity 첫 페이지를 lazy로 읽는다. */
  public async load(snapshot: ReviewCenterSnapshot | undefined): Promise<void> {
    if (!snapshot || this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const activity = await this.center.getActivityPage(snapshot.repository, snapshot.number, { signal: controller.signal });
      if (!this.isCurrent(snapshot, controller)) return;
      this.options.post({ type: "activityLoaded", activity });
      logInfo("review center activity loaded", { number: snapshot.number, count: activity.items.length, truncated: activity.truncated });
    } catch (error) {
      if (!isAbortError(error) && this.isCurrent(snapshot, controller)) {
        logError("review center activity failed", error, { number: snapshot.number });
        this.options.post({ type: "activityError", message: displayError(error) });
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  /** refresh 또는 panel dispose가 진행 중인 activity 요청을 취소한다. */
  public abort(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  /** controller와 snapshot identity가 모두 현재 요청과 일치하는지 확인한다. */
  private isCurrent(snapshot: ReviewCenterSnapshot, controller: AbortController): boolean {
    return this.controller === controller && this.options.isCurrent(snapshot);
  }
}

/** gh 취소 오류는 새 snapshot으로 전환할 때의 정상 stale 경로다. */
function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ABORTED";
}

/** GitHub stderr 세부 내용 대신 재시도 가능한 한 줄 메시지를 만든다. */
function displayError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.replace(/\s+/g, " ").slice(0, 320)
    : "Unable to load pull request activity. Try again.";
}
