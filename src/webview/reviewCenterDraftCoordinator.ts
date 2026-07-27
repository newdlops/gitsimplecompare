// Review Center의 local/server pending review 초안 상태를 조정하는 coordinator.
// - 웹뷰 panel lifecycle과 GitHub draft mutation을 분리해 다른 review composer도 같은 pending review를 재사용한다.
import * as vscode from "vscode";
import {
  PullRequestReviewDraftService,
  type PendingReviewEvent,
  type PullRequestReviewDraftReconcileResult,
  type PullRequestReviewDraftTarget,
} from "../git/pullRequestReviewDraftService";
import type { ReviewCenterSnapshot } from "../git/pullRequestReviewCenterModel";
import { logError, logInfo } from "../ui/outputLog";

/** draft coordinator가 panel에 전달하는 상태/오류 payload. */
export type ReviewCenterDraftCoordinatorMessage =
  | { type: "draftState"; state: PullRequestReviewDraftReconcileResult }
  | { type: "draftError"; message: string };

/** pending review draft의 host 수명·동시성·저장 정책을 한곳에 모은다. */
export class ReviewCenterDraftCoordinator {
  private controller?: AbortController;
  private state?: PullRequestReviewDraftReconcileResult;

  /**
   * @param drafts local storage와 GitHub pending review를 연결하는 service
   * @param post coordinator 결과를 panel webview로 전달하는 callback
   * @param isAlive panel이 아직 현재 panel인지 확인하는 lifecycle fence
   */
  public constructor(
    private readonly drafts: PullRequestReviewDraftService,
    private readonly post: (message: ReviewCenterDraftCoordinatorMessage) => void,
    private readonly isAlive: () => boolean
  ) {}

  /** 현재 reconciliation 결과를 다른 composer가 pending review id에 연결할 때 제공한다. */
  public getState(): PullRequestReviewDraftReconcileResult | undefined {
    return this.state;
  }

  /** refresh 시작 시 오래된 reconcile 요청을 취소하고 debounce된 local 입력을 보존한다. */
  public async flush(snapshot: ReviewCenterSnapshot | undefined): Promise<void> {
    this.controller?.abort();
    const target = snapshot && reviewDraftTarget(snapshot);
    if (target) await this.drafts.flush(target);
  }

