// Pull Request Review Center가 공유하는 순수 읽기 모델.
// - GitHub GraphQL 응답을 파일·스레드·대화 목록으로 정규화해 webview가 API 세부 형식을 모르도록 한다.
// - mutation 전 읽기 전용 수직 슬라이스에서도 outdated/resolved 같은 리뷰 판단 정보를 보존한다.
import type { PullRequestPreviewComment } from "./pullRequestPreviewFiles";
import { parsePullRequestReviewSuggestions, type PullRequestReviewSuggestion } from "./pullRequestReviewSuggestion";

/** Review Center에서 파일 탐색기에 표시할 변경 파일. */
export interface ReviewCenterFile {
  /** 저장소 루트 기준 현재 파일 경로 */
  path: string;
  /** 이름이 바뀐 파일의 이전 경로 */
  oldPath?: string;
  /** GitHub change type을 간단한 상태 코드로 정규화한 값 */
  status: "A" | "M" | "D" | "R" | "C" | "T";
  /** 추가 라인 수 */
  additions: number;
  /** 삭제 라인 수 */
  deletions: number;
  /** 현재 GitHub viewer가 파일을 검토 완료로 표시했는지 */
  isViewed: boolean;
}

/** 리뷰 스레드에 속한 대화 한 건. */
export interface ReviewCenterComment {
  /** GitHub node id */
  id: string;
  /** 작성자 login */
  author: string;
  /** Markdown 원문 */
  body: string;
  /** 작성 시각 */
  createdAt?: string;
  /** 본문에서 안전하게 추출한 GitHub suggestion fence 목록 */
  suggestions: PullRequestReviewSuggestion[];
}

/** 파일·라인 문맥과 해결 상태를 보존한 GitHub review thread. */
export interface ReviewCenterThread {
  /** GitHub review thread node id */
  id: string;
  /** 파일 경로. 위치를 잃은 thread는 비어 있을 수 있다. */
  path?: string;
  /** 현재 head의 끝 라인 */
  line?: number;
  /** multi-line thread 시작 라인 */
  startLine?: number;
  /** GitHub가 현재 head에서 위치를 잃었다고 표시했는지 */
  isOutdated: boolean;
  /** GitHub에서 thread가 해결되었는지 */
  isResolved: boolean;
  /** 시간순 댓글 목록 */
  comments: ReviewCenterComment[];
}

/** Review Center 편집기 패널의 읽기 전용 초기 스냅샷. */
export interface ReviewCenterSnapshot {
  /** owner/name GitHub 저장소 */
  repository: string;
  /** Pull Request 번호 */
  number: number;
  /** GitHub mutation에 쓰는 Pull Request node id */
  pullRequestId?: string;
  /** PR 제목 */
  title: string;
  /** GitHub 브라우저 URL */
  url: string;
  /** PR 본문 Markdown */
  body: string;
  /** PR 작성자 login */
  author: string;
  /** 현재 GitHub viewer login. 본인 댓글 action의 서버 측 재검사 기준이다. */
  viewer?: string;
  /** 현재 assignee login 목록 */
  assignees: string[];
  /** 현재 label name 목록 */
  labels: string[];
  /** 현재 연결된 repository-local milestone. 없으면 undefined */
  milestone?: { number: number; title: string };
  /** 현재 review request를 받은 사용자·팀 목록 */
  requestedReviewers: ReviewCenterRequestedReviewer[];
  /** viewer가 PR metadata를 변경할 수 있는지 GitHub가 제공한 권한 */
  viewerCanUpdate: boolean;
  /** 현재 workspace git ref로 native diff를 안전하게 열 수 있는지 여부 */
  canOpenNativeDiff?: boolean;
  /** 최근 갱신 시각 */
  updatedAt?: string;
  /** Draft 여부 */
  isDraft: boolean;
  /** GitHub review decision */
  reviewDecision?: string;
  /** GitHub merge 상태 */
  mergeStateStatus?: string;
  /** base branch 이름 */
  baseRefName: string;
  /** head branch 이름 */
  headRefName: string;
  /** head commit OID */
  headOid?: string;
  /** 첫 페이지 changed files */
  files: ReviewCenterFile[];
  /** 첫 페이지 review threads */
  threads: ReviewCenterThread[];
  /** GitHub files connection에 다음 페이지가 남았는지 */
  filesTruncated: boolean;
  /** 다음 files GraphQL page를 읽을 cursor. 없으면 첫 페이지가 마지막이다. */
  filesEndCursor?: string;
  /** GitHub reviewThreads connection에 다음 페이지가 남았는지 */
  threadsTruncated: boolean;
  /** 다음 reviewThreads GraphQL page를 읽을 cursor. 없으면 첫 페이지가 마지막이다. */
  threadsEndCursor?: string;
  /** 마지막으로 host가 읽은 시각 */
  refreshedAt: string;
}

