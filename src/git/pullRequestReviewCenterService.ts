// Pull Request Review Center의 상세 읽기 서비스.
// - queue 조회와 달리 선택된 PR 하나만 GraphQL로 읽어 파일/스레드 문맥을 빠르게 제공한다.
// - 파일과 thread 추가 페이지는 이후 lazy 요청으로 확장할 수 있도록 첫 페이지의 truncation을 보존한다.
import type { GhRunner } from "./ghRunner";
import { DefaultGhRunner } from "./ghRunner";
import {
  normalizeReviewCenterSnapshot,
  normalizeReviewCenterFilesPage,
  normalizeReviewCenterThreadsPage,
  type GhReviewCenterConnection,
  type GhReviewCenterFile,
  type GhReviewCenterThread,
  type ReviewCenterSnapshot,
  type ReviewCenterFilesPage,
  type ReviewCenterThreadsPage,
  type ReviewCenterCommitsPage,
  type GhReviewCenterCommit,
  normalizeReviewCenterCommitsPage,
} from "./pullRequestReviewCenterModel";
import {
  normalizeReviewCenterActivityPage,
  type GhReviewCenterActivityCommit,
  type GhReviewCenterActivityConnection,
  type GhReviewCenterIssueComment,
  type GhReviewCenterReviewActivity,
  type GhReviewCenterTimelineEvent,
  type ReviewCenterActivityPage,
} from "./pullRequestReviewActivityModel";

const REVIEW_CENTER_PAGE_SIZE = 100;

