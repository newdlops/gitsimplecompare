// Pull Request 리뷰 홈에서 공유하는 순수 도메인 모델.
// - gh GraphQL 응답의 느슨한 필드를 웹뷰에 안전한 읽기 모델로 정규화한다.
// - UI와 gh 서비스가 같은 정렬/표시 규칙을 재사용하도록 VS Code 의존성을 두지 않는다.

/** Reviews 홈에서 한 Pull Request를 표시하는 최소 읽기 모델. */
export interface ReviewQueuePullRequest {
  /** 검색 결과가 속한 owner/name repository. team scope의 cross-repository target 식별에 사용한다. */
  repository?: string;
  /** GitHub Pull Request 번호 */
  number: number;
  /** 사람이 읽는 제목 */
  title: string;
  /** 브라우저로 열 수 있는 GitHub URL */
  url: string;
  /** 작성자 GitHub login */
  author: string;
  /** GitHub가 마지막으로 갱신한 ISO 시각 */
  updatedAt?: string;
  /** Draft PR 여부 */
  isDraft: boolean;
  /** APPROVED, CHANGES_REQUESTED 같은 GitHub review 판정 */
  reviewDecision?: string;
  /** CLEAN, BLOCKED 같은 merge 상태 */
  mergeStateStatus?: string;
  /** 요청된 사용자·팀 이름 목록 */
  requestedReviewers: string[];
  /** PR 담당자로 지정된 GitHub 사용자 목록 */
  assignees: string[];
  /** 운영 분류에 쓰이는 GitHub label 목록 */
  labels: string[];
}

/** Personal 탭에서 사용자 자신의 작업을 구분하는 두 lane. */
export interface PersonalReviewQueue {
  /** 현재 사용자에게 review가 요청된 열린 PR */
  requested: ReviewQueuePullRequest[];
  /** 현재 사용자가 작성한 열린 PR */
  authored: ReviewQueuePullRequest[];
  /** 현재 viewer에게 담당자로 지정된 열린 PR */
  assigned: ReviewQueuePullRequest[];
  /** 현재 viewer가 멘션된 열린 PR */
  mentioned: ReviewQueuePullRequest[];
  /** 작성자는 아니지만 viewer가 참여한 열린 PR */
  participated: ReviewQueuePullRequest[];
}

/** Management 탭에서 저장소 운영자가 보는 열린 PR 목록. */
export interface ManagementReviewQueue {
  /** 저장소의 열린 PR을 최신 갱신순으로 나열한 목록 */
  open: ReviewQueuePullRequest[];
}

/** Reviews 사이드바가 한 번에 렌더링하는 GitHub 읽기 스냅샷. */
export interface ReviewQueueSnapshot {
  /** owner/name 형태의 GitHub 저장소 */
  repository: string;
  /** 인증된 GitHub 사용자 login */
  viewer: string;
  /** 개인 리뷰 작업 큐 */
  personal: PersonalReviewQueue;
  /** 팀/조직 운영 큐 */
  management: ManagementReviewQueue;
  /** 한 lane 조회만 실패했을 때 성공 lane을 유지하며 UI가 표시할 unavailable scope 목록 */
  unavailableLanes?: ReviewQueueLane[];
  /** GitHub search에 다음 page가 남아 현재 화면이 첫 결과 일부만 보여 주는 lane 목록 */
  truncatedLanes?: ReviewQueueLane[];
  /** 각 lane의 다음 GitHub search cursor. 없으면 현재 결과가 마지막 page다. */
  nextCursors?: Partial<Record<ReviewQueueLane, string>>;
  /** 1,000개 UI 결과 상한에 도달해 다음 GitHub cursor를 의도적으로 멈춘 lane 목록 */
  cappedLanes?: ReviewQueueLane[];
  /** 동시 응답 중 가장 최근 갱신 시각 */
  refreshedAt: string;
}

/** Personal/Management queue의 independently refreshable lane 식별자. */
export type ReviewQueueLane = "personal.requested" | "personal.authored" | "personal.assigned" | "personal.mentioned" | "personal.participated" | "management.open";

/** gh GraphQL이 반환하는 requested reviewer의 최소 형태. */
export interface GhRequestedReviewer {
  __typename?: string;
  login?: string;
  slug?: string;
  organization?: { login?: string } | null;
}

/** gh GraphQL PullRequest node의 Reviews 홈 최소 형태. */
export interface GhReviewQueuePullRequest {
  repository?: { nameWithOwner?: string } | null;
  number?: number;
  title?: string;
  url?: string;
  author?: { login?: string } | null;
  updatedAt?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  mergeStateStatus?: string | null;
  reviewRequests?: {
    nodes?: Array<{ requestedReviewer?: GhRequestedReviewer | null } | null> | null;
  } | null;
  assignees?: { nodes?: Array<{ login?: string } | null> | null } | null;
  labels?: { nodes?: Array<{ name?: string } | null> | null } | null;
}