/** Review Center가 사용자와 조직 팀을 구분해 표시할 requested reviewer. */
export interface ReviewCenterRequestedReviewer {
  /** GitHub requested reviewer union의 실제 종류 */
  kind: "user" | "team";
  /** user login 또는 team slug인 안정 식별자 */
  key: string;
  /** 화면에 표시할 user login 또는 team name */
  label: string;
}

/** 서비스가 받는 GraphQL 파일 node의 최소 형태. */
export interface GhReviewCenterFile {
  path?: string;
  previousFilename?: string | null;
  additions?: number;
  deletions?: number;
  changeType?: string;
  viewerViewedState?: string | null;
}

/** 서비스가 받는 GraphQL comment node의 최소 형태. */
export interface GhReviewCenterComment {
  id?: string;
  body?: string;
  createdAt?: string;
  author?: { login?: string } | null;
}

/** 서비스가 받는 GraphQL review thread node의 최소 형태. */
export interface GhReviewCenterThread {
  id?: string;
  path?: string | null;
  line?: number | null;
  startLine?: number | null;
  isOutdated?: boolean;
  isResolved?: boolean;
  comments?: { nodes?: Array<GhReviewCenterComment | null> | null } | null;
}

/** GitHub files·threads connection의 pageInfo 최소 형태. */
export interface GhReviewCenterConnection<T> {
  nodes?: Array<T | null> | null;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
}

/** files connection의 후속 페이지를 host와 webview 사이에 전달하는 읽기 모델. */
export interface ReviewCenterFilesPage {
  /** 현재 페이지에서 정규화한 changed file 목록 */
  files: ReviewCenterFile[];
  /** 다음 페이지가 남았는지 */
  hasNextPage: boolean;
  /** 다음 페이지 cursor */
  endCursor?: string;
}

/** reviewThreads connection의 후속 페이지를 host와 webview 사이에 전달하는 읽기 모델. */
export interface ReviewCenterThreadsPage {
  /** 현재 페이지에서 정규화한 review thread 목록 */
  threads: ReviewCenterThread[];
  /** 다음 페이지가 남았는지 */
  hasNextPage: boolean;
  /** 다음 페이지 cursor */
  endCursor?: string;
}

/** Commits 탭이 lazy로 표시할 Pull Request commit 한 건의 안전한 읽기 모델. */
export interface ReviewCenterCommit {
  /** commit SHA 전체값 */
  oid: string;
  /** 첫 줄 commit message */
  message: string;
  /** GitHub login을 알 수 있을 때의 작성자 */
  author?: string;
  /** author timestamp 또는 commit timestamp */
  authoredAt?: string;
}

/** Commits connection 첫 페이지와 다음 페이지 존재 여부. */
export interface ReviewCenterCommitsPage {
  /** 현재 page에서 정규화한 commit 목록 */
  commits: ReviewCenterCommit[];
  /** GitHub commits connection에 다음 page가 남았는지 */
  hasNextPage: boolean;
  /** 다음 page cursor. 현재 UI는 100개 cap을 명시하고 lazy 최초 page까지만 제공한다. */
  endCursor?: string;
}

/** GraphQL Commit node의 renderer-safe 최소 필드. */
export interface GhReviewCenterCommit {
  oid?: string;
  messageHeadline?: string;
  authoredDate?: string | null;
  committedDate?: string | null;
  author?: { name?: string; user?: { login?: string } | null } | null;
}

