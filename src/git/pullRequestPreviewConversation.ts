// PR preview Conversation 탭에 표시할 GitHub 대화 이력을 읽는 모듈.
// - 기존 PR 은 GitHub timeline/review/comment 를 합쳐 GitHub Conversation 탭에 가깝게 보여준다.
import { GhCliError } from "./ghCli";
import { readGitHubInteractive } from "./githubReadCache";
import { createGitHubReadSession, completeGitHubReadSession, gitHubReadSessionState, GitHubReadContextChangedError } from "./githubReadSession";
import { restRead } from "./githubReadRequest";
import { decodeRestPage, nextRestPage, GitHubRestPageError } from "./githubRestPages";
import { readSessionRestApiBase } from "./githubRestSession";
import { GitHubApiError } from "./githubApiError";
import type { GhExecute } from "./ghRunner";
import { splitRepositoryName } from "./githubRepository";

/** Conversation 탭 timeline 한 항목 */
export interface PullRequestConversationItem {
  kind: "body" | "comment" | "review" | "review_comment" | "event" | "commit";
  author: string;
  body: string;
  bodyText?: string;
  bodyHtml?: string;
  createdAt?: string;
  action?: string;
  state?: string;
  path?: string;
  line?: number;
  startLine?: number;
  originalLine?: number;
  originalStartLine?: number;
  side?: string;
  startSide?: string;
  diffHunk?: string;
  commitId?: string;
  url?: string;
}

interface PreviewPullRequestRef {
  number?: number;
  author?: string;
}

interface GhIssueComment {
  id?: number;
  body?: string;
  body_text?: string;
  body_html?: string;
  created_at?: string;
  html_url?: string;
  user?: { login?: string };
}

interface GhTimelineItem extends GhIssueComment {
  event?: string;
  actor?: { login?: string };
  commit_id?: string;
  created_at?: string;
  state?: string;
  submitted_at?: string;
  path?: string;
  line?: number;
  original_line?: number;
}

interface GhReview {
  id?: number;
  body?: string;
  body_text?: string;
  body_html?: string;
  state?: string;
  submitted_at?: string;
  html_url?: string;
  user?: { login?: string };
}

interface GhReviewComment extends GhIssueComment {
  path?: string;
  line?: number;
  original_line?: number;
  start_line?: number;
  original_start_line?: number;
  side?: string;
  start_side?: string;
  diff_hunk?: string;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * PR conversation timeline 을 만든다.
 * @param cwd gh 실행 경로
 * @param repository owner/name 저장소 이름
 * @param pr 기존 PR 정보. 없으면 staged preview timeline 을 만든다.
 * @param body PR 본문 또는 staged preview 본문
 * @param fallbackAuthor staged preview 작성자 fallback
 * @returns conversation timeline 항목
 */
export async function buildPullRequestConversation(
  cwd: string,
  repository: string | undefined,
  pr: PreviewPullRequestRef | undefined,
  body: string,
  fallbackAuthor: string,
  runner: GhExecute = readGitHubInteractive,
  signal?: AbortSignal
): Promise<PullRequestConversationItem[]> {
  signal?.throwIfAborted();
  const opening: PullRequestConversationItem = {
    kind: "body",
    author: pr?.author || fallbackAuthor,
    body,
  };
  if (!repository || !pr?.number) {
    return [opening];
  }
  const [owner, name] = splitRepositoryName(repository);
  const owns = !gitHubReadSessionState(runner), read = createGitHubReadSession(cwd, runner);
  const controller = new AbortController(), abort = () => controller.abort();
  let timedOut = false;
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, 30_000);
  if (signal?.aborted) abort();
  const streams = [
    readTimeline(cwd, owner, name, pr.number, read, controller.signal).catch(error => {
      if (!mayFallbackTimeline(error)) throw error;
      return undefined;
    }),
    readReviews(cwd, owner, name, pr.number, read, controller.signal),
    readReviewComments(cwd, owner, name, pr.number, read, controller.signal),
  ] as const;
  try {
    const [timeline, reviews, reviewComments] = await Promise.all(streams);
    const issueItems = timeline
      ? timeline.map(normalizeTimelineItem).filter(Boolean) as PullRequestConversationItem[]
      : (await readIssueComments(cwd, owner, name, pr.number, read, controller.signal)).map(normalizeComment);
    await completeGitHubReadSession(read, controller.signal, owns);
    return uniqueItems([opening, ...issueItems, ...reviews.map(normalizeReview), ...reviewComments.map(normalizeReviewComment)])
      .sort(compareConversationItems);
  } catch (error) {
    controller.abort(); await Promise.allSettled(streams);
    if (timedOut && !signal?.aborted) throw new GitHubApiError("timeout", "pr-preview-conversation");
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); }

}

