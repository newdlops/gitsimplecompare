// github.com 웹 페이지와 lazy-load fragment HTML 을 읽는 보조 모듈.
// - REST/GraphQL API 에 없는 GitHub 웹 전용 데이터를 읽을 때만 사용한다.
import * as https from "node:https";

const MAX_HTML_BYTES = 64 * 1024 * 1024;
const MAX_FRAGMENT_URLS = 120;
const MAX_FRAGMENT_DEPTH = 2;

/** GitHub 웹 HTML 읽기 성공/실패 결과 */
export type GitHubWebHtmlRead =
  | { ok: true; html: string }
  | { ok: false; reason: string };

/**
 * GitHub 웹 HTML 을 읽고, 페이지 안의 fragment URL 을 제한적으로 따라가 하나의 HTML 문자열로 합친다.
 * - GitHub PR files 화면은 큰 diff/comment 를 include-fragment 로 늦게 로드하므로,
 *   base HTML 만 읽으면 Copilot suggested changeset 이 빠질 수 있다.
 * - 쿠키/토큰 같은 민감한 인증 헤더는 호출자가 주입하고, 이 함수는 같은 origin/repo 경로만 따라간다.
 * @param url github.com 웹 URL
 * @param headers 요청에 사용할 HTTP 헤더
 * @returns base HTML 과 fragment HTML 을 합친 문자열 또는 실패 이유
 */
export async function readGitHubWebHtmlWithFragments(
  url: string,
  headers: Record<string, string>
): Promise<GitHubWebHtmlRead> {
  const base = await readGitHubWebHtml(url, headers);
  if (!base.ok) {
    return base;
  }
  const fragments = await readFragmentHtml(url, base.html, headers);
  return {
    ok: true,
    html: [base.html, ...fragments].join("\n"),
  };
}

/**
 * GitHub 웹 HTML 본문 하나를 읽는다.
 * - fragment 가 아닌 최상위 페이지용이라 `<html>` 과 GitHub 흔적이 있는 응답만 성공으로 본다.
 * @param url github.com 웹 URL
 * @param headers 요청에 사용할 HTTP 헤더
 * @returns GitHub HTML 또는 실패 이유
 */
export function readGitHubWebHtml(
  url: string,
  headers: Record<string, string>
): Promise<GitHubWebHtmlRead> {
  return readText(url, headers, true);
}

/**
 * base HTML 에 들어 있는 include-fragment/data-fragment-url 을 breadth-first 로 읽는다.
 * - 한 PR 페이지 안의 lazy diff/comment fragment 만 읽고 외부 URL 은 버린다.
 * - 일부 fragment 는 다시 하위 fragment 를 포함하므로 짧은 깊이 제한을 둔다.
 * @param baseUrl 기준 GitHub 웹 URL
 * @param baseHtml 이미 읽은 base HTML
 * @param headers 인증 헤더
 * @returns 성공적으로 읽은 fragment HTML 목록
 */
async function readFragmentHtml(
  baseUrl: string,
  baseHtml: string,
  headers: Record<string, string>
): Promise<string[]> {
  const queue = fragmentUrls(baseHtml, baseUrl).map((url) => ({ url, depth: 1 }));
  const seen = new Set<string>([normalizeUrl(baseUrl)]);
  const result: string[] = [];
  while (queue.length && seen.size <= MAX_FRAGMENT_URLS) {
    const next = queue.shift();
    if (!next) {
      break;
    }
    const normalized = normalizeUrl(next.url);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const read = await readText(next.url, headers, false);
    if (!read.ok) {
      continue;
    }
    result.push(read.html);
    if (next.depth >= MAX_FRAGMENT_DEPTH) {
      continue;
    }
    for (const child of fragmentUrls(read.html, baseUrl)) {
      if (!seen.has(normalizeUrl(child))) {
        queue.push({ url: child, depth: next.depth + 1 });
      }
    }
  }
  return result;
}

/**
 * HTML 속성에서 GitHub fragment URL 후보를 추출한다.
 * - include-fragment `src`, diff loader `data-fragment-url`, 일부 동적 영역의 `data-url` 을 함께 본다.
 * @param html 검색할 HTML
 * @param baseUrl 상대 URL 을 해석할 기준 URL
 * @returns 같은 GitHub repo/PR 안에 있는 URL 후보 목록
 */
