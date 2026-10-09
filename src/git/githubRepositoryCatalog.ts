// GitHub 온보딩에서 접근 가능한 저장소를 조회하는 read-only 서비스.
// - OAuth session은 UI가 제공하며 Git·gh·VS Code 기본 Git API에 의존하지 않는다.
export interface GitHubCloneRepository {
  nameWithOwner: string;
  cloneUrl: string;
  description: string;
  isPrivate: boolean;
  archived: boolean;
}
export interface GitHubRepositoryPage {
  repositories: GitHubCloneRepository[];
  nextPage?: number;
}
export type RepositoryCatalogFetch = (url: string, options: RequestInit) => Promise<
  Pick<Response, "ok" | "status" | "headers" | "json">
>;
export type RepositoryCatalogErrorKind = "authentication" | "rate-limit" | "http" | "invalid-data" | "cancelled" | "network";

/** 요청 본문이나 token을 오류·OUTPUT에 넣지 않는 GitHub 조회 오류다. */
export class RepositoryCatalogError extends Error {
  constructor(public readonly kind: RepositoryCatalogErrorKind, public readonly status?: number) {
    super(kind === "authentication" ? "GitHub authentication is required. Sign in and try again."
      : kind === "rate-limit" ? "GitHub request limit reached. Try again later or clone by URL."
      : kind === "cancelled" ? "GitHub repository loading was cancelled."
      : "Could not load GitHub repositories. Try again or clone by URL.");
    this.name = "RepositoryCatalogError";
  }
}

/**
 * 응답의 저장소 식별자만 신뢰하고 clone 주소는 GitHub HTTPS 주소로 직접 구성한다.
 * @param value GitHub API가 반환한 저장소 객체
 * @returns 유효한 owner/name인 경우 안전한 복제 항목, 계약과 맞지 않으면 undefined
 */
function parseRepository(value: unknown): GitHubCloneRepository | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.full_name !== "string" || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(item.full_name)) return undefined;
  const [owner, name] = item.full_name.split("/");
  if (owner === "." || owner === ".." || name === "." || name === "..") return undefined;
  return {
    nameWithOwner: item.full_name,
    cloneUrl: "https://github.com/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name) + ".git",
    description: typeof item.description === "string" ? item.description : "",
    isPrivate: item.private === true,
    archived: item.archived === true,
  };
}

/**
 * 저장소 목록의 다음 페이지가 존재하는지 확인한다. 응답 URL을 인증 요청에 재사용하지 않는다.
 * @param link GitHub의 Link 응답 헤더
 * @param current 현재 페이지 번호
 * @returns next 관계가 있으면 다음 정수 페이지, 없으면 undefined
 */
function nextPage(link: string | null, current: number): number | undefined {
  return link && /rel="next"/.test(link) ? current + 1 : undefined;
}

/**
 * 공개·개인·조직 저장소를 같은 API에서 페이지 단위로 조회한다.
 * @param request 테스트에서 응답·취소를 주입할 fetch 경계. production은 Node의 fetch 사용
 */
export class GitHubRepositoryCatalog {
  constructor(private readonly request: RepositoryCatalogFetch = fetch) {}

  /**
   * 인증된 사용자가 접근 가능한 저장소의 한 페이지를 읽는다.
   * @param token UI가 현재 작업에만 제공한 GitHub OAuth token
   * @param page 첫 페이지는 1. 많은 저장소는 사용자 선택에 따라 다음 페이지를 읽는다.
   * @param signal 목록 조회를 중단할 선택적 취소 신호
   * @returns 복제 항목과 다음 페이지 번호. token·raw response body는 결과에 포함하지 않는다.
   */
  async listPage(token: string, page = 1, signal?: AbortSignal): Promise<GitHubRepositoryPage> {
    if (!token || /[\r\n]/.test(token)) throw new RepositoryCatalogError("authentication");
    if (!Number.isSafeInteger(page) || page < 1) throw new RepositoryCatalogError("invalid-data");
    if (signal?.aborted) throw new RepositoryCatalogError("cancelled");
    const url = new URL("https://api.github.com/user/repos");
    url.search = new URLSearchParams({
      per_page: "100", page: String(page), sort: "updated", direction: "desc",
      affiliation: "owner,collaborator,organization_member",
    }).toString();
    let response: Awaited<ReturnType<RepositoryCatalogFetch>>;
    try {
      response = await this.request(url.toString(), {
        method: "GET", redirect: "error", signal,
        headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token,
          "X-GitHub-Api-Version": "2022-11-28" },
      });
    } catch {
      throw new RepositoryCatalogError(signal?.aborted ? "cancelled" : "network");
    }
    if (signal?.aborted) throw new RepositoryCatalogError("cancelled");
    if (!response.ok) {
      const exhausted = response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0";
      throw new RepositoryCatalogError(exhausted ? "rate-limit" : [401, 403].includes(response.status) ? "authentication" : "http",
        response.status);
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new RepositoryCatalogError(signal?.aborted ? "cancelled" : "invalid-data"); }
    if (signal?.aborted) throw new RepositoryCatalogError("cancelled");
    if (!Array.isArray(payload)) throw new RepositoryCatalogError("invalid-data");
    const parsed = payload.map(parseRepository);
    // 부분적으로 잘못된 payload를 빈 목록처럼 보여 주지 않고 재시도 가능한 오류로 구분한다.
    if (parsed.some(item => !item)) throw new RepositoryCatalogError("invalid-data");
    return { repositories: parsed as GitHubCloneRepository[], nextPage: nextPage(response.headers.get("link"), page) };
  }
}
