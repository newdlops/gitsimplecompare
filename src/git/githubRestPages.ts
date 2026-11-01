// REST body-only 계약을 유지하면서 선택한 페이지 조회에만 안전한 응답 metadata를 전달한다.
import type { IncomingHttpHeaders } from "node:http";

/** 페이지 흐름에 필요한 헤더만 포함하며 인증·Cookie 헤더는 보관하지 않는다. */
export interface GitHubRestPageMetadata {
  status: number;
  link?: string;
  etag?: string;
  lastModified?: string;
  retryAfter?: string;
  rateLimitRemaining?: string;
  rateLimitReset?: string;
  /** 304가 현재 Link를 주지 않으면 예전 '다음 페이지 없음'은 전체 목록의 최신성을 증명하지 못한다. */
  paginationKnown?: boolean;
}

/** metadata가 없으면 기존 headerless runner이므로 길이 기반 pagination을 유지한다. */
export interface GitHubRestPage<T> { data: T; metadata?: GitHubRestPageMetadata; }

/** 외부 원문 없이 불완전한 응답과 안전하지 않은 다음 페이지를 구분한다. */
export class GitHubRestPageError extends Error {
  readonly kind = "rest-page";
  constructor(readonly reason: "metadata" | "invalid-json" | "pagination") {
    super("Cannot read a complete GitHub REST page. Refresh and try again.");
    this.name = "GitHubRestPageError";
  }
}

const FIELDS = { link: "link", etag: "etag", lastModified: "last-modified", retryAfter: "retry-after",
  rateLimitRemaining: "x-ratelimit-remaining", rateLimitReset: "x-ratelimit-reset" } as const;

/**
 * Node/CLI 응답에서 필요한 헤더만 읽어 body cache와 함께 저장할 값으로 바꾼다.
 * @param status 현재 body를 나타내는 유효 HTTP status, headers 대소문자가 섞일 수 있는 원본 헤더
 * @returns 크기·개행 검증을 통과한 페이지 metadata. 원본 헤더 객체는 유지하지 않는다.
 */
export function restPageMetadata(status: number, headers: IncomingHttpHeaders): GitHubRestPageMetadata {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const result: GitHubRestPageMetadata = { status };
  if (!Number.isSafeInteger(status) || status < 200 || status >= 300) throw new GitHubRestPageError("metadata");
  for (const [field, header] of Object.entries(FIELDS)) {
    const value = normalized[header];
    const text = Array.isArray(value) ? value.join(", ") : value;
    if (text === undefined) continue;
    if (typeof text !== "string" || text.length > 16_384 || /[\r\n\0]/.test(text)) throw new GitHubRestPageError("metadata");
    result[field as keyof typeof FIELDS] = text;
  }
  return result;
}

/**
 * GhExecute의 문자열 반환을 바꾸지 않고 명시적 페이지 표현만 versioned JSON으로 만든다.
 * @param body 검증을 마친 원래 JSON 문자열, metadata 현재 body에 대응하는 허용된 응답 정보
 * @returns 비밀 헤더가 포함될 수 없는 envelope 문자열
 */
export function encodeRestPage(body: string, metadata: GitHubRestPageMetadata): string {
  return JSON.stringify({ __gscRestPage: 1, body, metadata: validateMetadata(metadata) });
}

/**
 * 304의 최신 허용 헤더를 병합하되, 생략된 Link로 과거 종료 판정을 확정하지 않는다.
 * @param cached 저장된 body의 metadata, headers 이번 재검증이 실제로 반환한 헤더
 * @returns 현재 알려진 next Link와 종료 판정 신뢰도를 함께 나타내는 metadata
 */
export function revalidateRestPageMetadata(cached: GitHubRestPageMetadata, headers: IncomingHttpHeaders): GitHubRestPageMetadata {
  const fresh = restPageMetadata(200, headers), metadata = { ...cached, ...fresh };
  if (fresh.link === undefined) metadata.paginationKnown = false;
  else delete metadata.paginationKnown;
  return metadata;
}

