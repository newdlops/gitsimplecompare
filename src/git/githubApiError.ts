// HTTP 상태·GraphQL 실패를 비밀 출력 없이 전달하고 필요한 부분 결과만 내부적으로 보관한다.
export type GitHubApiErrorKind = "auth" | "permission" | "rate-limit" | "http" | "graphql" | "network" | "limit" | "redirect" | "timeout";
const results = new WeakMap<Error, unknown>();
const messages: Record<GitHubApiErrorKind, string> = {
  auth: "GitHub authentication failed. Run gh auth login and refresh.",
  permission: "GitHub denied this read. Check repository access and refresh.",
  "rate-limit": "GitHub rate limit reached. Wait before refreshing.",
  http: "GitHub read failed. Refresh to try again.",
  graphql: "GitHub returned incomplete data. Refresh to try again.",
  network: "GitHub connection failed. Refresh to try again.",
  limit: "GitHub response exceeded the size limit.",
  redirect: "GitHub redirected this read to an unsupported destination.",
  timeout: "GitHub query timed out. Refresh to try again.",
};
let localize = (message: string): string => message;

/** UI composition이 런타임 번역을 주입한다. 이전 disposer는 새 번역 함수를 해제하지 않는다. */
export function setGitHubApiErrorLocalizer(next: (message: string) => string): () => void {
  const previous = localize; localize = next;
  return () => { if (localize === next) localize = previous; };
}

/** 안전한 operation·상태·재시도 시각만 직렬화하며 원문·헤더·토큰·cause는 보관하지 않는다. */
export class GitHubApiError extends Error {
  constructor(public readonly kind: GitHubApiErrorKind, public readonly operation: string,
    public readonly status?: number, public readonly retryAt?: number, result?: unknown,
    public readonly reason?: "missing-commit") {
    super(localize(messages[kind]));
    this.name = "GitHubApiError";
    if (result !== undefined) results.set(this, result);
  }
}

/** 예상한 alias의 null/NOT_FOUND를 확인하는 서비스에만 구조화된 부분 응답을 제공한다. */
export function graphQLResult(error: unknown): unknown {
  return error instanceof Error ? results.get(error) : undefined;
}
