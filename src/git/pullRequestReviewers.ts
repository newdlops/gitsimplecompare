// PR 목록의 요청된 reviewer와 각 사용자의 최신 제출 리뷰를 같은 metadata 묶음에서 정규화한다.
/** 목록에 표시할 사용자/팀과 현재 리뷰 상태다. 재요청은 이전 승인보다 우선한다. */
export interface PullRequestReviewer { login: string; name?: string; kind: "user" | "team"; state: string; }
interface Page { hasNextPage?: boolean }
/** 요약 응답에는 연결 자체가 없다. 빈 완료 응답과 아직 조회하지 않은 상태를 구분한다. */
export interface GhPullRequestReviewers {
  reviewRequests?: { nodes?: Array<{ requestedReviewer?: { __typename?: string; login?: string; slug?: string; name?: string } | null }>; pageInfo?: Page } | null;
  latestReviews?: { nodes?: Array<{ author?: { login?: string } | null; state?: string }>; pageInfo?: Page } | null;
}

/** 80개 첫 요약을 무겁게 하지 않고 기존 20개 metadata 요청에만 제한된 연결을 추가한다. */
export const PULL_REQUEST_REVIEWERS_QUERY = `
        reviewRequests(first: 8) {
          nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug name } } }
          pageInfo { hasNextPage }
        }
        latestReviews(first: 8) {
          nodes { author { login } state }
          pageInfo { hasNextPage }
        }`;

/**
 * 사용자별 최신 리뷰와 현재 요청을 합치고 재요청·팀·제한된 페이지 의미를 보존한다.
 * @param source 한 PR의 GitHub 연결 @returns 미조회면 undefined, 완료한 빈 연결이면 빈 배열과 complete=true
 */
export function normalizePullRequestReviewers(source: GhPullRequestReviewers): { reviewers?: PullRequestReviewer[]; reviewersComplete?: boolean } {
  if (!source.reviewRequests || !source.latestReviews) return {};
  const people = new Map<string, PullRequestReviewer>();
  for (const review of source.latestReviews.nodes ?? []) {
    const login = review.author?.login;
    if (login) people.set(`user:${login.toLowerCase()}`, { login, kind: "user", state: review.state || "COMMENTED" });
  }
  for (const request of source.reviewRequests.nodes ?? []) {
    const person = request.requestedReviewer, team = person?.__typename === "Team";
    const login = team ? person?.slug : person?.login;
    if (!login) continue;
    const kind = team ? "team" : "user";
    people.set(`${kind}:${login.toLowerCase()}`, { login, kind, ...(team && person?.name ? { name: person.name } : {}), state: "REQUESTED" });
  }
  return { reviewers: [...people.values()].sort((a,b) => Number(b.state === "REQUESTED") - Number(a.state === "REQUESTED") || a.login.localeCompare(b.login)),
    reviewersComplete: !source.reviewRequests.pageInfo?.hasNextPage && !source.latestReviews.pageInfo?.hasNextPage };
}
