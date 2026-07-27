// GitHub Pull Request 리뷰 홈의 읽기 전용 조회 서비스.
// - 모든 외부 호출은 주입 가능한 GhRunner로 모아 테스트가 실제 gh/네트워크에 의존하지 않게 한다.
// - 개인 리뷰와 팀/조직 관리 큐를 같은 스냅샷에서 독립적으로 읽어 한쪽 실패를 다른 쪽에 숨기지 않는다.
import type { GhRunner } from "./ghRunner";
import { DefaultGhRunner } from "./ghRunner";
import { isReviewQueueAbort, toReviewQueueFailure } from "./pullRequestReviewQueueFailure";
import {
  normalizeReviewQueuePullRequests,
  type GhReviewQueuePullRequest,
  type ReviewQueueLane,
  type ReviewQueuePullRequest,
  type ReviewQueueSnapshot,
} from "./pullRequestReviewModel";

const REVIEW_QUEUE_LIMIT = 50;

interface ReviewQueueSearchResult {
  pullRequests: ReviewQueuePullRequest[];
  truncated: boolean;
  nextCursor?: string;
}

const REVIEW_QUEUE_FIELDS = `
        repository { nameWithOwner }
        number
        title
        url
        updatedAt
        isDraft
        reviewDecision
        mergeStateStatus
        author { login }
        assignees(first: 20) { nodes { login } }
        labels(first: 20) { nodes { name } }
        reviewRequests(first: 20) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Team { slug organization { login } }
            }
          }
        }`;

const VIEWER_AND_REPOSITORY_QUERY = `
query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) { nameWithOwner }
}`;

const SEARCH_PULL_REQUESTS_QUERY = `
query($searchQuery: String!, $limit: Int!, $cursor: String) {
    search(query: $searchQuery, type: ISSUE, first: $limit, after: $cursor) {
      pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
${REVIEW_QUEUE_FIELDS}
      }
    }
  }
}`;

/** 리뷰 홈이 사용할 gh GraphQL viewer/repository 응답의 최소 형태. */
interface GhViewerRepositoryResponse {
  data?: {
    viewer?: { login?: string };
    repository?: { nameWithOwner?: string };
  };
}

/** GitHub search GraphQL 응답의 최소 형태. */
interface GhReviewQueueSearchResponse {
  data?: {
    search?: { nodes?: Array<GhReviewQueuePullRequest | null>; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null };
  };
}

/** 리뷰 홈 큐 조회를 위한 선택적 취소 신호. */
export interface ReviewQueueRequestOptions {
  /** 새 refresh가 기존 요청을 교체할 때 전달하는 취소 신호 */
  signal?: AbortSignal;
  /** 같은 refresh에서 이미 확인한 viewer/repository identity. 중복 identity API 호출을 막는다. */
  identity?: ReviewQueueIdentity;
  /** Management 탭에서 선택한 local saved queue의 추가 GitHub search qualifier */
  managementQuery?: string;
  /** 현재 저장소, owner 전체, 또는 조직 팀이 review를 요청한 PR 범위 */
  managementScope?: { kind: "repository" } | { kind: "owner"; owner: string } | { kind: "team"; team: string };
}

/** GitHub CLI가 확인한 현재 viewer와 canonical owner/name repository. */
export interface ReviewQueueIdentity {
  /** 인증된 GitHub 사용자 login */
  viewer: string;
  /** GitHub가 해석한 canonical owner/name repository */
  repository: string;
}

/** GitHub Reviews 홈에 필요한 개인/관리 큐를 읽는 서비스. */
export class PullRequestReviewQueueService {
  /** 기본 runner를 쓰되, 테스트에서는 fixture runner를 주입할 수 있다. */
  public constructor(
    private readonly repoRoot: string,
    private readonly runner: GhRunner = new DefaultGhRunner()
  ) {}

