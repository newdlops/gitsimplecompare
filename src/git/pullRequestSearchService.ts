// GitHub repository-wide PR 검색 서비스.
// - PR drawer 의 검색이 현재 로드된 페이지에 갇히지 않도록 GitHub GraphQL search 를 사용한다.
// - 결과는 PullRequestInfo 로 정규화해 기존 preview/open/action 흐름에 그대로 합칠 수 있게 한다.
import { runGh } from "./ghCli";
import { splitRepositoryName } from "./githubRepository";
import { PullRequestInfo } from "./pullRequestService";

/** PR repository-wide 검색 응답 */
export interface PullRequestSearchResult {
  query: string;
  pullRequests: PullRequestInfo[];
  hasMore: boolean;
  totalCount: number;
}

interface GhSearchResponse {
  data?: {
    search?: {
      issueCount?: number;
      nodes?: GhSearchPullRequest[];
      pageInfo?: {
        hasNextPage?: boolean;
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

interface GhSearchPullRequest {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  author?: { login?: string };
  isDraft?: boolean;
  reviewDecision?: string;
  updatedAt?: string;
  comments?: { totalCount?: number };
  files?: { totalCount?: number };
  commits?: {
    nodes?: Array<{ commit?: { oid?: string } }>;
  };
}

const PULL_REQUEST_SEARCH_LIMIT = 50;

const PULL_REQUEST_SEARCH_QUERY = `
query($searchQuery: String!, $limit: Int!) {
  search(query: $searchQuery, type: ISSUE, first: $limit) {
    issueCount
    pageInfo { hasNextPage }
    nodes {
      ... on PullRequest {
        number
        title
        state
        url
        headRefName
        headRefOid
        baseRefName
        author { login }
        isDraft
        reviewDecision
        updatedAt
        comments(first: 1) { totalCount }
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
      author { login }
      isDraft
      reviewDecision
      updatedAt
      comments(first: 1) { totalCount }
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
  query: string
): Promise<PullRequestSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { query, pullRequests: [], hasMore: false, totalCount: 0 };
  }
  const repository = await repositoryName(repoRoot);
  const [owner, name] = splitRepositoryName(repository);
  const [search, exact] = await Promise.all([
    searchByText(repoRoot, owner, name, trimmed),
    searchByNumber(repoRoot, owner, name, trimmed),
  ]);
  const pullRequests = mergeByNumber(exact ? [exact, ...search.pullRequests] : search.pullRequests);
  return {
    query,
    pullRequests,
    hasMore: search.hasMore,
    totalCount: Math.max(search.totalCount, pullRequests.length),
  };
}

/** GitHub issue search 로 전체 PR 텍스트 검색을 수행한다. */
async function searchByText(
  repoRoot: string,
  owner: string,
  name: string,
  query: string
): Promise<{ pullRequests: PullRequestInfo[]; hasMore: boolean; totalCount: number }> {
  const out = await runGh([
    "api",
    "graphql",
    "-F",
    `searchQuery=${buildSearchQuery(owner, name, query)}`,
    "-F",
    `limit=${PULL_REQUEST_SEARCH_LIMIT}`,
    "-f",
    `query=${PULL_REQUEST_SEARCH_QUERY}`,
  ], repoRoot);
  const search = (JSON.parse(out) as GhSearchResponse).data?.search;
  return {
    pullRequests: (search?.nodes || []).map(toPullRequestInfo).filter((pr) => pr.number > 0),
    hasMore: Boolean(search?.pageInfo?.hasNextPage),
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
  return pr ? toPullRequestInfo(pr) : undefined;
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
function toPullRequestInfo(pr: GhSearchPullRequest): PullRequestInfo {
  return {
    number: Number(pr.number) || 0,
    title: pr.title || "",
    state: pr.state || "",
    url: pr.url || "",
    headRefName: pr.headRefName || "",
    headHash: pr.headRefOid,
    baseRefName: pr.baseRefName || "",
    author: pr.author?.login || "",
    isDraft: Boolean(pr.isDraft),
    reviewDecision: pr.reviewDecision,
    updatedAt: pr.updatedAt,
    commentCount: pr.comments?.totalCount ?? 0,
    fileCount: pr.files?.totalCount ?? 0,
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
