// GitHub 온보딩에서 접근 가능한 저장소를 조회하는 read-only 서비스.
// - OAuth session은 UI가 제공하며 Git·gh·VS Code 기본 Git API에 의존하지 않는다.
import { SharedGitRead } from "./sharedGitRead";
import { GitHubRepositoryPageCache, cloneRepositoryPage, type RepositoryPageCacheOptions } from "./githubRepositoryPageCache";
import { logInfo } from "../ui/outputLog";
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
  Pick<Response, "ok" | "status" | "headers" | "json"> & { body?: Pick<NonNullable<Response["body"]>, "cancel"> | null }
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
interface PendingPage { identity: string; reader: SharedGitRead<GitHubRepositoryPage>; users: number; }
const ACCEPT = "application/vnd.github+json", API_VERSION = "2022-11-28";

export class GitHubRepositoryCatalog {
  private readonly cache: GitHubRepositoryPageCache;
  private readonly pending = new Map<string, PendingPage>();
  private readonly active = new Set<PendingPage>();
  private readonly cooldowns = new Map<string, { until: number; status: number }>();
  private disposed = false;
  private disposal?: Promise<void>;

  /** @param request 기존 fetch 경계, options cache 한계/clock을 위한 테스트 전용 값 */
  constructor(private readonly request: RepositoryCatalogFetch = fetch, private readonly options: RepositoryPageCacheOptions = {}) {
    this.cache = new GitHubRepositoryPageCache(options);
  }

  /**
   * 현재 OAuth로 재인가한 저장소 한 페이지를 반환한다. 완료 캐시를 먼저 표시하지 않는다.
   * @param token 현재 OAuth 값, page 사용자 선택 페이지, signal 이 소비자만의 취소
   * @returns 현재 200 또는 conditional 304로 검증된 목록. 동시 소비자는 실제 fetch 하나를 공유한다.
   */
  async listPage(token: string, page = 1, signal?: AbortSignal): Promise<GitHubRepositoryPage> {
    if (!token || /[\r\n\0]/.test(token)) throw new RepositoryCatalogError("authentication");
    if (!Number.isSafeInteger(page) || page < 1) throw new RepositoryCatalogError("invalid-data");
    if (this.disposed || signal?.aborted) throw new RepositoryCatalogError("cancelled");
    const url = new URL("https://api.github.com/user/repos");
    url.search = new URLSearchParams({ per_page: "100", page: String(page), sort: "updated", direction: "desc",
      affiliation: "owner,collaborator,organization_member" }).toString();
    const identity = this.cache.identity(token), key = [identity, url.toString(), ACCEPT, API_VERSION].join("\0");
    this.checkCooldown(identity);
    let entry = this.pending.get(key);
    if (!entry) {
      const reader = new SharedGitRead<GitHubRepositoryPage>(ownedSignal => this.readPage(token, page, url.toString(), identity, key, ownedSignal), cloneRepositoryPage);
      entry = { identity, reader, users: 0 }; this.pending.set(key, entry); this.active.add(entry);
    } else logInfo("GitHub repository catalog read shared", { page });
    const owned = entry; owned.users++;
    try { return await owned.reader.read({ signal, maxCacheAgeMs: 0 }); }
    catch (error) {
      if (this.disposed || signal?.aborted || error instanceof Error && error.name === "AbortError") throw new RepositoryCatalogError("cancelled");
      throw error instanceof RepositoryCatalogError ? error : new RepositoryCatalogError("network");
    } finally {
      if (--owned.users === 0) {
        if (this.pending.get(key) === owned) this.pending.delete(key);
        void owned.reader.dispose().finally(() => this.active.delete(owned));
      }
    }
  }

