// Review Center의 본인 comment 수정·삭제 write를 panel lifecycle에서 분리하는 조정기.
// - UI 노출 외에도 host에서 viewer ownership을 재검사해 조작된 웹뷰 메시지를 차단한다.
import { PullRequestReviewMutationService } from "../git/pullRequestReviewMutationService";
import type { ReviewCenterSnapshot } from "../git/pullRequestReviewCenterModel";
import { logError, logInfo } from "../ui/outputLog";

/** comment mutation 결과를 renderer로 전달하는 최소 메시지 계약. */
export type ReviewCenterCommentCoordinatorMessage =
  | { type: "commentMutationResult"; action: "updated" | "deleted"; commentId: string }
  | { type: "commentMutationError"; action: "updated" | "deleted"; commentId: string; message: string };

/** panel lifecycle callback을 coordinator 의존성으로 묶는다. */
export interface ReviewCenterCommentCoordinatorOptions {
  /** renderer로 보낼 결과 메시지 */
  post(message: ReviewCenterCommentCoordinatorMessage): void;
  /** GitHub의 post-write 상태를 다시 읽는 성공 후 refresh */
  refresh(): Promise<void>;
  /** panel이 아직 살아 있는지 확인하는 fence */
  isCurrent(): boolean;
}

/** 하나의 Center panel에서 본인 comment mutation 하나만 직렬 실행하는 coordinator. */
export class ReviewCenterCommentCoordinator {
  private controller?: AbortController;

  /** mutation service와 panel lifecycle callback을 연결한다. */
  public constructor(
    private readonly mutations: PullRequestReviewMutationService,
    private readonly options: ReviewCenterCommentCoordinatorOptions
  ) {}

  /** viewer가 작성한 comment만 수정하고 성공 뒤 서버 snapshot으로 확정한다. */
  public async update(snapshot: ReviewCenterSnapshot | undefined, commentId: string, body: string): Promise<void> {
    await this.mutate(snapshot, commentId, "updated", (id, signal) => this.mutations.updateComment(id, body, signal), body.length);
  }

  /** viewer가 작성한 comment만 삭제하고 성공 뒤 서버 snapshot으로 확정한다. */
  public async delete(snapshot: ReviewCenterSnapshot | undefined, commentId: string): Promise<void> {
    await this.mutate(snapshot, commentId, "deleted", (id, signal) => this.mutations.deleteComment(id, signal));
  }

  /** panel 종료 또는 refresh lifecycle에서 진행 중인 gh 요청을 중단한다. */
  public abort(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  /** viewer ownership을 재검사한 뒤 update/delete 공통 lifecycle을 실행한다. */
  private async mutate(
    snapshot: ReviewCenterSnapshot | undefined,
    commentId: string,
    action: "updated" | "deleted",
    run: (id: string, signal: AbortSignal) => Promise<void>,
    bodyLength?: number
  ): Promise<void> {
    const id = commentId.trim();
    const comment = snapshot?.threads.flatMap((thread) => thread.comments).find((item) => item.id === id);
    if (!snapshot || !id || !comment || !snapshot.viewer || comment.author !== snapshot.viewer || this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      await run(id, controller.signal);
      if (!this.isCurrent(controller)) return;
      this.options.post({ type: "commentMutationResult", action, commentId: id });
      logInfo(`review center comment ${action}`, { number: snapshot.number, commentId: id, bodyLength });
      await this.options.refresh();
    } catch (error) {
      if (!isAbortError(error) && this.isCurrent(controller)) {
        logError(`review center comment ${action} failed`, error, { number: snapshot.number, commentId: id, bodyLength });
        this.options.post({ type: "commentMutationError", action, commentId: id, message: displayError(error) });
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  /** 이 coordinator의 최신 요청이며 panel이 살아 있는지 확인한다. */
  private isCurrent(controller: AbortController): boolean {
    return this.options.isCurrent() && this.controller === controller;
  }
}

/** gh 취소 오류는 panel lifecycle에서 정상적인 stale 상태다. */
function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ABORTED";
}

/** renderer에는 stderr 대신 한 줄짜리 사용 가능 오류만 전달한다. */
function displayError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.replace(/\s+/g, " ").slice(0, 320)
    : "Unable to update the review comment. Try again.";
}
