// GitHub PR files 웹 HTML 에서 서버 렌더링된 suggested changeset 을 추출한다.
// - REST/GraphQL review comment API 에 없는 Copilot suggested changeset 을 보조적으로 읽기 위한 경로다.
import { runGh } from "./ghCli";
import { isGitHubHtml, readGitHubWebHtmlWithFragments } from "./githubWebHtml";
import { parseCopilotSuggestedChangesetPayloads } from "./pullRequestSuggestedChangesetPayload";

const WEB_COOKIE_ENV = "GIT_SIMPLE_COMPARE_GITHUB_COOKIE";

/** PR files 웹 HTML 에서 읽은 suggested changeset 결과 */
export interface PullRequestSuggestedChangesetRead {
  /** comment id 별 suggested changeset 코드 */
  byCommentId: Map<string, string[]>;
  /** 시도/성공/실패를 OUTPUT 에 남기기 위한 진단 정보 */
  status: PullRequestSuggestedChangesetStatus;
}

/** suggested changeset 보조 조회 상태 */
export interface PullRequestSuggestedChangesetStatus {
  /** 웹 HTML 조회를 시도했는지 여부 */
  attempted: boolean;
  /** 성공한 조회 경로 */
  source?: string;
  /** suggested changeset 이 붙은 comment 수 */
  comments: number;
  /** 전체 suggested changeset 수 */
  changesets: number;
  /** 실패하거나 건너뛴 이유 */
  reason?: string;
}

/** suggested changeset 웹 HTML 조회에 사용할 선택 인증 정보 */
export interface PullRequestSuggestedChangesetOptions {
  /** VS Code GitHub authentication provider 에서 얻은 OAuth token */
  webAccessToken?: string;
  /** VS Code SecretStorage 등에 저장된 github.com Cookie 헤더 값 */
  webCookie?: string;
}

/** REST review comment 에서 suggested changeset 보조 조회에 필요한 최소 정보 */
export interface PullRequestSuggestedChangesetComment {
  /** GitHub review comment id */
  id: string;
  /** GitHub comment permalink */
  url?: string;
}

/**
 * 인증 가능한 GitHub 웹 HTML 에서 Copilot suggested changeset 을 읽는다.
 * - gh api, VS Code/gh OAuth token, 명시 웹 쿠키를 순서대로 시도한다.
 * - OAuth token 이 웹 files HTML 을 거부하면 각 comment permalink 전문 HTML 을 다시 시도한다.
 * - GitHub 웹 페이지는 private repo 에서 OAuth token 을 거부할 수 있으므로 실패 이유를 누적해 로그에 남긴다.
 * - 어떤 경로도 동작하지 않으면 빈 결과와 실패 이유를 반환해 PR comment 표시 자체는 계속 진행한다.
 * @param repoRoot gh 를 실행할 저장소 루트
 * @param owner GitHub owner
 * @param name repository 이름
 * @param number PR 번호
 * @param options VS Code 인증 세션처럼 호출자가 이미 가진 보조 인증 정보
 * @param comments comment permalink 기반 보조 조회에 사용할 REST comment 목록
 * @returns comment id 별 suggested changeset 과 조회 상태
 */