function fragmentUrls(html: string, baseUrl: string): string[] {
  const result: string[] = [];
  const attrPattern = /\b(?:src|data-fragment-url|data-url)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrPattern)) {
    const value = decodeHtmlAttribute(match[1]);
    if (!looksLikeFragmentUrl(value)) {
      continue;
    }
    const url = toSamePullRequestUrl(value, baseUrl);
    if (url) {
      result.push(url);
    }
  }
  return unique(result);
}

/**
 * 속성값이 fragment/diff/comment 로딩 URL 처럼 보이는지 확인한다.
 * @param value HTML attribute value
 * @returns 따라가 볼 URL 이면 true
 */
function looksLikeFragmentUrl(value: string): boolean {
  return /(?:fragment|show_partial|diff|files|comments?|conversation|review_threads?|pull)/i.test(value);
}

/**
 * 후보 URL 을 같은 GitHub PR 경로 안의 절대 URL 로 정규화한다.
 * - 인증 쿠키가 외부로 나가지 않도록 origin 과 owner/repo/pull 번호를 제한한다.
 * @param value HTML 속성에서 읽은 URL
 * @param baseUrl 기준 PR URL
 * @returns 허용된 URL 또는 undefined
 */
function toSamePullRequestUrl(value: string, baseUrl: string): string | undefined {
  try {
    const base = new URL(baseUrl);
    const url = new URL(value, base);
    if (url.origin !== base.origin || url.hostname !== "github.com") {
      return undefined;
    }
    const basePull = pullPathPrefix(base.pathname);
    if (!basePull || !url.pathname.startsWith(basePull)) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * `/owner/repo/pull/123` 형태의 PR path prefix 를 구한다.
 * @param pathname URL pathname
 * @returns PR path prefix 또는 undefined
 */
function pullPathPrefix(pathname: string): string | undefined {
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(pathname);
  return match ? `/${match[1]}/${match[2]}/pull/${match[3]}` : undefined;
}

/**
 * HTTP GET 으로 텍스트 응답을 읽는다.
 * - 최상위 페이지는 GitHub HTML 여부를 확인하고, fragment 는 HTML 조각이면 그대로 허용한다.
 * @param url 읽을 URL
 * @param headers HTTP 요청 헤더
 * @param requireFullHtml 최상위 GitHub HTML 검증 여부
 * @returns 텍스트 응답 또는 실패 이유
 */
function readText(
  url: string,
  headers: Record<string, string>,
  requireFullHtml: boolean
): Promise<GitHubWebHtmlRead> {
  return new Promise((resolve) => {
    const request = https.get(url, { headers }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve({ ok: false, reason: `status ${response.statusCode}` });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_HTML_BYTES) {
          chunks.push(chunk);
        } else {
          request.destroy(new Error("web html response is too large"));
        }
      });
      response.on("end", () => {
        const html = Buffer.concat(chunks).toString("utf8");
        if (requireFullHtml && !isGitHubHtml(html)) {
          resolve({ ok: false, reason: "response was not GitHub HTML" });
          return;
        }
        if (!requireFullHtml && !looksLikeHtmlFragment(html)) {
          resolve({ ok: false, reason: "response was not HTML fragment" });
          return;
        }
        resolve({ ok: true, html });
      });
    });
    request.on("error", (error) => resolve({ ok: false, reason: error.message }));
    request.setTimeout(10000, () => request.destroy(new Error("web html request timed out")));
  });
}

/** HTML 응답이 GitHub 전체 페이지처럼 보이는지 확인한다. */
export function isGitHubHtml(value: string): boolean {
  return /<html\b/i.test(value) && /github/i.test(value);
}

/**
 * fragment 응답이 HTML 조각처럼 보이는지 확인한다.
 * @param value 응답 본문
 * @returns HTML 조각으로 파싱해 볼 수 있으면 true
 */
function looksLikeHtmlFragment(value: string): boolean {
  return /<[^>]+>/.test(value);
}

/**
 * URL 비교를 위해 fragment/hash 를 제거한다.
 * @param value URL 문자열
 * @returns 정규화된 URL 문자열
 */
function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * HTML attribute 안의 최소 entity 를 URL 문자로 되돌린다.
 * @param value HTML attribute value
 * @returns 디코딩된 attribute value
 */
function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

/** 중복 문자열을 입력 순서대로 제거한다. */
function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
