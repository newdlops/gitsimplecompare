// Pull Request Activity 탭의 GitHub 응답을 renderer-safe 타임라인으로 정규화한다.
// - issue comment, review, commit을 공통 시간·작성자·내용 모델로 합쳐 webview가 GraphQL union을 알 필요 없게 한다.

/** Activity 화면이 구분해 필터할 수 있는 GitHub 활동 종류. */
export type ReviewCenterActivityKind = "comment" | "review" | "commit" | "event";

/** Activity UI가 번역된 설명으로 표시할 GitHub 운영 이벤트 종류. */
export type ReviewCenterActivityEventType = "force-push" | "review-requested" | "assigned" | "labeled" | "milestoned" | "draft" | "ready";

/** 날짜 그룹으로 표시할 Pull Request 활동 한 건. */
export interface ReviewCenterActivityItem {
  /** 동일 종류 안에서 안정적으로 재렌더할 GitHub node 또는 commit OID */
  id: string;
  /** 화면 필터와 badge에 쓰는 활동 종류 */
  kind: ReviewCenterActivityKind;
  /** 표시 가능한 작성자 login 또는 commit author 이름 */
  author?: string;
  /** comment/review 본문 또는 commit 제목 */
  body: string;
  /** review state 같은 보조 상태 */
  state?: string;
  /** management/lifecycle event일 때 UI가 설명을 만들기 위한 안정 식별자 */
  eventType?: ReviewCenterActivityEventType;
  /** event 설명에 삽입할 reviewer, label, milestone 또는 ref 요약 */
  subject?: string;
  /** 생성·제출·commit 시각. 없으면 정렬 마지막에 둔다. */
  createdAt?: string;
}

/** Activity 첫 lazy 조회의 결과와 GitHub connection 잘림 여부. */
export interface ReviewCenterActivityPage {
  /** 시간 역순으로 정렬된 공통 타임라인 */
  items: ReviewCenterActivityItem[];
  /** 각 원본 connection 중 하나 이상이 다음 page를 가진 경우 */
  truncated: boolean;
  /** GitHub schema가 management/lifecycle timeline event query를 지원했는지 여부 */
  eventsAvailable: boolean;
}

/** Activity query가 필요한 GitHub comment node 최소 형태. */
export interface GhReviewCenterIssueComment {
  id?: string;
  body?: string;
  createdAt?: string | null;
  author?: { login?: string } | null;
}

/** Activity query가 필요한 GitHub review node 최소 형태. */
export interface GhReviewCenterReviewActivity {
  id?: string;
  body?: string;
  state?: string | null;
  submittedAt?: string | null;
  author?: { login?: string } | null;
}

/** Activity query가 필요한 GitHub commit node 최소 형태. */
export interface GhReviewCenterActivityCommit {
  oid?: string;
  messageHeadline?: string;
  authoredDate?: string | null;
  committedDate?: string | null;
  author?: { name?: string; user?: { login?: string } | null } | null;
}

/** GraphQL connection에서 activity 모델로 옮길 node 배열과 pageInfo 최소 형태. */
export interface GhReviewCenterActivityConnection<T> {
  nodes?: Array<T | null> | null;
  pageInfo?: { hasNextPage?: boolean; hasPreviousPage?: boolean } | null;
}

/** timelineItems union에서 필요한 관리·lifecycle event의 느슨한 최소 형태. */
export interface GhReviewCenterTimelineEvent {
  __typename?: string;
  id?: string;
  createdAt?: string | null;
  actor?: { login?: string } | null;
  requestedReviewer?: { login?: string; slug?: string; name?: string } | null;
  assignee?: { login?: string } | null;
  label?: { name?: string } | null;
  milestoneTitle?: string | null;
  beforeCommit?: { oid?: string } | null;
  afterCommit?: { oid?: string } | null;
}

/**
 * 서로 다른 GitHub activity connection을 하나의 시간순 목록으로 정규화한다.
 * @param comments Pull Request issue comment connection
 * @param reviews Pull Request review connection
 * @param commits Pull Request commit connection의 commit node 목록
 * @param events Pull Request timelineItems에서 읽은 관리·lifecycle event connection
 * @param eventsAvailable timelineItems query capability가 확인됐는지 여부
 * @returns 중복 없는 타임라인과 원본 목록의 추가 페이지 존재 여부
 */