/** Reviews 홈에서 보여줄 수 있는 PR만 정규화해 최신순으로 정렬한다. */
export function normalizeReviewQueuePullRequests(
  pullRequests: readonly GhReviewQueuePullRequest[]
): ReviewQueuePullRequest[] {
  const unique = new Map<string, ReviewQueuePullRequest>();
  for (const pullRequest of pullRequests) {
    const normalized = normalizeReviewQueuePullRequest(pullRequest);
    if (normalized) {
      unique.set(reviewQueuePullRequestKey(normalized), normalized);
    }
  }
  return [...unique.values()].sort(compareReviewQueuePullRequests);
}

/** cross-repository Management search에서 같은 번호의 서로 다른 PR을 구분하는 안정 key를 만든다. */
function reviewQueuePullRequestKey(pullRequest: ReviewQueuePullRequest): string {
  return `${pullRequest.repository || "current"}#${pullRequest.number}`;
}

/** gh GraphQL PullRequest 한 건을 webview 전송용 읽기 모델로 보정한다. */
export function normalizeReviewQueuePullRequest(
  pullRequest: GhReviewQueuePullRequest
): ReviewQueuePullRequest | undefined {
  const number = Number(pullRequest.number);
  const url = pullRequest.url?.trim() || "";
  if (!Number.isInteger(number) || number <= 0 || !url) {
    return undefined;
  }
  return {
    repository: validRepository(pullRequest.repository?.nameWithOwner),
    number,
    title: pullRequest.title?.trim() || `Pull request #${number}`,
    url,
    author: pullRequest.author?.login?.trim() || "unknown",
    updatedAt: validIsoTime(pullRequest.updatedAt),
    isDraft: Boolean(pullRequest.isDraft),
    reviewDecision: nonEmpty(pullRequest.reviewDecision),
    mergeStateStatus: nonEmpty(pullRequest.mergeStateStatus),
    requestedReviewers: normalizeRequestedReviewers(pullRequest.reviewRequests?.nodes || []),
    assignees: normalizeNamedNodes(pullRequest.assignees?.nodes || [], "login"),
    labels: normalizeNamedNodes(pullRequest.labels?.nodes || [], "name"),
  };
}

/** cross-repository search가 돌려 준 owner/name만 bulk target에 사용한다. */
function validRepository(value: string | undefined): string | undefined {
  const repository = value?.trim();
  return repository && /^[^/\s]+\/[^/\s]+$/.test(repository) ? repository : undefined;
}

/** 사람/팀 reviewer 요청을 표시용 고유 이름 목록으로 변환한다. */
export function normalizeRequestedReviewers(
  nodes: ReadonlyArray<{ requestedReviewer?: GhRequestedReviewer | null } | null>
): string[] {
  const reviewers = new Set<string>();
  for (const node of nodes) {
    const reviewer = node?.requestedReviewer;
    if (!reviewer) {
      continue;
    }
    const user = nonEmpty(reviewer.login);
    if (user) {
      reviewers.add(user);
      continue;
    }
    const team = nonEmpty(reviewer.slug);
    if (team) {
      const organization = nonEmpty(reviewer.organization?.login);
      reviewers.add(organization ? `${organization}/${team}` : team);
    }
  }
  return [...reviewers].sort((left, right) => left.localeCompare(right));
}

/**
 * assignee·label처럼 name/login만 가진 GraphQL node를 고유 정렬 문자열로 정규화한다.
 * @param nodes GraphQL connection의 nullable node 목록
 * @param key   화면에 사용할 문자열 속성 이름
 * @returns 공백과 중복을 제거한 안정 정렬 이름 목록
 */
export function normalizeNamedNodes(
  nodes: ReadonlyArray<{ login?: string; name?: string } | null>,
  key: "login" | "name"
): string[] {
  const values = new Set<string>();
  for (const node of nodes) {
    const value = nonEmpty(node?.[key]);
    if (value) values.add(value);
  }
  return [...values].sort((left, right) => left.localeCompare(right));
}

/** ISO 시각이 아니거나 파싱할 수 없으면 UI에 보내지 않는다. */
function validIsoTime(value: string | undefined): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** 공백 문자열과 null을 undefined로 정규화한다. */
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** 갱신 시각이 최신인 PR을 먼저 보이고, 동률은 번호 내림차순으로 안정화한다. */
function compareReviewQueuePullRequests(
  left: ReviewQueuePullRequest,
  right: ReviewQueuePullRequest
): number {
  const leftTime = Date.parse(left.updatedAt || "") || 0;
  const rightTime = Date.parse(right.updatedAt || "") || 0;
  return rightTime - leftTime || right.number - left.number;
}