export async function readPullRequestSuggestedChangesets(
  repoRoot: string,
  owner: string,
  name: string,
  number: number,
  options: PullRequestSuggestedChangesetOptions = {},
  comments: PullRequestSuggestedChangesetComment[] = []
): Promise<PullRequestSuggestedChangesetRead> {
  const url = `https://github.com/${owner}/${name}/pull/${number}/files`;
  const reasons: string[] = [];
  const ghHtml = await readWithGhApi(repoRoot, url);
  if (ghHtml.ok) {
    return parsedRead(ghHtml.html, "gh-api-web");
  }
  reasons.push(`gh-api-web: ${ghHtml.reason}`);

  if (options.webAccessToken) {
    const vscodeTokenHtml = await readWithToken(url, options.webAccessToken);
    if (vscodeTokenHtml.ok) {
      return parsedRead(vscodeTokenHtml.html, "vscode-auth-web");
    }
    reasons.push(`vscode-auth-web: ${vscodeTokenHtml.reason}`);
    const vscodeCommentHtml = await readCommentPages(comments, (pageUrl) =>
      readWithToken(pageUrl, options.webAccessToken || "")
    );
    if (vscodeCommentHtml.ok) {
      return mapRead(vscodeCommentHtml.byCommentId, "vscode-auth-comment-page");
    }
    reasons.push(`vscode-auth-comment-page: ${vscodeCommentHtml.reason}`);
  } else {
    reasons.push("vscode-auth-web: no VS Code GitHub session");
    reasons.push("vscode-auth-comment-page: no VS Code GitHub session");
  }

  const ghToken = await readGhToken(repoRoot);
  if (ghToken.ok) {
    const ghTokenHtml = await readWithToken(url, ghToken.token);
    if (ghTokenHtml.ok) {
      return parsedRead(ghTokenHtml.html, "gh-token-web");
    }
    reasons.push(`gh-token-web: ${ghTokenHtml.reason}`);
    const ghCommentHtml = await readCommentPages(comments, (pageUrl) =>
      readWithToken(pageUrl, ghToken.token)
    );
    if (ghCommentHtml.ok) {
      return mapRead(ghCommentHtml.byCommentId, "gh-token-comment-page");
    }
    reasons.push(`gh-token-comment-page: ${ghCommentHtml.reason}`);
  } else {
    reasons.push(`gh-token-web: ${ghToken.reason}`);
    reasons.push(`gh-token-comment-page: ${ghToken.reason}`);
  }

  if (options.webCookie) {
    const storedCookieHtml = await readWithCookie(url, options.webCookie);
    if (storedCookieHtml.ok) {
      return parsedRead(storedCookieHtml.html, "stored-web-cookie");
    }
    reasons.push(`stored-web-cookie: ${storedCookieHtml.reason}`);
  } else {
    reasons.push("stored-web-cookie: not set");
  }

  const envCookie = process.env[WEB_COOKIE_ENV]?.trim();
  if (envCookie) {
    const envCookieHtml = await readWithCookie(url, envCookie);
    if (envCookieHtml.ok) {
      return parsedRead(envCookieHtml.html, "env-web-cookie");
    }
    reasons.push(`env-web-cookie: ${envCookieHtml.reason}`);
  } else {
    reasons.push(`env-web-cookie: ${WEB_COOKIE_ENV} is not set`);
  }
  return emptyRead(reasons.join("; "));
}

/**
 * gh api 로 github.com 웹 HTML 을 읽는다.
 * @param repoRoot gh 를 실행할 저장소 루트
 * @param url PR files 웹 URL
 * @returns HTML 또는 실패 이유
 */
async function readWithGhApi(
  repoRoot: string,
  url: string
): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
  try {
    const html = await runGh(["api", url], repoRoot);
    return isGitHubHtml(html)
      ? { ok: true, html }
      : { ok: false, reason: "gh api web response was not HTML" };
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}

/**
 * gh keyring 에 저장된 OAuth token 을 읽는다.
 * - token 값은 절대 로그에 남기지 않고, 웹 HTML 요청에만 사용한다.
 * @param repoRoot gh 를 실행할 저장소 루트
 * @returns token 또는 실패 이유
 */
async function readGhToken(
  repoRoot: string
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  try {
    const token = (await runGh(["auth", "token"], repoRoot)).trim();
    return token
      ? { ok: true, token }
      : { ok: false, reason: "gh auth token returned empty token" };
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}

/**
 * OAuth token 을 Authorization 헤더로 붙여 PR files 웹 HTML 을 읽는다.
 * - 현재 GitHub 웹은 private repo HTML 에서 이 인증을 거부할 수 있으므로 실패 이유를 호출부로 돌려준다.
 * @param url PR files 웹 URL
 * @param token OAuth token
 * @returns HTML 또는 실패 이유
 */
function readWithToken(
  url: string,
  token: string
): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
  return readGitHubWebHtmlWithFragments(url, {
    Authorization: `Bearer ${token}`,
    Accept: "text/html",
    "User-Agent": "Git Simple Compare",
  });
}

