// PR preview Conversation 탭에 표시할 GitHub 대화 이력을 읽는 모듈.
// - 기존 PR 은 GitHub timeline/review/comment 를 합쳐 GitHub Conversation 탭에 가깝게 보여준다.
import { runGh } from "./ghCli";
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
  fallbackAuthor: string
): Promise<PullRequestConversationItem[]> {
  const opening: PullRequestConversationItem = {
    kind: "body",
    author: pr?.author || fallbackAuthor,
    body,
  };
  if (!repository || !pr?.number) {
    return [opening];
  }
  const [owner, name] = splitRepositoryName(repository);
  const [timeline, reviews, reviewComments] = await Promise.all([
    readTimeline(cwd, owner, name, pr.number).catch(() => undefined),
    readReviews(cwd, owner, name, pr.number).catch(() => []),
    readReviewComments(cwd, owner, name, pr.number).catch(() => []),
  ]);
  const issueItems = timeline
    ? timeline.map(normalizeTimelineItem).filter(Boolean) as PullRequestConversationItem[]
    : (await readIssueComments(cwd, owner, name, pr.number).catch(() => [])).map(normalizeComment);
  return uniqueItems([
    opening,
    ...issueItems,
    ...reviews.map(normalizeReview),
    ...reviewComments.map(normalizeReviewComment),
  ]).sort(compareConversationItems);
}

/** GitHub timeline API 를 페이지 단위로 읽는다. */
async function readTimeline(
  cwd: string,
  owner: string,
  name: string,
  number: number
): Promise<GhTimelineItem[]> {
  return readPaged<GhTimelineItem>(cwd, owner, name, `issues/${number}/timeline`);
}

/** GitHub issue comments API 를 페이지 단위로 읽는다. */
async function readIssueComments(
  cwd: string,
  owner: string,
  name: string,
  number: number
): Promise<GhIssueComment[]> {
  return readPaged<GhIssueComment>(
    cwd,
    owner,
    name,
    `issues/${number}/comments`,
    ["Accept: application/vnd.github.full+json"]
  );
}

/** PR review 제출 이력을 페이지 단위로 읽는다. */
async function readReviews(
  cwd: string,
  owner: string,
  name: string,
  number: number
): Promise<GhReview[]> {
  return readPaged<GhReview>(
    cwd,
    owner,
    name,
    `pulls/${number}/reviews`,
    ["Accept: application/vnd.github.full+json"]
  );
}

/** PR inline review comment 를 페이지 단위로 읽는다. */
async function readReviewComments(
  cwd: string,
  owner: string,
  name: string,
  number: number
): Promise<GhReviewComment[]> {
  return readPaged<GhReviewComment>(
    cwd,
    owner,
    name,
    `pulls/${number}/comments`,
    ["Accept: application/vnd.github-commitcomment.full+json"]
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
  headers: string[] = ["Accept: application/vnd.github+json"]
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const out = await runGh([
      "api",
      ...headers.flatMap((header) => ["-H", header]),
      `repos/${owner}/${name}/${route}?per_page=${PAGE_SIZE}&page=${page}`,
    ], cwd);
    const items = JSON.parse(out) as T[];
    all.push(...items);
    if (items.length < PAGE_SIZE) {
      break;
    }
  }
  return all;
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