/** GraphQL PR node 하나를 Review Center 화면 모델로 안전하게 보정한다. */
export function normalizeReviewCenterSnapshot(
  repository: string,
  pullRequest: {
    number?: number;
    id?: string;
    title?: string;
    url?: string;
    body?: string;
    author?: { login?: string } | null;
    assignees?: { nodes?: Array<{ login?: string } | null> | null } | null;
    labels?: { nodes?: Array<{ name?: string } | null> | null } | null;
    milestone?: { number?: number; title?: string } | null;
    reviewRequests?: {
      nodes?: Array<{
        requestedReviewer?: { login?: string; slug?: string; name?: string } | null;
      } | null> | null;
    } | null;
    viewerCanUpdate?: boolean;
    updatedAt?: string;
    isDraft?: boolean;
    reviewDecision?: string | null;
    mergeStateStatus?: string | null;
    baseRefName?: string;
    headRefName?: string;
    headRefOid?: string;
    files?: GhReviewCenterConnection<GhReviewCenterFile> | null;
    reviewThreads?: GhReviewCenterConnection<GhReviewCenterThread> | null;
  },
  requestedNumber: number,
  refreshedAt = new Date().toISOString()
): ReviewCenterSnapshot {
  const number = validPositiveInteger(pullRequest.number) || requestedNumber;
  const title = pullRequest.title?.trim() || `Pull request #${number}`;
  const url = pullRequest.url?.trim() || "";
  if (!url) {
    throw new Error(`Pull request #${number} does not include a GitHub URL.`);
  }
  return {
    repository,
    number,
    pullRequestId: nonEmpty(pullRequest.id),
    title,
    url,
    body: pullRequest.body || "",
    author: pullRequest.author?.login?.trim() || "unknown",
    assignees: normalizeMetadataNames(pullRequest.assignees?.nodes || [], "login"),
    labels: normalizeMetadataNames(pullRequest.labels?.nodes || [], "name"),
    milestone: normalizeMilestone(pullRequest.milestone),
    requestedReviewers: normalizeRequestedReviewers(
      (pullRequest.reviewRequests?.nodes || []).map((node) => node?.requestedReviewer || null)
    ),
    viewerCanUpdate: Boolean(pullRequest.viewerCanUpdate),
    updatedAt: validTime(pullRequest.updatedAt),
    isDraft: Boolean(pullRequest.isDraft),
    reviewDecision: nonEmpty(pullRequest.reviewDecision),
    mergeStateStatus: nonEmpty(pullRequest.mergeStateStatus),
    baseRefName: pullRequest.baseRefName?.trim() || "",
    headRefName: pullRequest.headRefName?.trim() || "",
    headOid: nonEmpty(pullRequest.headRefOid),
    files: normalizeReviewCenterFiles(pullRequest.files?.nodes || []),
    threads: normalizeReviewCenterThreads(pullRequest.reviewThreads?.nodes || []),
    filesTruncated: connectionHasNextPage(pullRequest.files),
    filesEndCursor: connectionEndCursor(pullRequest.files),
    threadsTruncated: connectionHasNextPage(pullRequest.reviewThreads),
    threadsEndCursor: connectionEndCursor(pullRequest.reviewThreads),
    refreshedAt,
  };
}

/** GitHub Pull Request commits connection을 중복 없는 최신순 UI model로 정규화한다. */
export function normalizeReviewCenterCommitsPage(
  connection: GhReviewCenterConnection<GhReviewCenterCommit> | null | undefined
): ReviewCenterCommitsPage {
  const commits = new Map<string, ReviewCenterCommit>();
  for (const value of connection?.nodes || []) {
    const oid = value?.oid?.trim();
    if (!oid) continue;
    commits.set(oid, {
      oid,
      message: value?.messageHeadline?.trim() || oid.slice(0, 12),
      ...(nonEmpty(value?.author?.user?.login) || nonEmpty(value?.author?.name)
        ? { author: nonEmpty(value?.author?.user?.login) || nonEmpty(value?.author?.name) }
        : {}),
      ...(validTime(value?.authoredDate || undefined) || validTime(value?.committedDate || undefined)
        ? { authoredAt: validTime(value?.authoredDate || undefined) || validTime(value?.committedDate || undefined) }
        : {}),
    });
  }
  return { commits: [...commits.values()], hasNextPage: connectionHasNextPage(connection), endCursor: connectionEndCursor(connection) };
}

