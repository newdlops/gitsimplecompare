// GitHub repository-wide PR 검색 서비스.
// - PR drawer 의 검색이 현재 로드된 페이지에 갇히지 않도록 GitHub GraphQL search 를 사용한다.
// - 결과는 PullRequestInfo 로 정규화해 기존 preview/open/action 흐름에 그대로 합칠 수 있게 한다.
import { runGh } from "./ghCli";
import { splitRepositoryName } from "./githubRepository";
import { fetchRemainingReviewThreadCommentCounts } from "./pullRequestCommentCounts";
import {
  PULL_REQUEST_INFO_QUERY,
  pullRequestInfoFromGraphQl,
} from "./pullRequestInfo";
import type { GhPullRequestNode, PullRequestInfo } from "./pullRequestInfo";

/** PR repository-wide 검색 응답 */
export interface PullRequestSearchResult {
  query: string;
  pullRequests: PullRequestInfo[];
  hasMore: boolean;
  nextCursor?: string;
  totalCount: number;
}

interface GhSearchResponse {
  data?: {
    search?: {
      issueCount?: number;
      nodes?: GhPullRequestNode[];
      pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string;
      };
    };
  };
}

interface GhPullRequestNumberResponse {
  data?: {
    repository?: {
      pullRequest?: GhPullRequestNode;
    };
  };
}

interface GhAssociatedPullRequest {
  number?: number;
}

const PULL_REQUEST_SEARCH_PAGE_SIZE = 50;
const PULL_REQUEST_SEARCH_INITIAL_LIMIT = 200;
const PULL_REQUEST_SEARCH_MORE_LIMIT = 100;

const PULL_REQUEST_SEARCH_QUERY = `
query($searchQuery: String!, $limit: Int!, $cursor: String) {
  search(query: $searchQuery, type: ISSUE, first: $limit, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
${PULL_REQUEST_INFO_QUERY}
      }
    }
  }
}`;