  /**
   * 현재 GitHub 사용자와 저장소 기준으로 Personal·Management 큐를 함께 읽는다.
   * @param options 화면이 숨겨지거나 더 최신 refresh가 시작됐을 때의 취소 신호
   * @returns 동일 repository에 대한 개인/관리 리뷰 스냅샷
   */
  public async getSnapshot(
    options: ReviewQueueRequestOptions = {}
  ): Promise<ReviewQueueSnapshot> {
    const identity = options.identity || await this.getIdentity(options.signal);
    const lanes: ReadonlyArray<{ lane: ReviewQueueLane; read: Promise<ReviewQueueSearchResult> }> = [
      { lane: "personal.requested", read: this.searchLane(identity.repository, "personal.requested", options) },
      { lane: "personal.authored", read: this.searchLane(identity.repository, "personal.authored", options) },
      { lane: "personal.assigned", read: this.searchLane(identity.repository, "personal.assigned", options) },
      { lane: "personal.mentioned", read: this.searchLane(identity.repository, "personal.mentioned", options) },
      { lane: "personal.participated", read: this.searchLane(identity.repository, "personal.participated", options) },
      { lane: "management.open", read: this.searchLane(identity.repository, "management.open", options) },
    ];
    const results = await Promise.allSettled(lanes.map((item) => item.read));
    const values = new Map<ReviewQueueLane, ReviewQueuePullRequest[]>();
    const unavailableLanes: ReviewQueueLane[] = [];
    const truncatedLanes: ReviewQueueLane[] = [];
    const nextCursors: Partial<Record<ReviewQueueLane, string>> = {};
    results.forEach((result, index) => {
      const lane = lanes[index].lane;
      if (result.status === "fulfilled") {
        values.set(lane, result.value.pullRequests);
        if (result.value.truncated) truncatedLanes.push(lane);
        if (result.value.nextCursor) nextCursors[lane] = result.value.nextCursor;
      }
      else unavailableLanes.push(lane);
    });
    return {
      repository: identity.repository,
      viewer: identity.viewer,
      personal: {
        requested: values.get("personal.requested") || [],
        authored: values.get("personal.authored") || [],
        assigned: values.get("personal.assigned") || [],
        mentioned: values.get("personal.mentioned") || [],
        participated: values.get("personal.participated") || [],
      },
      management: { open: values.get("management.open") || [] },
      ...(unavailableLanes.length ? { unavailableLanes } : {}),
      ...(truncatedLanes.length ? { truncatedLanes } : {}),
      ...(Object.keys(nextCursors).length ? { nextCursors } : {}),
      refreshedAt: new Date().toISOString(),
    };
  }

  /**
   * cache key와 header에 쓸 현재 GitHub identity만 먼저 확인한다.
   * @param signal view가 숨겨지거나 새 refresh가 시작됐을 때 취소할 신호
   * @returns 인증된 viewer와 canonical repository. token이나 raw remote는 반환하지 않는다.
   */
  public async getIdentity(signal?: AbortSignal): Promise<ReviewQueueIdentity> {
    try {
      return await this.readViewerAndRepository(signal);
    } catch (error) {
      if (isReviewQueueAbort(error) || signal?.aborted) throw error;
      throw toReviewQueueFailure(error);
    }
  }

  /** 현재 snapshot의 cursor 뒤에 있는 lane 한 page를 같은 scope/query로 읽는다. */
  public async getNextPage(
    repository: string,
    lane: ReviewQueueLane,
    cursor: string,
    options: ReviewQueueRequestOptions = {}
  ): Promise<ReviewQueueSearchResult> {
    if (!cursor.trim()) throw new Error("A review queue cursor is required to load more pull requests.");
    try {
      return await this.searchLane(repository, lane, options, cursor);
    } catch (error) {
      if (isReviewQueueAbort(error) || options.signal?.aborted) throw error;
      throw toReviewQueueFailure(error);
    }
  }

  /** personal과 management lane id를 GitHub search qualifier와 operation 이름으로 변환한다. */
  private searchLane(
    repository: string,
    lane: ReviewQueueLane,
    options: ReviewQueueRequestOptions,
    cursor?: string
  ): Promise<ReviewQueueSearchResult> {
    const values: Record<ReviewQueueLane, { qualifier: string; operation: string; repository?: string }> = {
      "personal.requested": { qualifier: "review-requested:@me", operation: "review.queue.personal.requested" },
      "personal.authored": { qualifier: "author:@me", operation: "review.queue.personal.authored" },
      "personal.assigned": { qualifier: "assignee:@me", operation: "review.queue.personal.assigned" },
      "personal.mentioned": { qualifier: "mentions:@me", operation: "review.queue.personal.mentioned" },
      "personal.participated": { qualifier: "involves:@me -author:@me", operation: "review.queue.personal.participated" },
      "management.open": { qualifier: managementQualifier(options.managementScope, options.managementQuery), operation: "review.queue.management.open", repository: options.managementScope?.kind === "repository" || !options.managementScope ? repository : undefined },
    };
    const target = values[lane];
    return this.search(target.repository === undefined && lane !== "management.open" ? repository : target.repository, target.qualifier, target.operation, options.signal, cursor);
  }

