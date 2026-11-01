// GitHub PR files 웹 HTML 에서 서버 렌더링된 suggested changeset 을 추출한다.
// - REST/GraphQL review comment API 에 없는 Copilot suggested changeset 을 보조적으로 읽기 위한 경로다.
import { runGh } from "./ghCli";
import { isGitHubHtml, readGitHubWebHtmlWithFragments } from "./githubWebHtml";
import { parsePullRequestSuggestedChangesets, mergeSuggestedChangesets } from "./pullRequestSuggestedChangesetParser";
export { parsePullRequestSuggestedChangesets } from "./pullRequestSuggestedChangesetParser";
import { GitHubWebReadContext } from "./githubWebReadContext";
import type { GitHubNetworkPolicy } from "./githubHttpPolicy";

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
  /** Host가 캡처한 proxy/CA 정책이며 확인되지 않으면 기존 Host 관리 HTTPS를 유지한다. */
  networkPolicy?: GitHubNetworkPolicy;
  /** 활성 에디터 요청이 폐기될 때 gh 및 HTTPS 순회를 중단할 신호 */
  signal?: AbortSignal;
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
  const context = new GitHubWebReadContext({ signal: options.signal, policy: options.networkPolicy });
  try {
    throwIfAborted(context.signal);
    const url = `https://github.com/${owner}/${name}/pull/${number}/files`;
    const reasons: string[] = [];
    const ghHtml = await readWithGhApi(repoRoot, url, context.signal);
    throwIfAborted(context.signal);
    if (ghHtml.ok) {
      return parsedRead(ghHtml.html, "gh-api-web");
    }
    reasons.push(`gh-api-web: ${ghHtml.reason}`);

    if (options.webAccessToken) {
      const vscodeTokenHtml = await readWithToken(url, options.webAccessToken, context.signal, context);
      if (vscodeTokenHtml.ok) {
        return parsedRead(vscodeTokenHtml.html, "vscode-auth-web");
      }
      reasons.push(`vscode-auth-web: ${vscodeTokenHtml.reason}`);
      const vscodeCommentHtml = await readCommentPages(
        comments,
        (pageUrl) => readWithToken(pageUrl, options.webAccessToken || "", context.signal, context),
        context.signal
      );
      if (vscodeCommentHtml.ok) {
        return mapRead(vscodeCommentHtml.byCommentId, "vscode-auth-comment-page");
      }
      reasons.push(`vscode-auth-comment-page: ${vscodeCommentHtml.reason}`);
    } else {
      reasons.push("vscode-auth-web: no VS Code GitHub session");
      reasons.push("vscode-auth-comment-page: no VS Code GitHub session");
    }

    const ghToken = await readGhToken(repoRoot, context.signal);
    if (ghToken.ok) {
      const ghTokenHtml = await readWithToken(url, ghToken.token, context.signal, context);
      if (ghTokenHtml.ok) {
        return parsedRead(ghTokenHtml.html, "gh-token-web");
      }
      reasons.push(`gh-token-web: ${ghTokenHtml.reason}`);
      const ghCommentHtml = await readCommentPages(
        comments,
        (pageUrl) => readWithToken(pageUrl, ghToken.token, context.signal, context),
        context.signal
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
      const storedCookieHtml = await readWithCookie(url, options.webCookie, context.signal, context);
      if (storedCookieHtml.ok) {
        return parsedRead(storedCookieHtml.html, "stored-web-cookie");
      }
      reasons.push(`stored-web-cookie: ${storedCookieHtml.reason}`);
    } else {
      reasons.push("stored-web-cookie: not set");
    }

    const envCookie = process.env[WEB_COOKIE_ENV]?.trim();
    if (envCookie) {
      const envCookieHtml = await readWithCookie(url, envCookie, context.signal, context);
      if (envCookieHtml.ok) {
        return parsedRead(envCookieHtml.html, "env-web-cookie");
      }
      reasons.push(`env-web-cookie: ${envCookieHtml.reason}`);
    } else {
      reasons.push(`env-web-cookie: ${WEB_COOKIE_ENV} is not set`);
    }
    return emptyRead(reasons.join("; "));
  } finally { await context.dispose(); }
}

/**
 * gh api 로 github.com 웹 HTML 을 읽는다.
 * @param repoRoot gh 를 실행할 저장소 루트
 * @param url PR files 웹 URL
 * @returns HTML 또는 실패 이유
 */
async function readWithGhApi(
  repoRoot: string,
  url: string,
  signal?: AbortSignal
): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
  try {
    const html = await runGh(["api", url], repoRoot, { signal, operation: "suggested-changeset-web" });
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
  repoRoot: string,
  signal?: AbortSignal
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  try {
    const token = (await runGh(["auth", "token"], repoRoot, { signal, operation: "suggested-changeset-token" })).trim();
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
async function readWithToken(
  url: string,
  token: string,
  signal?: AbortSignal,
  context?: GitHubWebReadContext
): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
  const read = await readGitHubWebHtmlWithFragments(url, {
    Authorization: `Bearer ${token}`,
    Accept: "text/html",
    "User-Agent": "Git Simple Compare",
  }, signal, context);
  throwIfAborted(signal);
  return read;
}

/**
 * 명시적으로 제공된 GitHub 웹 쿠키로 PR files HTML 을 읽는다.
 * @param url PR files 웹 URL
 * @param cookie GitHub 웹 세션 Cookie 헤더 값
 * @returns HTML 또는 실패 이유
 */
async function readWithCookie(
  url: string,
  cookie: string,
  signal?: AbortSignal,
  context?: GitHubWebReadContext
): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
  const read = await readGitHubWebHtmlWithFragments(url, {
    Accept: "text/html",
    Cookie: cookie,
    "User-Agent": "Git Simple Compare",
  }, signal, context);
  throwIfAborted(signal);
  return read;
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
  readUrl: (url: string) => Promise<{ ok: true; html: string } | { ok: false; reason: string }>,
  signal?: AbortSignal
): Promise<{ ok: true; byCommentId: Map<string, string[]> } | { ok: false; reason: string }> {
  const urls = commentPageUrls(comments);
  if (!urls.length) {
    return { ok: false, reason: "no comment html_url" };
  }
  const result = new Map<string, string[]>();
  const failures: string[] = [];
  for (const url of urls) {
    throwIfAborted(signal);
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

/** 취소된 보조 조회가 다음 인증/HTML 경로로 진행하지 못하게 한다. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Suggested changeset request was cancelled.", "AbortError");
  }
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

/** 중복 문자열을 입력 순서대로 제거한다. */
function unique(values: string[]): string[] { return [...new Set(values)]; }

/** unknown 오류를 짧은 로그 문자열로 바꾼다. */
function errorText(error: unknown): string {
  return error instanceof Error && error.name === "AbortError" ? "request cancelled" : "GitHub CLI web request failed";
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
