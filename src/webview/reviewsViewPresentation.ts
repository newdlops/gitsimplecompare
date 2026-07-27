// Reviews provider가 화면에 넘길 안전한 오류 표현과 queue 집계를 분리한다.
// - GitHub 원문 진단을 webview로 보내지 않고, Personal/Management count와 bulk target 변환을 순수하게 유지한다.
import * as vscode from "vscode";
import { ReviewQueueFailure, type ReviewQueueFailureKind } from "../git/pullRequestReviewQueueFailure";
import type { PullRequestManagementBulkTarget } from "../git/pullRequestManagementBulkService";
import type { ReviewQueuePullRequest, ReviewQueueSnapshot } from "../git/pullRequestReviewModel";
import type { ReviewQueueCountProjection } from "./reviewQueueCountCache";

/** Reviews shell이 구분할 수 있는 raw diagnostic 없는 failure 종류. */
export type ReviewsShellFailureKind = ReviewQueueFailureKind | "noRepository";

/** 오류 shell이 복사할 안전한 title 상태와 한 줄 안내 문구. */
export interface ReviewsErrorPresentation {
  kind: ReviewsShellFailureKind;
  message: string;
}

/**
 * typed service 오류를 webview에 안전한 shell 상태로 변환한다.
 * @param error service/cache/transport에서 발생한 원본 오류
 * @returns raw stderr·token을 포함하지 않는 failure 종류와 지역화 문구
 */
export function reviewQueueErrorPresentation(error: unknown): ReviewsErrorPresentation {
  if (error instanceof ReviewQueueFailure) {
    switch (error.kind) {
      case "authRequired":
        return { kind: error.kind, message: vscode.l10n.t("GitHub authentication is required to load pull request reviews. Run gh auth login and retry.") };
      case "permissionDenied":
        return { kind: error.kind, message: vscode.l10n.t("Your GitHub account cannot load this review queue. Check repository or organization permissions.") };
      case "offline":
        return { kind: error.kind, message: vscode.l10n.t("GitHub cannot be reached. Check your network connection and retry.") };
      case "rateLimited":
        return { kind: error.kind, message: vscode.l10n.t("GitHub rate limit reached. Wait before refreshing pull request reviews again.") };
      case "error":
        return { kind: error.kind, message: genericErrorMessage() };
    }
  }
  return { kind: "error", message: genericErrorMessage() };
}

/**
 * Management 목록의 실제 PR만 cross-repository-safe bulk target으로 바꾼다.
 * @param snapshot 현재 queue snapshot
 * @param keys webview가 선택한 key 목록
 * @returns 현재 Management lane에 여전히 존재하는 target 목록
 */
export function selectedReviewQueueBulkTargets(
  snapshot: ReviewQueueSnapshot,
  keys: readonly string[]
): PullRequestManagementBulkTarget[] {
  const allowed = new Map(
    snapshot.management.open.map((pullRequest) => [
      reviewQueuePullRequestKey(snapshot.repository, pullRequest),
      pullRequest,
    ])
  );
  return keys
    .map((key) => allowed.get(key.trim()))
    .filter((pullRequest): pullRequest is ReviewQueuePullRequest => Boolean(pullRequest))
    .map((pullRequest) => ({
      key: reviewQueuePullRequestKey(snapshot.repository, pullRequest),
      repository: pullRequest.repository || snapshot.repository,
      number: pullRequest.number,
    }));
}

/**
 * Personal lane의 중복 PR을 한 번만 세고 Management count는 독립적으로 보존한다.
 * @param snapshot count projection을 만들 queue snapshot
 * @returns cache에 영속화해도 되는 두 first-class scope의 집계
 */
export function reviewQueueCountProjection(
  snapshot: ReviewQueueSnapshot
): ReviewQueueCountProjection {
  const key = (pullRequest: ReviewQueuePullRequest): string =>
    reviewQueuePullRequestKey(snapshot.repository, pullRequest);
  const personal = new Set(
    Object.values(snapshot.personal).flatMap((lane) => lane.map(key))
  );
  const management = new Set(snapshot.management.open.map(key));
  return { personal: personal.size, management: management.size };
}

/** 현재 저장소와 cross-repository PR 모두에 안정적인 key를 만든다. */
function reviewQueuePullRequestKey(
  defaultRepository: string,
  pullRequest: ReviewQueuePullRequest
): string {
  return `${pullRequest.repository || defaultRepository}#${pullRequest.number}`;
}

/** 예상하지 못한 오류가 사용자에게 원문으로 노출되지 않도록 generic 문구를 만든다. */
function genericErrorMessage(): string {
  return vscode.l10n.t("Unable to load pull request reviews. Check GitHub CLI authentication and try again.");
}
