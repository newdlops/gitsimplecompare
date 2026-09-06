// GitHub Pull Request comment count 를 한 기준으로 계산하는 공통 모듈.
// - PR conversation comment 와 file review thread comment 를 합쳐 graph UI 의 숫자를 일관되게 만든다.
import { runGh } from "./ghCli";
import type { GhExecute } from "./ghRunner";

/** PR 댓글 총합 계산에 필요한 GraphQL selection */
export const PULL_REQUEST_COMMENT_COUNTS_QUERY = buildPullRequestCommentCountsQuery();

/**
 * 대량 PR 목록에서 review thread 연결을 과도하게 펼치지 않도록 첫 페이지 크기를 지정한다.
 * @param pageSize 첫 review thread 페이지 크기. 후속 페이지는 기존 100개 단위를 유지한다.
 * @returns 댓글 총합과 후속 cursor를 포함한 GraphQL selection
 */
export function buildPullRequestCommentCountsQuery(pageSize = 100): string {
  return `
        comments(first: 1) { totalCount }
        reviewThreads(first: ${pageSize}) {
          nodes {
            comments(first: 1) { totalCount }
          }
          pageInfo { hasNextPage endCursor }
        }`;
}

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
 * @param signal 다음 페이지 조회를 중단할 선택적 취소 신호
 * @param runner 목록 서비스의 제한된 병렬 실행 및 테스트에서 공유하는 gh 실행기
 * @returns PR 번호 → 추가 review thread comment 수 맵
 */
export async function fetchRemainingReviewThreadCommentCounts(
  cwd: string,
  owner: string,
  name: string,
  pullRequests: GhPullRequestCommentCounts[],
  signal?: AbortSignal,
  runner: GhExecute = runGh
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for (const pr of pullRequests) {
    throwIfAborted(signal);
    const number = Number(pr.number);
    if (!Number.isFinite(number) || number <= 0) {
      continue;
    }
    const count = await readRemainingReviewThreadCommentCount(cwd, owner, name, number, pr.reviewThreads?.pageInfo, signal, runner);
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
  pageInfo: GhPageInfo | undefined,
  signal?: AbortSignal,
  runner: GhExecute = runGh
): Promise<number> {
  const cursors = new Set<string>();
  let count = 0;
  while (pageInfo?.hasNextPage) {
    throwIfAborted(signal);
    const cursor = pageInfo.endCursor;
    // 첫 페이지가 작아져도 댓글을 누락하지 않는다. 반복 cursor는 즉시 실패시켜 무한 조회를 막는다.
    if (!cursor || cursors.has(cursor)) throw new Error("GitHub review thread pagination did not advance.");
    cursors.add(cursor);
    const page = await readReviewThreadCountPage(cwd, owner, name, number, cursor, signal, runner);
    count += reviewThreadCommentCount(page.nodes || []);
    pageInfo = page.pageInfo;
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
  cursor: string,
  signal?: AbortSignal,
  runner: GhExecute = runGh
): Promise<GhReviewThreadConnection> {
  const out = await runner([
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
  ], cwd, { signal, operation: "graph-pr-review-thread-count-page" });
  const parsed = JSON.parse(out) as GhReviewThreadCountPageResponse;
  const threads = parsed.data?.repository?.pullRequest?.reviewThreads;
  if (!threads) throw new Error("GitHub review thread comments are not available.");
  return threads;
}

/** 숫자로 신뢰할 수 있는 count 만 0 이상의 정수로 정규화한다. */
function normalizeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 취소된 Graph PR 요청이 다음 pagination을 시작하지 않도록 호출 경계에서 즉시 중단한다.
 * @param signal pager가 소유한 선택적 취소 신호
 * @throws 요청이 취소됐을 때 AbortError
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Graph pull request request was cancelled.", "AbortError");
}