  /** snapshot의 local/server draft 조합을 읽고 최신 panel/snapshot일 때만 결과를 전달한다. */
  public async reconcile(snapshot: ReviewCenterSnapshot): Promise<void> {
    const target = reviewDraftTarget(snapshot);
    if (!target) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const state = await this.drafts.reconcile(target, controller.signal);
      if (!this.isAlive() || this.controller !== controller) return;
      this.state = state;
      this.post({ type: "draftState", state });
      logInfo("review draft reconciled", { number: snapshot.number, kind: state.kind, hasLocal: Boolean(state.local), hasServer: Boolean(state.server) });
    } catch (error) {
      if (!isAbortError(error) && this.isAlive() && this.controller === controller) {
        logError("review draft reconcile failed", error, { number: snapshot.number });
        this.post({ type: "draftError", message: displayError(error) });
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  /** textarea 변경을 debounce local storage에 저장해 네트워크 refresh에도 내용을 잃지 않게 한다. */
  public saveLocal(snapshot: ReviewCenterSnapshot | undefined, body: string, event: PendingReviewEvent): void {
    const target = snapshot && reviewDraftTarget(snapshot);
    if (!snapshot || !target) return;
    try {
      const reviewId = this.state?.local?.reviewId || this.state?.server?.id;
      this.drafts.scheduleSaveLocal(target, { body, event, reviewId });
      logInfo("review draft local save scheduled", { number: snapshot.number, hasReviewId: Boolean(reviewId), bodyLength: body.length, event });
    } catch (error) {
      this.post({ type: "draftError", message: displayError(error) });
    }
  }

  /** 사용자가 명시한 시작 action에서만 pending review를 만들고 local draft와 연결한다. */
  public async start(snapshot: ReviewCenterSnapshot | undefined, body: string, event: PendingReviewEvent): Promise<void> {
    const target = snapshot && reviewDraftTarget(snapshot);
    if (!snapshot || !target) return;
    try {
      const pending = await this.drafts.ensurePending(target, body);
      const local = await this.drafts.saveLocal(target, { body, event, reviewId: pending.id });
      const state: PullRequestReviewDraftReconcileResult = {
        kind: "linked", local, server: pending, bodySource: local.body === pending.body ? "same" : "local",
      };
      if (!this.isAlive()) return;
      this.state = state;
      this.post({ type: "draftState", state });
      logInfo("review draft pending review started", { number: snapshot.number, event, bodyLength: body.length });
    } catch (error) {
      logError("review draft pending review start failed", error, { number: snapshot.number, event, bodyLength: body.length });
      this.post({ type: "draftError", message: displayError(error) });
    }
  }

  /** 사용자 confirmation 뒤 pending server review와 local draft를 함께 폐기한다. */
  public async discard(snapshot: ReviewCenterSnapshot | undefined, reviewId?: string): Promise<void> {
    const target = snapshot && reviewDraftTarget(snapshot);
    if (!snapshot || !target) return;
    try {
      await this.drafts.discard(target, reviewId);
      if (!this.isAlive()) return;
      this.state = { kind: "none" };
      this.post({ type: "draftState", state: this.state });
      logInfo("review draft discarded", { number: snapshot.number, hadServerReview: Boolean(reviewId) });
    } catch (error) {
      logError("review draft discard failed", error, { number: snapshot.number, hadServerReview: Boolean(reviewId) });
      this.post({ type: "draftError", message: displayError(error) });
    }
  }

  /** 최신 pending review id를 다시 확인한 뒤 선택 event로 submit하고 성공시에만 화면 draft를 비운다. */
  public async submit(
    snapshot: ReviewCenterSnapshot | undefined,
    reviewId: string | undefined,
    body: string,
    event: PendingReviewEvent
  ): Promise<boolean> {
    const target = snapshot && reviewDraftTarget(snapshot);
    const pendingId = reviewId?.trim() || this.state?.local?.reviewId || this.state?.server?.id;
    if (!snapshot || !target || !pendingId) {
      this.post({ type: "draftError", message: vscode.l10n.t("A pending pull request review is required before submission.") });
      return false;
    }
    try {
      await this.drafts.submit(target, pendingId, event, body);
      if (!this.isAlive()) return false;
      this.state = { kind: "none" };
      this.post({ type: "draftState", state: this.state });
      logInfo("review draft submitted", { number: snapshot.number, event, bodyLength: body.length });
      return true;
    } catch (error) {
      logError("review draft submit failed", error, { number: snapshot.number, event, bodyLength: body.length });
      this.post({ type: "draftError", message: displayError(error) });
      return false;
    }
  }

  /** refresh가 시작될 때 이전 reconcile 결과가 새 snapshot을 덮지 못하게 취소한다. */
  public abort(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  /** panel dispose에서 stale reconcile controller를 정리한다. */
  public dispose(): void {
    this.abort();
  }
}

/** snapshot의 node id/head OID가 있을 때만 pending review write target을 만든다. */
export function reviewDraftTarget(snapshot: ReviewCenterSnapshot): PullRequestReviewDraftTarget | undefined {
  const pullRequestId = snapshot.pullRequestId?.trim();
  const headOid = snapshot.headOid?.trim();
  return pullRequestId && headOid
    ? { repository: snapshot.repository, number: snapshot.number, pullRequestId, headOid }
    : undefined;
}

/** gh 취소 오류는 panel lifecycle의 정상 stale 상태로 처리한다. */
function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ABORTED";
}

/** stderr 대신 webview에 적합한 단일 오류 문구를 제공한다. */
function displayError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.replace(/\s+/g, " ").slice(0, 320)
    : vscode.l10n.t("Unable to load the pull request review. Check GitHub CLI authentication and try again.");
}