/**
 * 명시적으로 제공된 GitHub 웹 쿠키로 PR files HTML 을 읽는다.
 * @param url PR files 웹 URL
 * @param cookie GitHub 웹 세션 Cookie 헤더 값
 * @returns HTML 또는 실패 이유
 */
function readWithCookie(
  url: string,
  cookie: string
): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
  return readGitHubWebHtmlWithFragments(url, {
    Accept: "text/html",
    Cookie: cookie,
    "User-Agent": "Git Simple Compare",
  });
}

/**
 * comment permalink HTML 을 순회하며 suggested changeset 을 찾는다.
 * - GitHub REST 의 html_url 은 보통 /pull/{number}#discussion_r{id} 이므로,
 *   files tab 과 원본 permalink 를 함께 후보로 만든다.
 * @param comments REST API 에서 받은 comment id/permalink 목록
 * @param readUrl URL 하나를 HTML 로 읽는 함수
 * @returns comment id 별 suggested changeset 또는 실패 이유
 */
async function readCommentPages(
  comments: PullRequestSuggestedChangesetComment[],
  readUrl: (url: string) => Promise<{ ok: true; html: string } | { ok: false; reason: string }>
): Promise<{ ok: true; byCommentId: Map<string, string[]> } | { ok: false; reason: string }> {
  const urls = commentPageUrls(comments);
  if (!urls.length) {
    return { ok: false, reason: "no comment html_url" };
  }
  const result = new Map<string, string[]>();
  const failures: string[] = [];
  for (const url of urls) {
    const read = await readUrl(url);
    if (!read.ok) {
      failures.push(read.reason);
      continue;
    }
    mergeSuggestedChangesets(result, parsePullRequestSuggestedChangesets(read.html));
  }
  if (result.size) {
    return { ok: true, byCommentId: result };
  }
  const detail = unique(failures).slice(0, 3).join(", ");
  return { ok: false, reason: detail || `0 suggestions from ${urls.length} comment page(s)` };
}

/**
 * REST comment permalink 에서 실제 요청할 GitHub 웹 URL 후보를 만든다.
 * @param comments REST API 에서 받은 comment id/permalink 목록
 * @returns 중복 제거된 URL 목록
 */
function commentPageUrls(comments: PullRequestSuggestedChangesetComment[]): string[] {
  const urls: string[] = [];
  for (const comment of comments) {
    if (!comment.url) {
      continue;
    }
    const parsed = safeUrl(comment.url);
    if (!parsed) {
      continue;
    }
    urls.push(stripHash(parsed).toString());
    const filesUrl = filesTabUrl(parsed);
    if (filesUrl) {
      urls.push(filesUrl);
    }
  }
  return unique(urls);
}

/**
 * GitHub PR permalink 를 files tab URL 로 바꾼다.
 * @param url GitHub comment permalink
 * @returns files tab URL. PR URL 이 아니면 undefined
 */
function filesTabUrl(url: URL): string | undefined {
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url.pathname);
  if (!match) {
    return undefined;
  }
  const next = new URL(url.toString());
  next.pathname = `/${match[1]}/${match[2]}/pull/${match[3]}/files`;
  next.hash = "";
  return next.toString();
}

/**
 * URL 문자열을 안전하게 파싱한다.
 * @param value URL 후보 문자열
 * @returns URL 객체 또는 undefined
 */
function safeUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.hostname === "github.com" ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * HTTP 요청에 의미 없는 fragment 를 제거한 URL 을 반환한다.
 * @param url 원본 URL
 * @returns hash 가 제거된 복사본
 */
function stripHash(url: URL): URL {
  const next = new URL(url.toString());
  next.hash = "";
  return next;
}

/**
 * GitHub HTML 에서 comment id 별 suggested changeset 을 파싱한다.
 * @param html PR files 웹 HTML
 * @returns comment id 별 suggested changeset 배열
 */