export function normalizeReviewCenterActivityPage(
  comments: GhReviewCenterActivityConnection<GhReviewCenterIssueComment> | null | undefined,
  reviews: GhReviewCenterActivityConnection<GhReviewCenterReviewActivity> | null | undefined,
  commits: GhReviewCenterActivityConnection<{ commit?: GhReviewCenterActivityCommit | null }> | null | undefined,
  events?: GhReviewCenterActivityConnection<GhReviewCenterTimelineEvent> | null,
  eventsAvailable = true
): ReviewCenterActivityPage {
  const items = new Map<string, ReviewCenterActivityItem>();
  (comments?.nodes || []).forEach((comment) => {
    const id = nonEmpty(comment?.id);
    if (!id) return;
    items.set(`comment:${id}`, { id, kind: "comment", author: nonEmpty(comment?.author?.login), body: comment?.body?.trim() || "", createdAt: nonEmpty(comment?.createdAt) });
  });
  (reviews?.nodes || []).forEach((review) => {
    const id = nonEmpty(review?.id);
    if (!id) return;
    items.set(`review:${id}`, { id, kind: "review", author: nonEmpty(review?.author?.login), body: review?.body?.trim() || "", state: nonEmpty(review?.state), createdAt: nonEmpty(review?.submittedAt) });
  });
  (commits?.nodes || []).forEach((node) => {
    const commit = node?.commit;
    const id = nonEmpty(commit?.oid);
    if (!id) return;
    items.set(`commit:${id}`, { id, kind: "commit", author: nonEmpty(commit?.author?.user?.login) || nonEmpty(commit?.author?.name), body: commit?.messageHeadline?.trim() || id.slice(0, 12), createdAt: nonEmpty(commit?.committedDate) || nonEmpty(commit?.authoredDate) });
  });
  (events?.nodes || []).forEach((event) => {
    const item = normalizeTimelineEvent(event);
    if (item) items.set(`event:${item.id}`, item);
  });
  return {
    items: [...items.values()].sort(compareActivityItems),
    truncated: [comments, reviews, commits, events].some((connection) => Boolean(connection?.pageInfo?.hasNextPage || connection?.pageInfo?.hasPreviousPage)),
    eventsAvailable,
  };
}

/** timelineItems union의 지원 event만 renderer-safe 공통 item으로 바꾼다. */
function normalizeTimelineEvent(event: GhReviewCenterTimelineEvent | null): ReviewCenterActivityItem | undefined {
  const id = nonEmpty(event?.id);
  const eventType = timelineEventType(event?.__typename);
  if (!id || !eventType) return undefined;
  const before = shortOid(event?.beforeCommit?.oid);
  const after = shortOid(event?.afterCommit?.oid);
  const subject = eventType === "force-push" ? [before, after].filter(Boolean).join(" → ")
    : nonEmpty(event?.requestedReviewer?.name) || nonEmpty(event?.requestedReviewer?.login) || nonEmpty(event?.requestedReviewer?.slug)
      || nonEmpty(event?.assignee?.login) || nonEmpty(event?.label?.name) || nonEmpty(event?.milestoneTitle);
  return { id, kind: "event", author: nonEmpty(event?.actor?.login), body: "", eventType, subject, createdAt: nonEmpty(event?.createdAt) };
}

/** GitHub union typename을 Activity UI가 지원하는 event 종류로 좁힌다. */
function timelineEventType(type: string | undefined): ReviewCenterActivityEventType | undefined {
  return ({
    HeadRefForcePushedEvent: "force-push",
    ReviewRequestedEvent: "review-requested",
    AssignedEvent: "assigned",
    LabeledEvent: "labeled",
    MilestonedEvent: "milestoned",
    ConvertToDraftEvent: "draft",
    ReadyForReviewEvent: "ready",
  } as Record<string, ReviewCenterActivityEventType>)[type || ""];
}

/** commit OID는 UI 문구에서 읽기 좋은 12자 형태만 보존한다. */
function shortOid(oid: string | undefined): string | undefined {
  return nonEmpty(oid)?.slice(0, 12);
}

/** ISO 시각이 있는 활동을 최신순으로 정렬하고 누락 시각은 안정적으로 마지막에 둔다. */
function compareActivityItems(left: ReviewCenterActivityItem, right: ReviewCenterActivityItem): number {
  const leftTime = Date.parse(left.createdAt || "") || 0;
  const rightTime = Date.parse(right.createdAt || "") || 0;
  return rightTime - leftTime || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}

/** 공백과 undefined를 같은 누락값으로 정규화한다. */
function nonEmpty(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