const REVIEW_CENTER_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $limit: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequest(number: $number) {
      number
      id
      title
      url
      body
      updatedAt
      isDraft
      reviewDecision
      mergeStateStatus
      baseRefName
      headRefName
      headRefOid
      author { login }
      assignees(first: 50) { nodes { login } }
      labels(first: 100) { nodes { name } }
      milestone { number title }
      requestedReviewers(first: 100) {
        nodes {
          ... on User { login }
          ... on Team { slug name }
        }
      }
      viewerCanUpdate
      files(first: $limit) {
        nodes { path additions deletions changeType viewerViewedState }
        pageInfo { hasNextPage endCursor }
      }
      reviewThreads(first: $limit) {
        nodes {
          id
          path
          line
          startLine
          isOutdated
          isResolved
          comments(first: 100) {
            nodes { id body createdAt author { login } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const REVIEW_CENTER_FILES_PAGE_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String!, $limit: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: $limit, after: $cursor) {
        nodes { path additions deletions changeType viewerViewedState }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const MARK_FILE_VIEWED_MUTATION = `
mutation($pullRequestId: ID!, $path: String!) {
  markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId }
}`;

const UNMARK_FILE_VIEWED_MUTATION = `
mutation($pullRequestId: ID!, $path: String!) {
  unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId }
}`;

const RESOLVE_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { clientMutationId }
}`;

const UNRESOLVE_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { clientMutationId }
}`;

const REVIEW_CENTER_THREADS_PAGE_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String!, $limit: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: $limit, after: $cursor) {
        nodes {
          id path line startLine isOutdated isResolved
          comments(first: 100) { nodes { id body createdAt author { login } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const REVIEW_CENTER_COMMITS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $limit: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: $limit) {
        nodes { commit { oid messageHeadline authoredDate committedDate author { name user { login } } } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/** Activity 기본 connection과 선택 event fragment를 함께 조립해 오래된 GitHub schema fallback도 유지한다. */
function reviewCenterActivityQuery(includeEvents: boolean): string {
  return `
query($owner: String!, $name: String!, $number: Int!, $limit: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(last: $limit) {
        nodes { id body createdAt author { login } }
        pageInfo { hasPreviousPage }
      }
      reviews(last: $limit) {
        nodes { id body state submittedAt author { login } }
        pageInfo { hasPreviousPage }
      }
      commits(last: $limit) {
        nodes { commit { oid messageHeadline authoredDate committedDate author { name user { login } } } }
        pageInfo { hasPreviousPage }
      }
      ${includeEvents ? `timelineItems(last: $limit) {
        nodes {
          __typename
          ... on HeadRefForcePushedEvent { id createdAt actor { login } beforeCommit { oid } afterCommit { oid } }
          ... on ReviewRequestedEvent { id createdAt actor { login } requestedReviewer { ... on User { login } ... on Team { slug name } } }
          ... on AssignedEvent { id createdAt actor { login } assignee { ... on User { login } } }
          ... on LabeledEvent { id createdAt actor { login } label { name } }
          ... on MilestonedEvent { id createdAt actor { login } milestoneTitle }
          ... on ConvertToDraftEvent { id createdAt actor { login } }
          ... on ReadyForReviewEvent { id createdAt actor { login } }
        }
        pageInfo { hasPreviousPage }
      }` : ""}
    }
  }
}`;
}

const REVIEW_CENTER_ACTIVITY_QUERY = reviewCenterActivityQuery(true);
const REVIEW_CENTER_ACTIVITY_CORE_QUERY = reviewCenterActivityQuery(false);

/** GraphQL Query의 선택 필드만 표현한 응답 타입. */
interface GhReviewCenterResponse {
  data?: {
    viewer?: { login?: string } | null;
    repository?: {
      nameWithOwner?: string;
      pullRequest?: {
        number?: number;
        id?: string;
        title?: string;
        url?: string;
        body?: string;
        author?: { login?: string } | null;
        assignees?: { nodes?: Array<{ login?: string } | null> | null } | null;
        labels?: { nodes?: Array<{ name?: string } | null> | null } | null;
        milestone?: { number?: number; title?: string } | null;
        requestedReviewers?: { nodes?: Array<{ login?: string; slug?: string; name?: string } | null> | null } | null;
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
      } | null;
    };
  };
}

/** GraphQL files 후속 페이지 응답의 최소 형태. */
interface GhReviewCenterFilesPageResponse {
  data?: { repository?: { pullRequest?: { files?: GhReviewCenterConnection<GhReviewCenterFile> | null } | null } | null };
}

/** GraphQL reviewThreads 후속 페이지 응답의 최소 형태. */
interface GhReviewCenterThreadsPageResponse {
  data?: { repository?: { pullRequest?: { reviewThreads?: GhReviewCenterConnection<GhReviewCenterThread> | null } | null } | null };
}

/** GraphQL commits lazy page 응답의 최소 형태. */
interface GhReviewCenterCommitsResponse {
  data?: { repository?: { pullRequest?: { commits?: GhReviewCenterConnection<{ commit?: GhReviewCenterCommit | null }> | null } | null } | null };
}

/** Activity lazy query가 반환하는 세 connection의 최소 응답 형태. */
interface GhReviewCenterActivityResponse {
  data?: {
    repository?: {
      pullRequest?: {
        comments?: GhReviewCenterActivityConnection<GhReviewCenterIssueComment> | null;
        reviews?: GhReviewCenterActivityConnection<GhReviewCenterReviewActivity> | null;
        commits?: GhReviewCenterActivityConnection<{ commit?: GhReviewCenterActivityCommit | null }> | null;
        timelineItems?: GhReviewCenterActivityConnection<GhReviewCenterTimelineEvent> | null;
      } | null;
    } | null;
  };
}

/** Review Center 상세 조회의 취소 옵션. */
export interface ReviewCenterRequestOptions {
  /** 새 PR 선택 또는 패널 dispose 시 중단할 gh 실행 신호 */
  signal?: AbortSignal;
  /** team scope처럼 현재 workspace와 다른 repository의 PR을 열 때 쓸 owner/name */
  repository?: string;
}

/** 선택 PR 하나의 파일·스레드 읽기 모델을 생성하는 GitHub 서비스. */
export class PullRequestReviewCenterService {
  /** 기본 gh runner 외에 fixture runner를 주입해 서비스 계약을 검증할 수 있다. */
  public constructor(
    private readonly repoRoot: string,
    private readonly runner: GhRunner = new DefaultGhRunner()
  ) {}

  /**
   * PR 번호 하나의 첫 상세 페이지를 읽는다.
   * @param number 조회할 GitHub Pull Request 번호
   * @param options 패널 lifecycle과 연결된 선택적 취소 신호
   * @returns 파일/스레드와 페이지 잘림 여부를 포함한 Review Center 스냅샷
   */
  public async getSnapshot(
    number: number,
    options: ReviewCenterRequestOptions = {}
  ): Promise<ReviewCenterSnapshot> {
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error("A valid pull request number is required for Review Center.");
    }
    const repository = options.repository || await this.runner.runJson<{ nameWithOwner?: string }>(
      ["repo", "view", "--json", "nameWithOwner"],
      this.repoRoot,
      { operation: "review.center.repository", signal: options.signal }
    );
    const [owner, name] = splitRepository(typeof repository === "string" ? repository : repository.nameWithOwner);
    const response = await this.runner.runJson<GhReviewCenterResponse>(
      [
        "api", "graphql",
        "-F", `owner=${owner}`,
        "-F", `name=${name}`,
        "-F", `number=${number}`,
        "-F", `limit=${REVIEW_CENTER_PAGE_SIZE}`,
        "-f", `query=${REVIEW_CENTER_QUERY}`,
      ],
      this.repoRoot,
      { operation: "review.center.snapshot", signal: options.signal }
    );
    const resultRepository = response.data?.repository?.nameWithOwner?.trim();
    const pullRequest = response.data?.repository?.pullRequest;
    if (!resultRepository || !pullRequest) {
      throw new Error(`Pull request #${number} is not available in this GitHub repository.`);
    }
    const snapshot = normalizeReviewCenterSnapshot(resultRepository, pullRequest, number);
    const viewer = response.data?.viewer?.login?.trim();
    return viewer ? { ...snapshot, viewer } : snapshot;
  }

  /**
   * 첫 snapshot 뒤에 남은 changed files 한 페이지를 읽는다.
   * @param repository snapshot이 확정한 owner/name 저장소
   * @param number     조회 중인 PR 번호
   * @param cursor     files connection의 직전 endCursor
   * @param options    panel lifecycle과 연결된 취소 신호
   * @returns 다음 files 페이지와 다음 cursor 여부
   */
  public async getFilesPage(
    repository: string,
    number: number,
    cursor: string,
    options: ReviewCenterRequestOptions = {}
  ): Promise<ReviewCenterFilesPage> {
    const [owner, name] = splitRepository(repository);
    const response = await this.runner.runJson<GhReviewCenterFilesPageResponse>(
      graphqlArgs(owner, name, number, cursor, REVIEW_CENTER_FILES_PAGE_QUERY),
      this.repoRoot,
      { operation: "review.center.files.page", signal: options.signal }
    );
    const connection = response.data?.repository?.pullRequest?.files;
    if (!connection) throw new Error(`Additional changed files are unavailable for pull request #${number}.`);
    return normalizeReviewCenterFilesPage(connection);
  }

  /**
   * 첫 snapshot 뒤에 남은 review thread 한 페이지를 읽는다.
   * @param repository snapshot이 확정한 owner/name 저장소
   * @param number     조회 중인 PR 번호
   * @param cursor     reviewThreads connection의 직전 endCursor
   * @param options    panel lifecycle과 연결된 취소 신호
   * @returns 다음 thread 페이지와 다음 cursor 여부
   */
  public async getThreadsPage(
    repository: string,
    number: number,
    cursor: string,
    options: ReviewCenterRequestOptions = {}
  ): Promise<ReviewCenterThreadsPage> {
    const [owner, name] = splitRepository(repository);
    const response = await this.runner.runJson<GhReviewCenterThreadsPageResponse>(
      graphqlArgs(owner, name, number, cursor, REVIEW_CENTER_THREADS_PAGE_QUERY),
      this.repoRoot,
      { operation: "review.center.threads.page", signal: options.signal }
    );
    const connection = response.data?.repository?.pullRequest?.reviewThreads;
    if (!connection) throw new Error(`Additional review threads are unavailable for pull request #${number}.`);
    return normalizeReviewCenterThreadsPage(connection);
  }

  /** Commits 탭을 열었을 때만 최신 Pull Request commit 첫 페이지를 읽는다. */
  public async getCommitsPage(
    repository: string,
    number: number,
    options: ReviewCenterRequestOptions = {}
  ): Promise<ReviewCenterCommitsPage> {
    const [owner, name] = splitRepository(repository);
    const response = await this.runner.runJson<GhReviewCenterCommitsResponse>(
      [
        "api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`, "-F", `limit=${REVIEW_CENTER_PAGE_SIZE}`,
        "-f", `query=${REVIEW_CENTER_COMMITS_QUERY}`,
      ],
      this.repoRoot,
      { operation: "review.center.commits.page", signal: options.signal }
    );
    const connection = response.data?.repository?.pullRequest?.commits;
    if (!connection) throw new Error(`Pull request commits are unavailable for pull request #${number}.`);
    return normalizeReviewCenterCommitsPage({ nodes: connection.nodes?.map((node) => node?.commit || null) || [], pageInfo: connection.pageInfo });
  }

  /** Activity 탭을 열었을 때만 issue comment·review·commit 첫 page를 읽어 공통 타임라인으로 합친다. */
  public async getActivityPage(
    repository: string,
    number: number,
    options: ReviewCenterRequestOptions = {}
  ): Promise<ReviewCenterActivityPage> {
    const [owner, name] = splitRepository(repository);
    let eventsAvailable = true;
    let response: GhReviewCenterActivityResponse;
    try {
      response = await this.getActivityResponse(owner, name, number, REVIEW_CENTER_ACTIVITY_QUERY, options, "review.center.activity.page");
    } catch (error) {
      if (!isUnsupportedTimelineEventsError(error)) throw error;
      eventsAvailable = false;
      response = await this.getActivityResponse(owner, name, number, REVIEW_CENTER_ACTIVITY_CORE_QUERY, options, "review.center.activity.core");
    }
    const pullRequest = response.data?.repository?.pullRequest;
    if (!pullRequest) throw new Error(`Pull request activity is unavailable for pull request #${number}.`);
    return normalizeReviewCenterActivityPage(pullRequest.comments, pullRequest.reviews, pullRequest.commits, pullRequest.timelineItems, eventsAvailable);
  }

  /** Activity query의 공통 gh 인자·operation 조립을 한 곳에 유지한다. */
  private getActivityResponse(
    owner: string,
    name: string,
    number: number,
    query: string,
    options: ReviewCenterRequestOptions,
    operation: string
  ): Promise<GhReviewCenterActivityResponse> {
    return this.runner.runJson<GhReviewCenterActivityResponse>(
      ["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`, "-F", `limit=${REVIEW_CENTER_PAGE_SIZE}`, "-f", `query=${query}`],
      this.repoRoot,
      { operation, signal: options.signal }
    );
  }

  /**
   * 현재 viewer의 서버 Viewed 상태를 변경한다.
   * @param pullRequestId GraphQL Pull Request node id
   * @param path          저장소 루트 기준 changed file 경로
   * @param viewed        true면 viewed, false면 unviewed로 변경할지 여부
   * @param options       panel dispose/refresh와 연결된 취소 신호
   */
  public async setFileViewed(
    pullRequestId: string,
    path: string,
    viewed: boolean,
    options: ReviewCenterRequestOptions = {}
  ): Promise<void> {
    if (!pullRequestId.trim() || !path.trim()) {
      throw new Error("The pull request file cannot be marked as viewed.");
    }
    await this.runner.runJson(
      [
        "api", "graphql",
        "-F", `pullRequestId=${pullRequestId}`,
        "-F", `path=${path}`,
        "-f", `query=${viewed ? MARK_FILE_VIEWED_MUTATION : UNMARK_FILE_VIEWED_MUTATION}`,
      ],
      this.repoRoot,
      { operation: viewed ? "review.center.files.viewed" : "review.center.files.unviewed", signal: options.signal }
    );
  }

  /**
   * GitHub review thread의 해결 상태를 바꾼다.
   * @param threadId GitHub PullRequestReviewThread node id
   * @param resolved true면 resolve, false면 unresolve할지 여부
   * @param options  panel dispose/refresh와 연결된 취소 신호
   */
  public async setThreadResolved(
    threadId: string,
    resolved: boolean,
    options: ReviewCenterRequestOptions = {}
  ): Promise<void> {
    if (!threadId.trim()) {
      throw new Error("The review thread cannot be updated.");
    }
    await this.runner.runJson(
      [
        "api", "graphql",
        "-F", `threadId=${threadId}`,
        "-f", `query=${resolved ? RESOLVE_REVIEW_THREAD_MUTATION : UNRESOLVE_REVIEW_THREAD_MUTATION}`,
      ],
      this.repoRoot,
      { operation: resolved ? "review.center.threads.resolve" : "review.center.threads.unresolve", signal: options.signal }
    );
  }
}

/** files/thread 후속 page query가 공유하는 GraphQL CLI 인자 배열을 만든다. */
function graphqlArgs(owner: string, name: string, number: number, cursor: string, query: string): string[] {
  return [
    "api", "graphql",
    "-F", `owner=${owner}`,
    "-F", `name=${name}`,
    "-F", `number=${number}`,
    "-F", `cursor=${cursor}`,
    "-F", `limit=${REVIEW_CENTER_PAGE_SIZE}`,
    "-f", `query=${query}`,
  ];
}

/** owner/name GitHub repository 이름만 GraphQL 변수로 분리한다. */
function splitRepository(repository: string | undefined): [string, string] {
  const [owner, name, extra] = (repository || "").trim().split("/");
  if (!owner || !name || extra) {
    throw new Error("GitHub repository name is unavailable for Review Center.");
  }
  return [owner, name];
}

/** timelineItems 또는 최신 event type이 없는 GitHub schema 오류만 core query fallback 대상으로 좁힌다. */
function isUnsupportedTimelineEventsError(error: unknown): boolean {
  const detail = [
    error instanceof Error ? error.message : "",
    typeof error === "object" && error !== null && "stderr" in error ? String((error as { stderr?: unknown }).stderr || "") : "",
  ].join(" ");
  return /cannot query field\s+"?timelineItems"?|unknown (type|field).*?(HeadRefForcePushedEvent|ReviewRequestedEvent|ReadyForReviewEvent|timelineItems)/i.test(detail);
}