  /** GitHub viewer login과 gh가 인식한 owner/name 저장소를 동시에 확인한다. */
  private async readViewerAndRepository(signal?: AbortSignal): Promise<ReviewQueueIdentity> {
    const repository = await this.runner.runJson<{ nameWithOwner?: string }>(
      ["repo", "view", "--json", "nameWithOwner"],
      this.repoRoot,
      { operation: "review.queue.repository", signal }
    );
    const [owner, name] = splitRepository(repository.nameWithOwner);
    const response = await this.runner.runJson<GhViewerRepositoryResponse>(
      [
        "api", "graphql",
        "-F", `owner=${owner}`,
        "-F", `name=${name}`,
        "-f", `query=${VIEWER_AND_REPOSITORY_QUERY}`,
      ],
      this.repoRoot,
      { operation: "review.queue.identity", signal }
    );
    const viewer = response.data?.viewer?.login?.trim();
    const resolvedRepository = response.data?.repository?.nameWithOwner?.trim();
    if (!viewer || !resolvedRepository) {
      throw new Error("GitHub did not return the current reviewer or repository.");
    }
    return { viewer, repository: resolvedRepository };
  }

  /** GitHub issue search로 하나의 리뷰 lane을 읽고 안전한 읽기 모델로 정규화한다. */
  private async search(
    repository: string | undefined,
    qualifier: string,
    operation: string,
    signal?: AbortSignal,
    cursor?: string
  ): Promise<ReviewQueueSearchResult> {
    const query = [
      repository ? `repo:${repository}` : "",
      "is:pr",
      "is:open",
      qualifier,
    ].filter(Boolean).join(" ");
    const response = await this.runner.runJson<GhReviewQueueSearchResponse>(
      [
        "api", "graphql",
        "-F", `searchQuery=${query}`,
        "-F", `limit=${REVIEW_QUEUE_LIMIT}`,
        ...(cursor ? ["-F", `cursor=${cursor}`] : []),
        "-f", `query=${SEARCH_PULL_REQUESTS_QUERY}`,
      ],
      this.repoRoot,
      { operation, signal }
    );
    return {
      pullRequests: normalizeReviewQueuePullRequests(
        (response.data?.search?.nodes || []).filter(
        (node): node is GhReviewQueuePullRequest => Boolean(node)
        )
      ),
      truncated: Boolean(response.data?.search?.pageInfo?.hasNextPage),
      nextCursor: response.data?.search?.pageInfo?.hasNextPage ? response.data.search.pageInfo.endCursor?.trim() || undefined : undefined,
    };
  }
}

/** repository 밖 management scope와 saved query를 한 GitHub search qualifier로 안전하게 결합한다. */
function managementQualifier(scope: ReviewQueueRequestOptions["managementScope"], savedQuery: string | undefined): string {
  const owner = scope?.kind === "owner" ? normalizeOwner(scope.owner) : "";
  const team = scope?.kind === "team" ? normalizeTeam(scope.team) : "";
  return [owner ? `user:${owner}` : "", team ? `team-review-requested:${team}` : "", savedQuery?.trim() || ""].filter(Boolean).join(" ");
}

/** GitHub search qualifier에 들어갈 사용자 또는 조직 login만 허용한다. */
function normalizeOwner(value: string): string {
  const owner = value.trim();
  if (!/^[A-Za-z0-9-]+$/.test(owner)) throw new Error("Enter an organization or user login.");
  return owner;
}

/** GitHub search qualifier에 들어갈 org/team 식별자만 허용한다. */
function normalizeTeam(value: string): string {
  const team = value.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(team)) throw new Error("Enter a team as organization/team.");
  return team;
}

/** owner/name 형태 GitHub 저장소만 GraphQL 변수로 분리한다. */
function splitRepository(repository: string | undefined): [string, string] {
  const [owner, name, extra] = (repository || "").trim().split("/");
  if (!owner || !name || extra) {
    throw new Error("GitHub repository name is unavailable for pull request reviews.");
  }
  return [owner, name];
}
