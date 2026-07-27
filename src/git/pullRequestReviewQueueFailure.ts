// GitHub CLI의 다양한 실패를 Reviews shell이 소비할 typed failure로 정규화한다.
// - raw stderr·token·response body를 webview에 보내지 않고 auth/permission/offline/rate-limit의 UX 결정을 서비스 경계에서 끝낸다.
import { GhCliError } from "./ghCli";
import { GhJsonError } from "./ghRunner";

/** Reviews가 사용자에게 서로 다르게 안내해야 하는 안전한 failure 분류. */
export type ReviewQueueFailureKind =
  | "authRequired"
  | "permissionDenied"
  | "offline"
  | "rateLimited"
  | "error";

/** shell이 raw GitHub diagnostic 없이 kind만 신뢰하도록 만드는 domain error. */
export class ReviewQueueFailure extends Error {
  /**
   * @param kind shell의 state/copy/action을 고르는 안정된 failure 분류
   * @param cause 원본 오류. 로그 경로에서만 관찰하고 webview에는 보내지 않는다.
   */
  public constructor(
    public readonly kind: ReviewQueueFailureKind,
    public readonly cause: unknown
  ) {
    super(`Review queue ${kind}.`);
    this.name = "ReviewQueueFailure";
  }
}

/** 취소된 refresh인지 확인해 typed user failure로 바꾸지 않는다. */
export function isReviewQueueAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "code" in error
    && ((error as { code?: unknown }).code === "ABORTED"
      || (error as { code?: unknown }).code === "ABORT_ERR");
}

/** unknown GitHub CLI 오류를 안전한 Reviews shell failure로 변환한다. */
export function toReviewQueueFailure(error: unknown): ReviewQueueFailure {
  if (error instanceof ReviewQueueFailure) return error;
  const detail = errorDiagnostic(error);
  if (isAuthenticationFailure(detail)) return new ReviewQueueFailure("authRequired", error);
  if (isRateLimitFailure(detail)) return new ReviewQueueFailure("rateLimited", error);
  if (isPermissionFailure(detail)) return new ReviewQueueFailure("permissionDenied", error);
  if (isOfflineFailure(error, detail)) return new ReviewQueueFailure("offline", error);
  return new ReviewQueueFailure("error", error);
}

/** GhCliError의 redacted diagnostic만 우선 사용하고 나머지는 짧은 error message로 제한한다. */
function errorDiagnostic(error: unknown): string {
  if (error instanceof GhCliError) return `${error.message}\n${error.stderr}`.toLowerCase();
  if (error instanceof GhJsonError) return "invalid-json";
  return error instanceof Error ? error.message.toLowerCase() : "";
}

/** login prompt·401·revoked credential을 명시적 인증 필요 상태로 분류한다. */
function isAuthenticationFailure(detail: string): boolean {
  return /\b401\b|bad credentials|gh auth login|not logged in|not authenticated|authentication required|must authenticate|token revoked/i.test(detail);
}

/** GitHub의 rate limit diagnostic을 permission 오류보다 먼저 분류한다. */
function isRateLimitFailure(detail: string): boolean {
  return /rate limit|secondary rate limit|api rate limit exceeded|\b429\b/i.test(detail);
}

/** 명시적 scope/접근 금지 403만 permission 상태로 보며 generic 403은 error로 남긴다. */
function isPermissionFailure(detail: string): boolean {
  return /resource not accessible by integration|requires .* scope|insufficient.*scope|permission denied|forbidden.*scope/i.test(detail);
}

/** DNS, connection reset, timeout 등 transport 계열 오류만 offline 상태로 바꾼다. */
function isOfflineFailure(error: unknown, detail: string): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(String(code))
    || /network is unreachable|network.*error|connection (reset|refused)|could not resolve host|dns|timed? out/i.test(detail);
}