  /** 소유한 fetch/JSON 읽기를 취소하고 종료까지 기다린 뒤 private 표현과 timer/cooldown을 해제한다. */
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.disposed = true;
      await Promise.allSettled([...this.active].map(entry => entry.reader.dispose()));
      this.cache.dispose(); this.pending.clear(); this.active.clear(); this.cooldowns.clear();
      logInfo("GitHub repository catalog disposed", { pending: 0 });
    })();
  }

  /** private 목록/identity 없이 수명·용량 검증에 필요한 집계만 반환한다. */
  metrics() { return { cachePages: this.cache.metrics().pages, cacheBytes: this.cache.metrics().bytes, pending: this.active.size }; }

  /** 30초 마감과 한 번의 body-less 304 복구를 포함한 실제 OAuth GET을 소유한다. */
  private async readPage(token: string, page: number, url: string, identity: string, key: string, signal: AbortSignal): Promise<GitHubRepositoryPage> {
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 30_000);
    if (signal.aborted) abort();
    let cached = this.cache.get(key);
    try {
      for (let repair = 0; repair <= 1; repair++) {
        let response: Awaited<ReturnType<RepositoryCatalogFetch>>;
        try {
          this.checkCancelled(controller.signal); this.checkCooldown(identity);
          response = await this.request(url, { method: "GET", redirect: "error", signal: controller.signal,
            headers: { Accept: ACCEPT, Authorization: "Bearer " + token, "X-GitHub-Api-Version": API_VERSION,
              ...(cached ? { "If-None-Match": cached.etag } : {}) } });
        } catch (error) {
          if (error instanceof RepositoryCatalogError) throw error;
          throw new RepositoryCatalogError(controller.signal.aborted ? "cancelled" : "network");
        }
        this.checkCancelled(controller.signal);
        if (response.status === 304) {
          await releaseResponseBody(response);
          this.checkCancelled(controller.signal);
          if (!cached) { if (repair) throw new RepositoryCatalogError("invalid-data", 304); continue; }
          const link = response.headers.get("link");
          const value = cloneRepositoryPage(cached.page);
          // Link 없는 304는 오래된 full terminal 페이지에 새 tail이 없다고 확정하지 않는다.
          value.nextPage = link !== null ? nextPage(link, page) : cached.page.nextPage ?? (value.repositories.length >= 100 ? page + 1 : undefined);
          this.cache.put(key, identity, value, response.headers.get("etag") ?? cached.etag);
          logInfo("GitHub repository catalog page revalidated", { page, status: 304, repositories: value.repositories.length });
          return value;
        }
        if (!response.ok) {
          let secondary = response.status === 429 || response.status === 403 && response.headers.has("retry-after");
          const primary = response.headers.get("x-ratelimit-remaining") === "0";
          if (response.status === 403 && !secondary && !primary) {
            try { const body = await response.json() as { message?: unknown }; secondary = typeof body?.message === "string" && /secondary rate limit|abuse detection/i.test(body.message); }
            catch { /* 원문을 보관하거나 로그로 보내지 않는다. */ }
            this.checkCancelled(controller.signal);
          }
          await releaseResponseBody(response);
          this.checkCancelled(controller.signal);
          if (primary || secondary) {
            const until = retryAt(response.headers, this.now()) ?? this.now() + 60_000;
            this.cooldowns.set(primary ? identity : "origin", { until, status: response.status });
            while (this.cooldowns.size > 128) this.cooldowns.delete(this.cooldowns.keys().next().value!);
            throw new RepositoryCatalogError("rate-limit", response.status);
          }
          if ([401, 403].includes(response.status)) {
            this.cache.invalidate(identity);
            for (const [otherKey, pending] of this.pending) if (otherKey !== key && pending.identity === identity) void pending.reader.dispose();
            throw new RepositoryCatalogError("authentication", response.status);
          }
          throw new RepositoryCatalogError("http", response.status);
        }
        let payload: unknown;
        try { payload = await response.json(); }
        catch { throw new RepositoryCatalogError(controller.signal.aborted ? "cancelled" : "invalid-data"); }
        this.checkCancelled(controller.signal);
        if (!Array.isArray(payload)) throw new RepositoryCatalogError("invalid-data");
        const repositories = payload.map(parseRepository);
        if (repositories.some(item => !item)) throw new RepositoryCatalogError("invalid-data");
        const value: GitHubRepositoryPage = { repositories: repositories as GitHubCloneRepository[], nextPage: nextPage(response.headers.get("link"), page) };
        this.cache.put(key, identity, value, response.headers.get("etag"));
        logInfo("GitHub repository catalog page loaded", { page, status: response.status, repositories: value.repositories.length });
        return value;
      }
      throw new RepositoryCatalogError("invalid-data");
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort(); }
  }

  /** 부모 취소/폐기 후의 private body는 UI나 캐시에 게시하지 않는다. */
  private checkCancelled(signal: AbortSignal): void { if (signal.aborted || this.disposed) throw new RepositoryCatalogError("cancelled"); }

  /** 만료된 cooldown을 정리하고 현재 계정 또는 origin의 대기 시간을 준수한다. */
  private checkCooldown(identity: string): void {
    for (const [key, value] of this.cooldowns) if (value.until <= this.now()) this.cooldowns.delete(key);
    const blocked = this.cooldowns.get(identity) ?? this.cooldowns.get("origin");
    if (blocked) throw new RepositoryCatalogError("rate-limit", blocked.status);
  }
  /** 테스트용 clock과 production 시각을 같은 경계에서 읽는다. */
  private now(): number { return this.options.now?.() ?? Date.now(); }
}

/** Retry-After의 초/HTTP date와 primary reset을 epoch로 읽되 원문은 보존하지 않는다. */
function retryAt(headers: Headers, now: number): number | undefined {
  const retry = headers.get("retry-after"), reset = headers.get("x-ratelimit-reset");
  const value = retry ? /^\d+(?:\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry) : Number(reset) * 1000;
  return Number.isFinite(value) && value > now ? value : undefined;
}

/** JSON으로 소비하지 않은 오류/304 body를 닫되 이미 닫힌 body의 오류 원문은 노출하지 않는다. */
async function releaseResponseBody(response: Awaited<ReturnType<RepositoryCatalogFetch>>): Promise<void> {
  try { await response.body?.cancel(); } catch { /* 소비 완료/취소로 이미 닫힌 body도 정상 정리다. */ }
}