const PULL_REQUEST_NUMBER_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
${PULL_REQUEST_INFO_QUERY}
    }
  }
}`;

/**
 * GitHub PR 전체 검색을 수행한다.
 * @param repoRoot gh CLI 를 실행할 저장소 루트
 * @param repository owner/name 형태의 GitHub 저장소 이름
 * @param query 사용자가 입력한 검색어
 */
export async function searchPullRequests(
  repoRoot: string,
  query: string,
  cursor?: string
): Promise<PullRequestSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { query, pullRequests: [], hasMore: false, totalCount: 0 };
  }
  const repository = await repositoryName(repoRoot);
  const [owner, name] = splitRepositoryName(repository);
  const [search, exact, associated] = await Promise.all([
    searchByText(repoRoot, owner, name, trimmed, cursor),
    cursor ? Promise.resolve(undefined) : searchByNumber(repoRoot, owner, name, trimmed),
    cursor ? Promise.resolve([]) : searchByCommitHash(repoRoot, owner, name, trimmed),
  ]);
  const pullRequests = mergeByNumber([
    ...(exact ? [exact] : []),
    ...associated,
    ...search.pullRequests,
  ]);
  return {
    query,
    pullRequests,
    hasMore: search.hasMore,
    nextCursor: search.nextCursor,
    totalCount: Math.max(search.totalCount, pullRequests.length),
  };
}

/** GitHub issue search 로 전체 PR 텍스트 검색을 수행한다. */
async function searchByText(
  repoRoot: string,
  owner: string,
  name: string,
  query: string,
  cursor: string | undefined
): Promise<{ pullRequests: PullRequestInfo[]; hasMore: boolean; nextCursor?: string; totalCount: number }> {
  const max = cursor ? PULL_REQUEST_SEARCH_MORE_LIMIT : PULL_REQUEST_SEARCH_INITIAL_LIMIT;
  const pullRequests: PullRequestInfo[] = [];
  let nextCursor = cursor;
  let hasMore = false;
  let totalCount = 0;
  do {
    const page = await searchPage(repoRoot, owner, name, query, nextCursor, Math.min(PULL_REQUEST_SEARCH_PAGE_SIZE, max - pullRequests.length));
    pullRequests.push(...page.pullRequests);
    totalCount = Math.max(totalCount, page.totalCount);
    nextCursor = page.nextCursor;
    hasMore = page.hasMore;
    if (page.pullRequests.length === 0) {
      break;
    }
  } while (hasMore && nextCursor && pullRequests.length < max);
  return { pullRequests, hasMore, nextCursor, totalCount };
}

/** GitHub issue search 한 페이지를 읽는다. */
async function searchPage(
  repoRoot: string,
  owner: string,
  name: string,
  query: string,
  cursor: string | undefined,
  limit: number
): Promise<{ pullRequests: PullRequestInfo[]; hasMore: boolean; nextCursor?: string; totalCount: number }> {
  const out = await runGh([
    "api",
    "graphql",
    "-F",
    `searchQuery=${buildSearchQuery(owner, name, query)}`,
    "-F",
    `limit=${limit}`,
    ...(cursor ? ["-f", `cursor=${cursor}`] : []),
    "-f",
    `query=${PULL_REQUEST_SEARCH_QUERY}`,
  ], repoRoot);
  const search = (JSON.parse(out) as GhSearchResponse).data?.search;
  const nodes = search?.nodes || [];
  const extraReviewCommentCounts = await fetchRemainingReviewThreadCommentCounts(repoRoot, owner, name, nodes);
  return {
    pullRequests: nodes.map((pr) => pullRequestInfoFromGraphQl(
      pr,
      extraReviewCommentCounts.get(Number(pr.number)) || 0
    )).filter((pr) => pr.number > 0),
    hasMore: Boolean(search?.pageInfo?.hasNextPage),
    nextCursor: search?.pageInfo?.endCursor,
    totalCount: search?.issueCount ?? 0,
  };
}

/** #123 같은 PR 번호 검색어는 GitHub search index 외에 직접 PR 번호로도 조회한다. */
async function searchByNumber(
  repoRoot: string,
  owner: string,
  name: string,
  query: string
): Promise<PullRequestInfo | undefined> {
  const match = /^#?(\d+)$/.exec(query.trim());
  if (!match) {
    return undefined;
  }
  return pullRequestByNumber(repoRoot, owner, name, Number(match[1]));
}

/**
 * commit SHA 검색어와 연결된 PR 번호를 GitHub commit API에서 찾고 전체 PR 정보로 확장한다.
 * - GitHub issue 검색은 PR commit 포함 관계를 색인하지 않으므로 commit 전용 endpoint를 병행한다.
 * - commit이 없거나 GitHub가 아직 연관 관계를 만들지 못한 경우에는 텍스트 검색 결과만 유지한다.
 * @param repoRoot gh CLI를 실행할 저장소 루트
 * @param owner GitHub 저장소 owner
 * @param name GitHub 저장소 이름
 * @param query 사용자가 입력한 전체 검색어
 * @returns 입력 commit과 연결된 PR 목록
 */
async function searchByCommitHash(
  repoRoot: string,
  owner: string,
  name: string,
  query: string
): Promise<PullRequestInfo[]> {
  const hash = pullRequestCommitHashQuery(query);
  if (!hash) {
    return [];
  }
  const route = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    + `/commits/${encodeURIComponent(hash)}/pulls?per_page=100`;
  const out = await runGh(["api", route], repoRoot).catch(() => "");
  const associated = out ? JSON.parse(out) as GhAssociatedPullRequest[] : [];
  const numbers = Array.from(new Set(
    associated.map((pr) => Number(pr.number)).filter((number) => Number.isInteger(number) && number > 0)
  ));
  const pullRequests = await Promise.all(
    numbers.map((number) => pullRequestByNumber(repoRoot, owner, name, number))
  );
  return pullRequests.filter((pr): pr is PullRequestInfo => Boolean(pr));
}

/**
 * GitHub PR 번호 한 건을 GraphQL 공통 selection으로 조회한다.
 * @param repoRoot gh CLI를 실행할 저장소 루트
 * @param owner GitHub 저장소 owner
 * @param name GitHub 저장소 이름
 * @param number 조회할 PR 번호
 * @returns 정규화한 PR 정보. 없거나 조회에 실패하면 undefined
 */
async function pullRequestByNumber(
  repoRoot: string,
  owner: string,
  name: string,
  number: number
): Promise<PullRequestInfo | undefined> {
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
    `query=${PULL_REQUEST_NUMBER_QUERY}`,
  ], repoRoot).catch(() => "");
  const pr = out ? (JSON.parse(out) as GhPullRequestNumberResponse).data?.repository?.pullRequest : undefined;
  if (!pr) {
    return undefined;
  }
  const extraReviewCommentCounts = await fetchRemainingReviewThreadCommentCounts(repoRoot, owner, name, [pr]);
  return pullRequestInfoFromGraphQl(pr, extraReviewCommentCounts.get(Number(pr.number)) || 0);
}

/**
 * repository-wide commit 검색으로 보낼 수 있는 단독 SHA 검색어를 정규화한다.
 * - 일반 영단어나 PR 번호를 commit endpoint에 보내지 않도록 7~40자리 hex만 허용한다.
 * @param query 사용자가 입력한 PR 검색 문자열
 * @returns 소문자로 정규화한 commit SHA 또는 commit 검색이 아니면 undefined
 */
export function pullRequestCommitHashQuery(query: string): string | undefined {
  const trimmed = query.trim();
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

/** gh repo view 로 owner/name 을 읽는다. */
async function repositoryName(repoRoot: string): Promise<string> {
  const out = await runGh(["repo", "view", "--json", "nameWithOwner"], repoRoot);
  return (JSON.parse(out) as { nameWithOwner?: string }).nameWithOwner || "";
}

/** GitHub search 문법에 맞는 PR 검색어를 만든다. */
function buildSearchQuery(owner: string, name: string, query: string): string {
  return [`repo:${owner}/${name}`, "is:pr", query].join(" ");
}

/** PR 번호 기준으로 중복 검색 결과를 제거한다. */
function mergeByNumber(values: PullRequestInfo[]): PullRequestInfo[] {
  return Array.from(new Map(values.map((pr) => [pr.number, pr])).values());
}
