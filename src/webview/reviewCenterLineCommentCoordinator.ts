// Review Center의 line/multi-line pending review comment write 조정기.
// - 파일·anchor 검증은 git mutation service에 위임하고, panel lifecycle과 refresh fence만 관리한다.
import { PullRequestReviewMutationService } from "../git/pullRequestReviewMutationService";
import { composePullRequestReviewSuggestionBody } from "../git/pullRequestReviewSuggestion";
import type { ReviewCenterSnapshot } from "../git/pullRequestReviewCenterModel";
import { logError, logInfo } from "../ui/outputLog";
import { reviewDraftTarget } from "./reviewCenterDraftCoordinator";

/** line comment composer가 host에서 받는 성공/실패 메시지. */
export type ReviewCenterLineCommentCoordinatorMessage =
  | { type: "lineCommentResult"; path: string; line: number }
  | { type: "lineCommentError"; path: string; line: number; message: string };

/** line comment write와 panel lifecycle을 잇는 최소 callback 계약. */
export interface ReviewCenterLineCommentCoordinatorOptions {
  /** renderer에 안전한 결과 메시지를 보낸다. */
  post(message: ReviewCenterLineCommentCoordinatorMessage): void;
  /** GitHub thread를 authoritative snapshot으로 되읽는다. */
  refresh(): Promise<void>;
  /** panel이 dispose되지 않았는지 확인한다. */
  isCurrent(): boolean;
}

/** 한 Review Center에서 line comment 요청을 하나씩 직렬화하는 coordinator. */
export class ReviewCenterLineCommentCoordinator {
  private controller?: AbortController;

  /** mutation service와 panel callback을 연결한다. */
  public constructor(
    private readonly mutations: PullRequestReviewMutationService,
    private readonly options: ReviewCenterLineCommentCoordinatorOptions
  ) {}

  /** 오른쪽(head) side의 single 또는 continuous multi-line comment를 pending review에 넣는다. */
  public async add(
    snapshot: ReviewCenterSnapshot | undefined,
    request: { path: string; line: number; startLine?: number; body: string; suggestion?: string; reviewBody: string }
  ): Promise<void> {
    const target = snapshot && reviewDraftTarget(snapshot);
    const path = request.path.trim();
    if (!snapshot || !target || !path || !snapshot.files.some((file) => file.path === path) || this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const body = composePullRequestReviewSuggestionBody(request.body, request.suggestion);
      const result = await this.mutations.addThread(target, {
        body,
        reviewBody: request.reviewBody,
        location: {
          path,
          subjectType: "LINE",
          side: "RIGHT",
          line: request.line,
          ...(request.startLine ? { startSide: "RIGHT" as const, startLine: request.startLine } : {}),
        },
      }, controller.signal);
      if (!this.isCurrent(controller)) return;
      this.options.post({ type: "lineCommentResult", path, line: request.line });
      logInfo("review center line comment added", { number: snapshot.number, path, line: request.line, startLine: request.startLine, threadId: result.id, reviewId: result.reviewId, bodyLength: body.length, hasSuggestion: Boolean(request.suggestion?.trim()) });
      await this.options.refresh();
    } catch (error) {
      if (!isAbortError(error) && this.isCurrent(controller)) {
        logError("review center line comment failed", error, { number: snapshot.number, path, line: request.line, startLine: request.startLine, bodyLength: request.body.length, hasSuggestion: Boolean(request.suggestion?.trim()) });
        this.options.post({ type: "lineCommentError", path, line: request.line, message: displayError(error) });
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  /** panel 종료 시 진행 중인 gh write를 취소한다. */
  public abort(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  /** 최신 요청과 살아 있는 panel만 renderer 상태를 바꿀 수 있게 한다. */
  private isCurrent(controller: AbortController): boolean {
    return this.options.isCurrent() && this.controller === controller;
  }
}

/** gh runner가 표준화한 취소 오류를 lifecycle 정상 상태로 분류한다. */
function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ABORTED";
}

/** GitHub stderr 대신 composer가 표시 가능한 단일 오류 문구를 만든다. */
function displayError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.replace(/\s+/g, " ").slice(0, 320)
    : "Unable to add the line comment to the pending review. Try again.";
}
