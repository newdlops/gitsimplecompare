// Review Center의 file-level comment write를 panel lifecycle에서 분리하는 조정기.
// - pending review 재사용과 refresh fence를 한 곳에서 관리해 중복 전송·닫힌 panel 갱신을 막는다.
import { PullRequestReviewMutationService } from "../git/pullRequestReviewMutationService";
import type { ReviewCenterSnapshot } from "../git/pullRequestReviewCenterModel";
import { logError, logInfo } from "../ui/outputLog";
import { reviewDraftTarget } from "./reviewCenterDraftCoordinator";

/** file comment write 결과를 renderer로 전달하는 최소 메시지 계약. */
export type ReviewCenterFileCommentCoordinatorMessage =
  | { type: "fileCommentResult"; path: string }
  | { type: "fileCommentError"; path: string; message: string };

/** panel lifecycle callback을 coordinator 의존성으로 묶는다. */
export interface ReviewCenterFileCommentCoordinatorOptions {
  /** renderer로 보낼 결과 메시지 */
  post(message: ReviewCenterFileCommentCoordinatorMessage): void;
  /** GitHub에서 새 thread를 재확인할 성공 후 snapshot refresh */
  refresh(): Promise<void>;
  /** panel이 아직 살아 있는지 확인하는 fence */
  isCurrent(): boolean;
}

/** 하나의 Center panel에서 file comment 하나만 직렬 실행하는 coordinator. */
export class ReviewCenterFileCommentCoordinator {
  private controller?: AbortController;

  /** mutation service와 panel lifecycle callback을 연결한다. */
  public constructor(
    private readonly mutations: PullRequestReviewMutationService,
    private readonly options: ReviewCenterFileCommentCoordinatorOptions
  ) {}

  /** 현재 snapshot의 changed file 전체에 붙는 comment를 pending review에 추가한다. */
  public async add(snapshot: ReviewCenterSnapshot | undefined, path: string, body: string, reviewBody: string): Promise<void> {
    const target = snapshot && reviewDraftTarget(snapshot);
    const normalizedPath = path.trim();
    if (!snapshot || !target || !normalizedPath || !snapshot.files.some((file) => file.path === normalizedPath) || this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const result = await this.mutations.addThread(
        target,
        { body, location: { path: normalizedPath, subjectType: "FILE" }, reviewBody },
        controller.signal
      );
      if (!this.isCurrent(controller)) return;
      this.options.post({ type: "fileCommentResult", path: normalizedPath });
      logInfo("review center file comment added", { number: snapshot.number, path: normalizedPath, threadId: result.id, reviewId: result.reviewId, bodyLength: body.length });
      await this.options.refresh();
    } catch (error) {
      if (!isAbortError(error) && this.isCurrent(controller)) {
        logError("review center file comment failed", error, { number: snapshot.number, path: normalizedPath, bodyLength: body.length });
        this.options.post({ type: "fileCommentError", path: normalizedPath, message: displayError(error) });
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
    : "Unable to add the file comment to the pending review. Try again.";
}
