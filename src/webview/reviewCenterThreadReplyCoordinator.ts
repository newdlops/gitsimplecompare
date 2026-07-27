// Review Center의 기존 thread 답글 write를 panel lifecycle에서 분리하는 조정기.
// - pending review 재사용과 refresh fence를 한 곳에서 관리해 중복 전송·닫힌 panel 갱신을 막는다.
import { PullRequestReviewMutationService } from "../git/pullRequestReviewMutationService";
import type { ReviewCenterSnapshot } from "../git/pullRequestReviewCenterModel";
import { logError, logInfo } from "../ui/outputLog";
import { reviewDraftTarget } from "./reviewCenterDraftCoordinator";

/** 답글 write의 결과를 renderer로 전달하는 최소 메시지 계약. */
export type ReviewCenterThreadReplyCoordinatorMessage =
  | { type: "threadReplyResult"; threadId: string }
  | { type: "threadReplyError"; threadId: string; message: string };

/** panel이 제공하는 lifecycle callback을 묶어 답글 coordinator 의존성을 작게 유지한다. */
export interface ReviewCenterThreadReplyCoordinatorOptions {
  /** renderer에 안전하게 전달할 상태 메시지 */
  post(message: ReviewCenterThreadReplyCoordinatorMessage): void;
  /** GitHub에서 새 comment를 확인하도록 성공 뒤 실행할 snapshot refresh */
  refresh(): Promise<void>;
  /** panel이 dispose되지 않았는지 확인하는 fence */
  isCurrent(): boolean;
}

/** 하나의 Center panel에서 동시에 하나만 실행되는 기존 thread 답글 write 조정기. */
export class ReviewCenterThreadReplyCoordinator {
  private controller?: AbortController;

  /** mutation service와 panel lifecycle callback을 연결한다. */
  public constructor(
    private readonly mutations: PullRequestReviewMutationService,
    private readonly options: ReviewCenterThreadReplyCoordinatorOptions
  ) {}

  /** 현재 snapshot의 thread에 답글을 pending review comment로 추가한다. */
  public async reply(snapshot: ReviewCenterSnapshot | undefined, threadId: string, body: string, reviewBody: string): Promise<void> {
    const target = snapshot && reviewDraftTarget(snapshot);
    const normalizedThreadId = threadId.trim();
    if (!snapshot || !target || !normalizedThreadId || !snapshot.threads.some((thread) => thread.id === normalizedThreadId) || this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const result = await this.mutations.addReply(target, normalizedThreadId, body, reviewBody, controller.signal);
      if (!this.isCurrent(controller)) return;
      this.options.post({ type: "threadReplyResult", threadId: normalizedThreadId });
      logInfo("review center thread reply added", { number: snapshot.number, threadId: normalizedThreadId, commentId: result.id, reviewId: result.reviewId, bodyLength: body.length });
      await this.options.refresh();
    } catch (error) {
      if (!isAbortError(error) && this.isCurrent(controller)) {
        logError("review center thread reply failed", error, { number: snapshot.number, threadId: normalizedThreadId, bodyLength: body.length });
        this.options.post({ type: "threadReplyError", threadId: normalizedThreadId, message: displayError(error) });
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  /** panel 종료 또는 refresh lifecycle에서 진행 중인 gh 요청을 중단한다. */
  public abort(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  /** 답글 요청이 이 coordinator의 최신 요청이며 panel이 살아 있는지 확인한다. */
  private isCurrent(controller: AbortController): boolean {
    return this.options.isCurrent() && this.controller === controller;
  }
}

/** gh runner의 취소 오류는 panel lifecycle에서 정상적인 stale 상태다. */
function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ABORTED";
}

/** renderer에는 stderr 대신 한 줄짜리 사용 가능 오류만 전달한다. */
function displayError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.replace(/\s+/g, " ").slice(0, 320)
    : "Unable to add the reply to the pending review. Try again.";
}
