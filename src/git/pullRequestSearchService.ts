// GitHub repository-wide PR 검색 서비스.
// - PR drawer 의 검색이 현재 로드된 페이지에 갇히지 않도록 GitHub GraphQL search 를 사용한다.
// - 결과는 PullRequestInfo 로 정규화해 기존 preview/open/action 흐름에 그대로 합칠 수 있게 한다.
import { runGh } from "./ghCli";
import { splitRepositoryName } from "./githubRepository";
import { PullRequestInfo } from "./pullRequestService";
import { PULL_REQUEST_LABELS_QUERY, normalizePullRequestLabels } from "./pullRequestLabels";
import type { GhPullRequestLabels } from "./pullRequestLabels";
import { PULL_REQUEST_COMMENT_COUNTS_QUERY, fetchRemainingReviewThreadCommentCounts, totalPullRequestCommentCount } from "./pullRequestCommentCounts";
import type { GhPullRequestCommentCounts } from "./pullRequestCommentCounts";

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
      nodes?: GhSearchPullRequest[];
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
      pullRequest?: GhSearchPullRequest;
    };
  };
}

interface GhSearchPullRequest extends GhPullRequestCommentCounts {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  baseRefOid?: string;
  author?: { login?: string };
  isDraft?: boolean;
  reviewDecision?: string;
  updatedAt?: string;
  labels?: GhPullRequestLabels;
  files?: { totalCount?: number };
  commits?: {
    nodes?: Array<{ commit?: { oid?: string } }>;
  };
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
        number
        title
        state
        url
        headRefName
        headRefOid
        baseRefName
        baseRefOid
        author { login }
        isDraft
        reviewDecision
        updatedAt
${PULL_REQUEST_LABELS_QUERY}
${PULL_REQUEST_COMMENT_COUNTS_QUERY}
        files(first: 1) { totalCount }
        commits(first: 100) {
          nodes { commit { oid } }
        }
      }
    }
  }
}`;

const PULL_REQUEST_NUMBER_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      state
      url
      headRefName
      headRefOid
      baseRefName
      baseRefOid
      author { login }
      isDraft
      reviewDecision
      updatedAt
${PULL_REQUEST_LABELS_QUERY}
${PULL_REQUEST_COMMENT_COUNTS_QUERY}
      files(first: 1) { totalCount }
      commits(first: 100) {
        nodes { commit { oid } }
      }
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
  const [search, exact] = await Promise.all([
    searchByText(repoRoot, owner, name, trimmed, cursor),
    cursor ? Promise.resolve(undefined) : searchByNumber(repoRoot, owner, name, trimmed),
  ]);
  const pullRequests = mergeByNumber(exact ? [exact, ...search.pullRequests] : search.pullRequests);
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
    pullRequests: nodes.map((pr) => toPullRequestInfo(pr, extraReviewCommentCounts.get(Number(pr.number)) || 0)).filter((pr) => pr.number > 0),
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
  const out = await runGh([
    "api",
    "graphql",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${match[1]}`,
    "-f",
    `query=${PULL_REQUEST_NUMBER_QUERY}`,
  ], repoRoot).catch(() => "");
  const pr = out ? (JSON.parse(out) as GhPullRequestNumberResponse).data?.repository?.pullRequest : undefined;
  if (!pr) {
    return undefined;
  }
  const extraReviewCommentCounts = await fetchRemainingReviewThreadCommentCounts(repoRoot, owner, name, [pr]);
  return toPullRequestInfo(pr, extraReviewCommentCounts.get(Number(pr.number)) || 0);
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

/** GraphQL PullRequest node 를 graph PR 타입으로 정규화한다. */
function toPullRequestInfo(pr: GhSearchPullRequest, extraReviewCommentCount = 0): PullRequestInfo {
  return {
    number: Number(pr.number) || 0,
    title: pr.title || "",
    state: pr.state || "",
    url: pr.url || "",
    headRefName: pr.headRefName || "",
    headHash: pr.headRefOid,
    baseRefName: pr.baseRefName || "",
    baseHash: pr.baseRefOid,
    author: pr.author?.login || "",
    isDraft: Boolean(pr.isDraft),
    reviewDecision: pr.reviewDecision,
    updatedAt: pr.updatedAt,
    commentCount: totalPullRequestCommentCount(pr, extraReviewCommentCount),
    fileCount: pr.files?.totalCount ?? 0,
    labels: normalizePullRequestLabels(pr.labels),
    commitHashes: Array.from(new Set([
      ...(pr.commits?.nodes || []).map((node) => node.commit?.oid || ""),
      pr.headRefOid || "",
    ].filter(Boolean))),
  };
}

/** PR 번호 기준으로 중복 검색 결과를 제거한다. */
function mergeByNumber(values: PullRequestInfo[]): PullRequestInfo[] {
  return Array.from(new Map(values.map((pr) => [pr.number, pr])).values());
}