export function parsePullRequestSuggestedChangesets(html: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  mergeSuggestedChangesets(result, parseCopilotSuggestedChangesetPayloads(html));
  const positions = Array.from(html.matchAll(/discussion_r(\d+)/g));
  for (let index = 0; index < positions.length; index++) {
    const id = positions[index][1];
    const start = positions[index].index || 0;
    const end = positions[index + 1]?.index || html.length;
    const block = html.slice(start, end);
    const suggestions = suggestedChangesetsFromBlock(block);
    if (suggestions.length) {
      result.set(id, unique([...(result.get(id) || []), ...suggestions]));
    }
  }
  for (const item of suggestedChangesetElements(html)) {
    const id = nearestCommentId(html, item.start, item.end);
    if (!id) {
      continue;
    }
    const suggestions = suggestedChangesetsFromBlock(item.html);
    if (suggestions.length) {
      result.set(id, unique([...(result.get(id) || []), ...suggestions]));
    }
  }
  return result;
}

/**
 * suggested changeset map 을 다른 map 에 병합한다.
 * @param target 병합 대상
 * @param source 새로 읽은 comment id 별 suggested changeset
 */
function mergeSuggestedChangesets(
  target: Map<string, string[]>,
  source: Map<string, string[]>
): void {
  for (const [id, suggestions] of source) {
    target.set(id, unique([...(target.get(id) || []), ...suggestions]));
  }
}

/**
 * comment HTML 조각 안의 suggested changeset 코드만 추출한다.
 * @param block comment 주변 HTML
 * @returns suggested changeset 코드 배열
 */
function suggestedChangesetsFromBlock(block: string): string[] {
  const suggestions: string[] = [];
  for (const part of elementsByClass(block, "js-suggested-changes-blob").map((item) => item.html)) {
    const additions = blobCodeLines(part, "blob-code-addition");
    if (additions.length) {
      suggestions.push(additions.join("\n"));
      continue;
    }
    if (blobCodeLines(part, "blob-code-deletion").length) {
      suggestions.push("");
    }
  }
  return unique(suggestions);
}

/** class 로 찾은 HTML element 조각과 원문 위치 */
interface HtmlElementRange {
  /** element 시작 index */
  start: number;
  /** element 끝 index */
  end: number;
  /** element HTML */
  html: string;
}

/**
 * 전체 HTML 에서 suggested changeset blob element 를 위치 정보와 함께 찾는다.
 * @param html 검색할 HTML
 * @returns suggested changeset blob element 목록
 */
function suggestedChangesetElements(html: string): HtmlElementRange[] {
  return elementsByClass(html, "js-suggested-changes-blob");
}

/**
 * 특정 class 를 가진 div element 들을 균형 잡힌 HTML 조각으로 잘라낸다.
 * @param html 검색할 HTML
 * @param className 찾을 class 이름
 * @returns 해당 element HTML 조각과 원문 위치 배열
 */
function elementsByClass(html: string, className: string): HtmlElementRange[] {
  const result: HtmlElementRange[] = [];
  const pattern = new RegExp(`<div\\b[^>]*class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>`, "gi");
  for (const match of html.matchAll(pattern)) {
    const start = match.index || 0;
    const end = balancedDivEnd(html, start);
    if (end > start) {
      result.push({ start, end, html: html.slice(start, end) });
    }
  }
  return result;
}

/**
 * suggested changeset blob 주변에서 가장 가까운 GitHub review comment id 를 찾는다.
 * - GitHub HTML fragment 는 comment anchor 가 blob 앞/뒤 어느 쪽에 놓일 수 있어 양방향을 확인한다.
 * @param html 전체 HTML
 * @param start blob 시작 index
 * @param end blob 끝 index
 * @returns review comment id 또는 undefined
 */
