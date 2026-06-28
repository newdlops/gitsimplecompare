// PR comment 표시용 진단 값과 GitHub 웹 세션 안내 조건을 계산한다.
// - VS Code comment thread 표시 책임과 로그/인증 안내 판별 책임을 분리해 controller 를 작게 유지한다.
import type { PullRequestReviewComment } from "../git/pullRequestReviewComments";
import type { PullRequestSuggestedChangesetStatus } from "../git/pullRequestSuggestedChangesets";

/**
 * GitHub review comment 에 실제로 붙어서 렌더링 가능한 suggested changeset 수를 센다.
 * @param comments GitHub review comment 목록
 * @returns comment.suggestedChangesets 배열에 들어 있는 실제 changeset 수
 */
export function countAttachedSuggestedChangesets(
  comments: PullRequestReviewComment[]
): number {
  return comments.reduce(
    (sum, comment) => sum + (comment.suggestedChangesets?.length || 0),
    0
  );
}

/**
 * GitHub body/body_html 에 suggestion 관련 흔적이 있는 comment 수를 센다.
 * - 실제 렌더링 가능한 changeset 이 아니라 진단용 힌트라서 suggestedChangesets 와 분리한다.
 * @param comments GitHub review comment 목록
 * @returns suggestion hint 가 있는 comment 수
 */
export function countBodySuggestedChangeHints(
  comments: PullRequestReviewComment[]
): number {
  return comments.filter(hasBodySuggestedChangeset).length;
}

/**
 * 실제 suggested changeset 이 붙은 comment id 를 로그용으로 모은다.
 * @param comments GitHub review comment 목록
 * @returns changeset 이 붙은 comment id 배열
 */
export function suggestedCommentIds(
  comments: PullRequestReviewComment[]
): string[] {
  return comments
    .filter((comment) => (comment.suggestedChangesets?.length || 0) > 0)
    .map((comment) => comment.id)
    .slice(0, 20);
}

/**
 * GitHub review comment 본문에 일반 fenced code snippet 이 있는지 판별한다.
 * - code block 이 섞인 comment 가 잘리는 문제를 재현할 때 OUTPUT 로그로 확인하기 위함이다.
 * @param comment GitHub review comment
 * @returns 일반 code fence 가 있으면 true
 */
export function hasCodeFence(comment: PullRequestReviewComment): boolean {
  return /(^|\n)[ \t]*(`{3,}|~{3,})(?!\s*suggestion\b)/i.test(comment.body || "");
}

/**
 * suggested changeset 조회 실패가 GitHub 웹 세션 설정으로 해결 가능한지 판단한다.
 * @param status suggested changeset 보조 조회 상태
 * @param webCookie SecretStorage 에 저장된 GitHub 웹 Cookie 헤더
 * @returns 자동 안내를 열 이유. 안내가 필요 없으면 undefined
 */
export function gitHubWebSessionFlowReason(
  status: PullRequestSuggestedChangesetStatus | undefined,
  webCookie: string | undefined
): "missingCookie" | "rejectedCookie" | undefined {
  if (!status?.attempted || status.source) {
    return undefined;
  }
  const reason = status.reason || "";
  if (!webCookie && /stored-web-cookie:\s*not set/i.test(reason)) {
    return "missingCookie";
  }
  if (webCookie && isStoredGitHubWebCookieRejected(reason)) {
    return "rejectedCookie";
  }
  return undefined;
}

/**
 * GitHub review comment 본문에 suggested changeset 후보가 있는지 빠르게 판별한다.
 * - 실제 렌더링 파서는 ui 모듈에 두고, 여기서는 OUTPUT 진단용 count 만 계산한다.
 * @param comment GitHub review comment
 * @returns suggestion 관련 흔적이 있으면 true
 */
function hasBodySuggestedChangeset(comment: PullRequestReviewComment): boolean {
  return /(^|\n)[ \t]*(`{3,}|~{3,})\s*suggestion/i.test(comment.body || "")
    || /suggest(?:ed)?[-_ ]?changeset|suggest(?:ed)?[-_ ]?change|js-suggest/i.test(comment.bodyHtml || "");
}

/**
 * 저장된 GitHub 웹 Cookie 가 인증된 HTML 을 돌려주지 못한 실패인지 확인한다.
 * @param reason suggested changeset 조회 실패 이유 문자열
 * @returns 저장 쿠키 재설정이 필요해 보이면 true
 */
function isStoredGitHubWebCookieRejected(reason: string): boolean {
  const match = /stored-web-cookie:\s*([^;]+)/i.exec(reason);
  if (!match) {
    return false;
  }
  return /\bstatus\s*(?:30[12378]|401|403|404)\b|redirect|login|not GitHub HTML|not HTML/i.test(match[1]);
}