/** GitHub timeline API 를 페이지 단위로 읽는다. */
async function readTimeline(
  cwd: string,
  owner: string,
  name: string,
  number: number,
  runner: GhExecute,
  signal?: AbortSignal
): Promise<GhTimelineItem[]> {
  return readPaged<GhTimelineItem>(cwd, owner, name, `issues/${number}/timeline`, undefined, runner, signal);
}

/** GitHub issue comments API 를 페이지 단위로 읽는다. */
async function readIssueComments(
  cwd: string,
  owner: string,
  name: string,
  number: number,
  runner: GhExecute,
  signal?: AbortSignal
): Promise<GhIssueComment[]> {
  return readPaged<GhIssueComment>(
    cwd,
    owner,
    name,
    `issues/${number}/comments`,
    ["Accept: application/vnd.github.full+json"], runner, signal
  );
}

/** PR review 제출 이력을 페이지 단위로 읽는다. */
async function readReviews(
  cwd: string,
  owner: string,
  name: string,
  number: number,
  runner: GhExecute,
  signal?: AbortSignal
): Promise<GhReview[]> {
  return readPaged<GhReview>(
    cwd,
    owner,
    name,
    `pulls/${number}/reviews`,
    ["Accept: application/vnd.github.full+json"], runner, signal
  );
}

/** PR inline review comment 를 페이지 단위로 읽는다. */
async function readReviewComments(
  cwd: string,
  owner: string,
  name: string,
  number: number,
  runner: GhExecute,
  signal?: AbortSignal
): Promise<GhReviewComment[]> {
  return readPaged<GhReviewComment>(
    cwd,
    owner,
    name,
    `pulls/${number}/comments`,
    ["Accept: application/vnd.github-commitcomment.full+json"], runner, signal
  );
}

/**
 * GitHub REST 배열 응답을 페이지네이션으로 읽는다.
 * @param cwd gh 실행 경로
 * @param owner GitHub owner
 * @param name repository 이름
 * @param route repository 하위 API route
 * @param headers GitHub custom media type 등 요청 헤더 목록
 */
async function readPaged<T>(
  cwd: string,
  owner: string,
  name: string,
  route: string,
  headers: string[] = ["Accept: application/vnd.github+json"],
  runner: GhExecute = readGitHubInteractive,
  signal?: AbortSignal
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const path = `/repos/${owner}/${name}/${route}?per_page=${PAGE_SIZE}&page=${page}`;
    const accept = headers.find(header => /^Accept:/i.test(header))?.slice(7).trim() ?? "application/vnd.github+json";
    const request = restRead(path, accept, ["api", ...headers.flatMap(header => ["-H", header]), path.slice(1)]);
    const out = await runner(request.args, cwd, { operation: "pr-preview-conversation", signal,
      request: { ...request.request, responseMode: "page" } });
    signal?.throwIfAborted();
    const result = decodeRestPage<T[]>(out);
    if (!Array.isArray(result.data)) throw new GitHubRestPageError("invalid-json");
    all.push(...result.data);
    if (nextRestPage(result, path, page, PAGE_SIZE, readSessionRestApiBase(runner)) === undefined) break;
    if (page === MAX_PAGES) throw new GitHubRestPageError("pagination");
  }
  return all;
}

