// GitHub Pull Request comment count 를 한 기준으로 계산하는 공통 모듈.
// - PR conversation comment 와 file review thread comment 를 합쳐 graph UI 의 숫자를 일관되게 만든다.
import { runGh } from "./ghCli";

/** PR 댓글 총합 계산에 필요한 GraphQL selection */
export const PULL_REQUEST_COMMENT_COUNTS_QUERY = `
        comments(first: 1) { totalCount }
        reviewThreads(first: 100) {
          nodes {
            comments(first: 1) { totalCount }
          }
          pageInfo { hasNextPage endCursor }
        }`;

/** GraphQL PullRequest node 중 댓글 집계에 필요한 최소 형태 */
export interface GhPullRequestCommentCounts {
  number?: number;
  comments?: { totalCount?: number };
  reviewThreads?: GhReviewThreadConnection;
}

/** review thread connection 의 pagination 과 comment count 정보 */
export interface GhReviewThreadConnection {
  nodes?: GhReviewThreadCommentCount[];
  pageInfo?: GhPageInfo;
}

/** review thread 하나가 가진 comment 총합 정보 */
export interface GhReviewThreadCommentCount {
  comments?: { totalCount?: number };
}

/** GitHub GraphQL connection pageInfo 최소 형태 */
interface GhPageInfo {
  hasNextPage?: boolean;
  endCursor?: string;
}

interface GhReviewThreadCountPageResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: GhReviewThreadConnection;
      };
    };
  };
}

/** review thread comment count 추가 페이지를 읽는 GraphQL 쿼리 */
const PULL_REQUEST_REVIEW_THREAD_COUNTS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          comments(first: 1) { totalCount }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/** 지나치게 큰 PR 에서 목록 로딩이 무한히 늘어지는 것을 막는 review thread 페이지 상한 */
const MAX_REVIEW_THREAD_COUNT_PAGES = 20;

/**
 * PR 전체 댓글 수를 계산한다.
 * - GitHub 의 `comments.totalCount` 는 conversation comment 만 담으므로 review thread comment 를 더한다.
 * @param pr GraphQL PullRequest node 의 댓글 관련 필드
 * @param extraReviewCommentCount 첫 페이지 뒤에 추가로 읽은 review thread comment 수
 * @returns conversation comment 와 file review comment 를 합친 댓글 수
 */
export function totalPullRequestCommentCount(
  pr: GhPullRequestCommentCounts,
  extraReviewCommentCount = 0
): number {
  return normalizeCount(pr.comments?.totalCount)
    + reviewThreadCommentCount(pr.reviewThreads?.nodes || [])
    + normalizeCount(extraReviewCommentCount);
}

/**
 * review thread 배열에 들어 있는 comment totalCount 를 합산한다.
 * @param threads GraphQL review thread node 배열
 * @returns thread 내부 comment 총합
 */
export function reviewThreadCommentCount(threads: GhReviewThreadCommentCount[]): number {
  return threads.reduce((sum, thread) => sum + normalizeCount(thread.comments?.totalCount), 0);
}

/**
 * 첫 GraphQL 응답에 담기지 않은 review thread comment 수를 PR 번호별로 읽는다.
 * @param cwd gh CLI 를 실행할 저장소 루트
 * @param owner GitHub owner
 * @param name GitHub repository 이름
 * @param pullRequests 첫 페이지 reviewThreads pageInfo 를 가진 PR node 배열
 * @returns PR 번호 → 추가 review thread comment 수 맵
 */
export async function fetchRemainingReviewThreadCommentCounts(
  cwd: string,
  owner: string,
  name: string,
  pullRequests: GhPullRequestCommentCounts[]
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for (const pr of pullRequests) {
    const number = Number(pr.number);
    if (!Number.isFinite(number) || number <= 0) {
      continue;
    }
    const count = await readRemainingReviewThreadCommentCount(cwd, owner, name, number, pr.reviewThreads?.pageInfo);
    if (count > 0) {
      counts.set(number, count);
    }
  }
  return counts;
}

/**
 * PR 하나에서 첫 페이지 뒤의 review thread comment 수를 읽는다.
 * @param cwd gh CLI 실행 경로
 * @param owner GitHub owner
 * @param name GitHub repository 이름
 * @param number PR 번호
 * @param pageInfo 첫 reviewThreads 페이지의 pageInfo
 * @returns 추가 페이지에 있는 review thread comment 총합
 */
async function readRemainingReviewThreadCommentCount(
  cwd: string,
  owner: string,
  name: string,
  number: number,
  pageInfo: GhPageInfo | undefined
): Promise<number> {
  let pages = 1;
  let count = 0;
  while (pageInfo?.hasNextPage && pageInfo.endCursor && pages < MAX_REVIEW_THREAD_COUNT_PAGES) {
    const page = await readReviewThreadCountPage(cwd, owner, name, number, pageInfo.endCursor);
    count += reviewThreadCommentCount(page.nodes || []);
    pageInfo = page.pageInfo;
    pages++;
  }
  return count;
}

/**
 * review thread comment count 추가 페이지 한 장을 읽는다.
 * @param cwd gh CLI 실행 경로
 * @param owner GitHub owner
 * @param name GitHub repository 이름
 * @param number PR 번호
 * @param cursor GitHub GraphQL cursor
 * @returns reviewThreads connection
 */
async function readReviewThreadCountPage(
  cwd: string,
  owner: string,
  name: string,
  number: number,
  cursor: string
): Promise<GhReviewThreadConnection> {
  const out = await runGh([
    "api",
    "graphql",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${number}`,
    "-f",
    `cursor=${cursor}`,
    "-f",
    `query=${PULL_REQUEST_REVIEW_THREAD_COUNTS_QUERY}`,
  ], cwd);
  const parsed = JSON.parse(out) as GhReviewThreadCountPageResponse;
  return parsed.data?.repository?.pullRequest?.reviewThreads || {};
}

/** 숫자로 신뢰할 수 있는 count 만 0 이상의 정수로 정규화한다. */
function normalizeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