/** page mode에만 CLI 헤더 출력을 요청하며 기존 body-only 인자는 호출자가 그대로 사용한다. */
export function restPageCliArgs(args: readonly string[]): readonly string[] {
  if (args[0] !== "api") throw new GitHubRestPageError("metadata");
  return args.includes("--include") || args.includes("-i") ? args : ["api", "--include", ...args.slice(1)];
}

/**
 * gh --include의 마지막 정상 응답을 opt-in 페이지 표현으로 바꾼다.
 * @param output CLI stdout. headerless fake runner는 기존 JSON body를 그대로 반환할 수 있다.
 * @returns 완전한 최종 body와 허용 metadata. 앞선 redirect/100 응답의 헤더는 섞지 않는다.
 */
export function normalizeRestPageCli(output: string): string {
  let remaining = output;
  if (!/^HTTP\//.test(remaining)) return output;
  for (let count = 0; count < 8; count++) {
    const status = /^HTTP\/(?:1(?:\.[01])?|2(?:\.0)?|3(?:\.0)?)\s+(\d{3})[^\r\n]*\r?\n/.exec(remaining);
    const boundary = /\r?\n\r?\n/.exec(remaining);
    if (!status || !boundary) throw new GitHubRestPageError("metadata");
    const headers: IncomingHttpHeaders = {};
    for (const line of remaining.slice(status[0].length, boundary.index).split(/\r?\n/)) {
      if (!line) continue;
      const header = /^([!#$%&'*+.^_`|~\da-z-]+):[ \t]*(.*)$/i.exec(line);
      if (!header) throw new GitHubRestPageError("metadata");
      const key = header[1].toLowerCase();
      headers[key] = headers[key] === undefined ? header[2] : String(headers[key]) + ", " + header[2];
    }
    remaining = remaining.slice(boundary.index + boundary[0].length);
    const code = Number(status[1]);
    if (code >= 100 && code < 200 || code >= 300 && code < 400) {
      if (/^HTTP\//.test(remaining)) continue;
      throw new GitHubRestPageError("metadata");
    }
    return encodeRestPage(remaining, restPageMetadata(code, headers));
  }
  throw new GitHubRestPageError("metadata");
}

/**
 * 페이지 envelope 또는 기존 JSON body를 동일 reader 결과로 정규화한다.
 * @param output GhExecute가 반환한 원문. 호출자는 오류/로그에 이 값을 넣지 않는다.
 * @returns 원본 JSON 데이터와 선택적 안전 metadata. 버전/본문 손상은 빈 성공으로 숨기지 않는다.
 */
export function decodeRestPage<T>(output: string): GitHubRestPage<T> {
  const value = parseJson(output);
  if (value && typeof value === "object" && "__gscRestPage" in value) {
    const envelope = value as { __gscRestPage?: unknown; body?: unknown; metadata?: unknown };
    if (envelope.__gscRestPage !== 1 || typeof envelope.body !== "string") throw new GitHubRestPageError("metadata");
    return { data: parseJson(envelope.body) as T, metadata: validateMetadata(envelope.metadata) };
  }
  return { data: value as T };
}

/**
 * Link가 있으면 같은 endpoint의 바로 다음 page만 허용하고, 없으면 header 유무에 맞춰 종료한다.
 * @param page 현재 배열/metadata, path API 경로, current 현재 page, pageSize 요청 크기, apiBase 고정한 API origin/prefix
 * @returns 안전한 다음 page 번호 또는 완료 시 undefined. 외부/역행/건너뛴 page는 실패한다.
 */
export function nextRestPage(page: GitHubRestPage<unknown[]>, path: string, current: number, pageSize = 100,
  apiBase = "https://api.github.com"): number | undefined {
  if (!Array.isArray(page.data) || !Number.isSafeInteger(current) || current < 1
    || !Number.isSafeInteger(pageSize) || pageSize < 1) throw new GitHubRestPageError("pagination");
  if (!page.metadata) return page.data.length < pageSize ? undefined : current + 1;
  const metadata = validateMetadata(page.metadata);
  if (!metadata.link) return metadata.paginationKnown === false && page.data.length >= pageSize ? current + 1 : undefined;
  let next: string | undefined, end = 0;
  const entries = /<([^<>]+)>\s*((?:;\s*[^,<>]+)*)/g;
  for (const match of metadata.link.matchAll(entries)) {
    if (!/^[\s,]*$/.test(metadata.link.slice(end, match.index))) throw new GitHubRestPageError("pagination");
    end = match.index! + match[0].length;
    const relation = /(?:^|;)\s*rel\s*=\s*(?:"([^"]+)"|([^;\s,]+))/i.exec(match[2]);
    if (!relation) throw new GitHubRestPageError("pagination");
    if (!(relation[1] ?? relation[2]).split(/\s+/).includes("next")) continue;
    if (next !== undefined) throw new GitHubRestPageError("pagination");
    next = match[1];
  }
  if (!end || !/^[\s,]*$/.test(metadata.link.slice(end))) throw new GitHubRestPageError("pagination");
  if (next === undefined) return metadata.paginationKnown === false && page.data.length >= pageSize ? current + 1 : undefined;
  try {
    if (!path.startsWith("/") || path.startsWith("//") || /[\r\n\\#]/.test(path)) throw new Error();
    const trusted = new URL(apiBase);
    if (trusted.protocol !== "https:" || trusted.username || trusted.password || trusted.search || trusted.hash) throw new Error();
    const base = new URL(trusted.pathname.replace(/\/$/, "") + path, trusted.origin), target = new URL(next, base);
    if (target.origin !== base.origin || target.pathname !== base.pathname || target.username || target.password || target.hash) throw new Error();
    const pages = target.searchParams.getAll("page"), oldPages = base.searchParams.getAll("page");
    if (pages.length !== 1 || oldPages.length > 1 || oldPages.length === 1 && Number(oldPages[0]) !== current
      || !/^[1-9]\d*$/.test(pages[0]) || Number(pages[0]) !== current + 1 || !Number.isSafeInteger(Number(pages[0]))) throw new Error();
    if (queryWithoutPage(base) !== queryWithoutPage(target)) throw new Error();
    return Number(pages[0]);
  } catch { throw new GitHubRestPageError("pagination"); }
}

/** 실제 JSON 파서 실패에 원격 본문을 붙이지 않고 typed 오류로만 전달한다. */
function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { throw new GitHubRestPageError("invalid-json"); }
}

/** envelope의 allowlist 필드만 읽어 잘못된 type/개행/status를 검사한다. */
function validateMetadata(value: unknown): GitHubRestPageMetadata {
  if (!value || typeof value !== "object") throw new GitHubRestPageError("metadata");
  const record = value as Record<string, unknown>, headers: IncomingHttpHeaders = {};
  for (const [field, header] of Object.entries(FIELDS)) {
    const item = record[field];
    if (item !== undefined && typeof item !== "string") throw new GitHubRestPageError("metadata");
    headers[header] = item as string | undefined;
  }
  const metadata = restPageMetadata(record.status as number, headers);
  if (record.paginationKnown !== undefined) {
    if (typeof record.paginationKnown !== "boolean") throw new GitHubRestPageError("metadata");
    metadata.paginationKnown = record.paginationKnown;
  }
  return metadata;
}

/** query의 순서·인코딩 차이는 허용하고 page 외의 필터·크기는 정확히 유지한다. */
function queryWithoutPage(url: URL): string {
  return JSON.stringify([...url.searchParams].filter(([key]) => key !== "page")
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)));
}