/** timeline 미지원/일반 서버 오류만 같은 인증의 issue comments로 보완한다. 인증·취소·불완전 페이지는 실패한다. */
function mayFallbackTimeline(error: unknown): boolean {
  if (error instanceof GitHubRestPageError || error instanceof GitHubReadContextChangedError
    || error instanceof Error && error.name === "AbortError") return false;
  if (error instanceof GitHubApiError) return ["http", "network", "timeout"].includes(error.kind);
  if (error instanceof GhCliError) return !["ABORTED", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(String(error.code))
    && !/HTTP (?:401|403|429)|not authenticated|rate limit|authentication failed/i.test(error.message + " " + error.stderr);
  return true;
}

/** GitHub timeline 항목을 preview conversation 항목으로 바꾼다. */
function normalizeTimelineItem(item: GhTimelineItem): PullRequestConversationItem | undefined {
  if (item.event === "commented" || (!item.event && item.body !== undefined)) {
    return normalizeComment(item);
  }
  if (item.event === "committed") {
    return {
      kind: "commit",
      author: item.actor?.login || "unknown",
      body: "",
      action: "pushed a commit",
      commitId: item.commit_id,
      createdAt: item.created_at,
    };
  }
  if (!item.event) {
    return undefined;
  }
  return {
    kind: "event",
    author: item.actor?.login || "unknown",
    body: "",
    action: item.event.replace(/_/g, " "),
    state: item.state,
    createdAt: item.created_at || item.submitted_at,
    path: item.path,
    line: item.line || item.original_line,
  };
}

/** GitHub issue comment 를 preview conversation 항목으로 바꾼다. */
function normalizeComment(comment: GhIssueComment): PullRequestConversationItem {
  return {
    kind: "comment",
    author: comment.user?.login || "unknown",
    body: comment.body || comment.body_text || "",
    bodyText: comment.body_text || undefined,
    bodyHtml: comment.body_html || undefined,
    createdAt: comment.created_at,
    url: comment.html_url,
  };
}

/** PR review 제출 항목을 conversation 항목으로 바꾼다. */
function normalizeReview(review: GhReview): PullRequestConversationItem {
  return {
    kind: "review",
    author: review.user?.login || "unknown",
    body: review.body || review.body_text || "",
    bodyText: review.body_text || undefined,
    bodyHtml: review.body_html || undefined,
    action: reviewAction(review.state),
    state: review.state,
    createdAt: review.submitted_at,
    url: review.html_url,
  };
}

/** PR inline review comment 를 conversation 항목으로 바꾼다. */
function normalizeReviewComment(comment: GhReviewComment): PullRequestConversationItem {
  return {
    kind: "review_comment",
    author: comment.user?.login || "unknown",
    body: comment.body || comment.body_text || "",
    bodyText: comment.body_text || undefined,
    bodyHtml: comment.body_html || undefined,
    action: "commented on a file",
    path: comment.path,
    line: comment.line || comment.original_line,
    startLine: comment.start_line,
    originalLine: comment.original_line,
    originalStartLine: comment.original_start_line,
    side: comment.side,
    startSide: comment.start_side,
    diffHunk: comment.diff_hunk,
    createdAt: comment.created_at,
    url: comment.html_url,
  };
}

/** review state 를 GitHub Conversation 에 가까운 표시 action 으로 바꾼다. */
function reviewAction(state: string | undefined): string {
  switch ((state || "").toUpperCase()) {
    case "APPROVED":
      return "approved these changes";
    case "CHANGES_REQUESTED":
      return "requested changes";
    case "COMMENTED":
      return "reviewed";
    case "DISMISSED":
      return "dismissed a review";
    default:
      return "reviewed";
  }
}

/** 중복 API 응답을 URL/종류/시간 기준으로 제거한다. */
function uniqueItems(items: PullRequestConversationItem[]): PullRequestConversationItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = [item.url, item.kind, item.author, item.createdAt, item.action, item.path, item.line, item.body].join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** conversation 항목을 생성 시간순으로 정렬한다. */
function compareConversationItems(a: PullRequestConversationItem, b: PullRequestConversationItem): number {
  return timeValue(a.createdAt) - timeValue(b.createdAt);
}

/** 없는 시간은 body 초안이 맨 앞에 오도록 0 으로 처리한다. */
function timeValue(value: string | undefined): number {
  const date = value ? Date.parse(value) : 0;
  return Number.isFinite(date) ? date : 0;
}