/** GraphQL milestone의 유효 번호와 표시 제목만 webview로 전달한다. */
function normalizeMilestone(value: { number?: number; title?: string } | null | undefined): { number: number; title: string } | undefined {
  const number = Number(value?.number);
  if (!Number.isInteger(number) || number <= 0) return undefined;
  return { number, title: value?.title?.trim() || `Milestone #${number}` };
}

/** GraphQL User/Team union을 명확한 kind·key·label 요청 목록으로 정규화한다. */
function normalizeRequestedReviewers(
  values: ReadonlyArray<{ login?: string; slug?: string; name?: string } | null>
): ReviewCenterRequestedReviewer[] {
  const reviewers = new Map<string, ReviewCenterRequestedReviewer>();
  for (const value of values) {
    const login = nonEmpty(value?.login);
    const slug = nonEmpty(value?.slug);
    if (login) reviewers.set(`user:${login}`, { kind: "user", key: login, label: login });
    if (slug) reviewers.set(`team:${slug}`, { kind: "team", key: slug, label: nonEmpty(value?.name) || slug });
  }
  return [...reviewers.values()].sort((left, right) => left.label.localeCompare(right.label));
}

/** assignee/label GraphQL node를 공백·중복 없는 안정 정렬 이름 목록으로 만든다. */
function normalizeMetadataNames(
  values: ReadonlyArray<{ login?: string; name?: string } | null>,
  key: "login" | "name"
): string[] {
  const names = new Set<string>();
  for (const value of values) {
    const name = nonEmpty(value?.[key]);
    if (name) names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

/** GraphQL files connection 한 페이지를 UI가 병합할 안전한 모델로 만든다. */
export function normalizeReviewCenterFilesPage(
  connection: GhReviewCenterConnection<GhReviewCenterFile> | null | undefined
): ReviewCenterFilesPage {
  return {
    files: normalizeReviewCenterFiles(connection?.nodes || []),
    hasNextPage: connectionHasUsableCursor(connection),
    endCursor: connectionEndCursor(connection),
  };
}

/** GraphQL reviewThreads connection 한 페이지를 UI가 병합할 안전한 모델로 만든다. */
export function normalizeReviewCenterThreadsPage(
  connection: GhReviewCenterConnection<GhReviewCenterThread> | null | undefined
): ReviewCenterThreadsPage {
  return {
    threads: normalizeReviewCenterThreads(connection?.nodes || []),
    hasNextPage: connectionHasUsableCursor(connection),
    endCursor: connectionEndCursor(connection),
  };
}

/** GitHub changed files를 현재 경로 기준으로 고유한 탐색기 목록으로 만든다. */
export function normalizeReviewCenterFiles(
  files: ReadonlyArray<GhReviewCenterFile | null>
): ReviewCenterFile[] {
  const normalized = new Map<string, ReviewCenterFile>();
  for (const file of files) {
    if (!file) {
      continue;
    }
    const path = file.path?.trim();
    if (!path) {
      continue;
    }
    const oldPath = nonEmpty(file.previousFilename);
    normalized.set(path, {
      path,
      ...(oldPath ? { oldPath } : {}),
      status: normalizeChangeType(file.changeType),
      additions: nonNegativeInteger(file.additions),
      deletions: nonNegativeInteger(file.deletions),
      isViewed: file.viewerViewedState === "VIEWED",
    });
  }
  return [...normalized.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/** GitHub review thread와 답글을 화면에서 안전하게 표시할 형태로 정규화한다. */
export function normalizeReviewCenterThreads(
  threads: ReadonlyArray<GhReviewCenterThread | null>
): ReviewCenterThread[] {
  const normalized = new Map<string, ReviewCenterThread>();
  for (const thread of threads) {
    const id = nonEmpty(thread?.id);
    if (!id) {
      continue;
    }
    normalized.set(id, {
      id,
      path: nonEmpty(thread?.path),
      line: validPositiveInteger(thread?.line),
      startLine: validPositiveInteger(thread?.startLine),
      isOutdated: Boolean(thread?.isOutdated),
      isResolved: Boolean(thread?.isResolved),
      comments: normalizeReviewCenterComments(thread?.comments?.nodes || []),
    });
  }
  return [...normalized.values()].sort(compareThreads);
}

/** 스레드 댓글을 생성 시각순으로 정렬하고 body 없는 API node도 명시적으로 보존한다. */
export function normalizeReviewCenterComments(
  comments: ReadonlyArray<GhReviewCenterComment | null>
): ReviewCenterComment[] {
  return comments
    .filter((comment): comment is GhReviewCenterComment => Boolean(comment?.id))
    .map((comment) => ({
      id: comment.id || "",
      author: comment.author?.login?.trim() || "unknown",
      body: comment.body || "",
      createdAt: validTime(comment.createdAt),
      suggestions: parsePullRequestReviewSuggestions(comment.body || ""),
    }))
    .sort((left, right) => Date.parse(left.createdAt || "") - Date.parse(right.createdAt || ""));
}

/**
 * 현재 head에 아직 위치가 남은 스레드를 native diff Comment API 입력으로 바꾼다.
 * @param snapshot Review Center가 읽은 PR 전체 스냅샷
 * @param path      현재 경로 기준으로 열려는 changed file
 * @returns 해당 파일의 현재 line comment decoration 목록
 */
export function reviewCenterPreviewCommentsForFile(
  snapshot: ReviewCenterSnapshot,
  path: string
): PullRequestPreviewComment[] {
  return snapshot.threads.flatMap((thread) => {
    if (thread.path !== path || thread.isOutdated || !thread.line) {
      return [];
    }
    return thread.comments.map((comment) => ({
      id: comment.id,
      parentId: thread.id,
      author: comment.author,
      body: comment.body,
      diffHunk: "",
      line: thread.line,
      startLine: thread.startLine,
      side: "RIGHT",
      startSide: thread.startLine ? "RIGHT" : undefined,
      createdAt: comment.createdAt,
    }));
  });
}

/** GitHub changeType enum을 기존 diff presenter가 이해하는 상태 코드로 바꾼다. */
function normalizeChangeType(value: string | undefined): ReviewCenterFile["status"] {
  switch ((value || "").toUpperCase()) {
    case "ADDED": return "A";
    case "DELETED": return "D";
    case "RENAMED": return "R";
    case "COPIED": return "C";
    case "CHANGED":
    case "TYPE_CHANGED": return "T";
    default: return "M";
  }
}

/** 스레드는 파일·라인 문맥을 우선하고 같으면 node id로 안정 정렬한다. */
function compareThreads(left: ReviewCenterThread, right: ReviewCenterThread): number {
  return (left.path || "").localeCompare(right.path || "")
    || (left.line || 0) - (right.line || 0)
    || left.id.localeCompare(right.id);
}

/** 0 이상 정수만 diff 통계로 인정한다. */
function nonNegativeInteger(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** 1-base 라인/번호에만 유효한 정수 값을 반환한다. */
function validPositiveInteger(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** GitHub가 보내는 ISO 시각이 유효할 때만 UI에 보낸다. */
function validTime(value: string | undefined): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** null/공백 문자열을 undefined로 정리한다. */
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** 다음 페이지가 있는 connection의 비어 있지 않은 cursor만 보존한다. */
function connectionEndCursor<T>(connection: GhReviewCenterConnection<T> | null | undefined): string | undefined {
  return connection?.pageInfo?.hasNextPage ? nonEmpty(connection.pageInfo.endCursor) : undefined;
}

/** GitHub가 뒤 페이지가 있다고 알린 사실을 cursor 유무와 독립해 보존한다. */
function connectionHasNextPage<T>(connection: GhReviewCenterConnection<T> | null | undefined): boolean {
  return Boolean(connection?.pageInfo?.hasNextPage);
}

/** lazy page 요청은 cursor가 실제로 있을 때만 허용한다. */
function connectionHasUsableCursor<T>(connection: GhReviewCenterConnection<T> | null | undefined): boolean {
  return Boolean(connectionHasNextPage(connection) && connectionEndCursor(connection));
}