function nearestCommentId(html: string, start: number, end: number): string | undefined {
  const before = html.slice(Math.max(0, start - 120000), start);
  const after = html.slice(end, Math.min(html.length, end + 20000));
  const beforeIds = Array.from(before.matchAll(commentIdPattern()), (match) => matchedCommentId(match));
  const afterId = commentIdPattern().exec(after);
  return beforeIds.filter(Boolean).pop() || (afterId ? matchedCommentId(afterId) : undefined);
}

/**
 * GitHub HTML 에서 review comment id 로 쓰이는 대표 패턴을 만든다.
 * @returns comment id 추출 정규식
 */
function commentIdPattern(): RegExp {
  return /(?:discussion_r|pullrequestreviewcomment-|review-comment-|comment-)(\d+)/g;
}

/**
 * comment id 정규식 match 에서 id 문자열만 꺼낸다.
 * @param match RegExp match
 * @returns comment id
 */
function matchedCommentId(match: RegExpMatchArray): string | undefined {
  return match[1];
}

/**
 * div 시작 위치에서 대응되는 닫는 div 끝 위치를 찾는다.
 * @param html 전체 HTML
 * @param start div 시작 위치
 * @returns 닫는 div 뒤 위치. 찾지 못하면 html 끝
 */
function balancedDivEnd(html: string, start: number): number {
  const tagPattern = /<\/?div\b[^>]*>/gi;
  tagPattern.lastIndex = start;
  let depth = 0;
  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    const tag = match[0];
    if (tag.startsWith("</")) {
      depth--;
      if (depth === 0) {
        return tagPattern.lastIndex;
      }
    } else if (!tag.endsWith("/>")) {
      depth++;
    }
  }
  return html.length;
}

/**
 * GitHub blob-code table cell 에서 코드 줄을 읽는다.
 * @param html suggested changeset HTML 조각
 * @param className addition/deletion cell class
 * @returns 디코딩된 코드 줄 배열
 */
function blobCodeLines(html: string, className: string): string[] {
  const result: string[] = [];
  const pattern = new RegExp(`<td\\b[^>]*class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/td>`, "gi");
  for (const match of html.matchAll(pattern)) {
    result.push(htmlText(match[1]));
  }
  return result;
}

/**
 * HTML 조각을 코드 텍스트로 디코딩한다.
 * @param value HTML 조각
 * @returns 사람이 읽을 수 있는 코드 텍스트
 */
function htmlText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, "")
      .replace(/<[^>]+>/g, "")
  );
}

/** HTML entity 를 최소한의 코드 표시용 텍스트로 바꾼다. */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (match, code: string) => decodeCodePoint(match, Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (match, code: string) => decodeCodePoint(match, parseInt(code, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

/** 숫자 HTML entity code point 를 안전하게 문자로 바꾼다. */
function decodeCodePoint(fallback: string, codePoint: number): string {
  try {
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : fallback;
  } catch {
    return fallback;
  }
}

/** 중복 문자열을 입력 순서대로 제거한다. */
function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

/** 정규식에 넣을 문자열을 escape 한다. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** unknown 오류를 짧은 로그 문자열로 바꾼다. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** HTML 파싱 결과를 진단 정보와 함께 반환한다. */
function parsedRead(html: string, source: string): PullRequestSuggestedChangesetRead {
  return mapRead(parsePullRequestSuggestedChangesets(html), source);
}

/** 파싱된 suggested changeset map 을 진단 정보와 함께 반환한다. */
function mapRead(
  byCommentId: Map<string, string[]>,
  source: string
): PullRequestSuggestedChangesetRead {
  const changesets = Array.from(byCommentId.values()).reduce((sum, items) => sum + items.length, 0);
  return {
    byCommentId,
    status: {
      attempted: true,
      source,
      comments: byCommentId.size,
      changesets,
    },
  };
}

/** suggested changeset 을 읽지 못했을 때 빈 결과를 만든다. */
function emptyRead(reason: string): PullRequestSuggestedChangesetRead {
  return {
    byCommentId: new Map(),
    status: {
      attempted: true,
      comments: 0,
      changesets: 0,
      reason,
    },
  };
}
