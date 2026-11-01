// GitHub repository-wide PR 검색 서비스.
// - PR drawer 의 검색이 현재 로드된 페이지에 갇히지 않도록 GitHub GraphQL search 를 사용한다.
// - 결과는 PullRequestInfo 로 정규화해 기존 preview/open/action 흐름에 그대로 합칠 수 있게 한다.
import { readGitHub } from "./githubReadCache";
import { readGitHubRepositoryName } from "./githubRepositoryName";
import { createGitHubReadSession } from "./githubReadSession";
import { GhCliError } from "./ghCli";
import { PriorityReadQueue } from "../utils/priorityReadQueue";
import { logInfo } from "../ui/outputLog";
import type { GhExecute } from "./ghRunner";
import { completeSearchPullRequests, fetchSearchPullRequestsByNumber } from "./pullRequestSearchReads";
import { splitRepositoryName } from "./githubRepository";
import {
  PULL_REQUEST_INFO_QUERY,
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
  errors?: unknown[];
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

/**
 * GitHub PR 전체 검색을 수행한다.
 * @param repoRoot gh CLI 를 실행할 저장소 루트
 * @param repository owner/name 형태의 GitHub 저장소 이름
 * @param query 사용자가 입력한 검색어
 */
export async function searchPullRequests(
  repoRoot: string,
  query: string,
  cursor?: string,
  signal?: AbortSignal,
  execute: GhExecute = readGitHub
): Promise<PullRequestSearchResult> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", cancel, { once: true });
  const read = createGitHubReadSession(repoRoot, execute), queue = new PriorityReadQueue(4);
  /** 검색과 모든 후속 페이지가 같은 취소 신호를 쓰도록 실행기를 결합한다. */
  const runner: GhExecute = (args, root, options) => {
    controller.signal.throwIfAborted();
    return queue.run(() => read(args, root, { ...options, signal: controller.signal }), controller.signal);
  };
  try {
    const trimmed = query.trim();
    if (!trimmed) return { query, pullRequests: [], hasMore: false, totalCount: 0 };
    const repository = await repositoryName(repoRoot, runner);
    const [owner, name] = splitRepositoryName(repository);
    const [search, exact, associated] = await Promise.all([
      searchByText(repoRoot, owner, name, trimmed, cursor, runner),
      cursor ? Promise.resolve(undefined) : searchByNumber(repoRoot, owner, name, trimmed, runner),
      cursor ? Promise.resolve([]) : searchByCommitHash(repoRoot, owner, name, trimmed, runner),
    ]);
    const pullRequests = mergeByNumber([...(exact ? [exact] : []), ...associated, ...search.pullRequests]);
    controller.signal.throwIfAborted();
    return { query, pullRequests, hasMore: search.hasMore, nextCursor: search.nextCursor,
      totalCount: Math.max(search.totalCount, pullRequests.length) };
  } finally { signal?.removeEventListener("abort", cancel); controller.abort(); }
}

/** GitHub issue search 로 전체 PR 텍스트 검색을 수행한다. */
async function searchByText(
  repoRoot: string,
  owner: string,
  name: string,
  query: string,
  cursor: string | undefined,
  runner: GhExecute
): Promise<{ pullRequests: PullRequestInfo[]; hasMore: boolean; nextCursor?: string; totalCount: number }> {
  const max = cursor ? PULL_REQUEST_SEARCH_MORE_LIMIT : PULL_REQUEST_SEARCH_INITIAL_LIMIT;
  const pullRequests: PullRequestInfo[] = [];
  let nextCursor = cursor;
  let hasMore = false;
  let totalCount = 0;
  const cursors = new Set(cursor ? [cursor] : []);
  do {
    const page = await searchPage(repoRoot, owner, name, query, nextCursor, Math.min(PULL_REQUEST_SEARCH_PAGE_SIZE, max - pullRequests.length), runner);
    pullRequests.push(...page.pullRequests);
    totalCount = Math.max(totalCount, page.totalCount);
    nextCursor = page.nextCursor;
    hasMore = page.hasMore;
    if (hasMore) {
      if (!nextCursor || cursors.has(nextCursor) || !page.pullRequests.length) throw new Error("GitHub pull request search pagination cursor did not advance.");
      cursors.add(nextCursor);
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
  limit: number,
  runner: GhExecute
): Promise<{ pullRequests: PullRequestInfo[]; hasMore: boolean; nextCursor?: string; totalCount: number }> {
  const out = await runner([
    "api",
    "graphql",
    "-F",
    `searchQuery=${buildSearchQuery(owner, name, query)}`,
    "-F",
    `limit=${limit}`,
    ...(cursor ? ["-f", `cursor=${cursor}`] : []),
    "-f",
    `query=${PULL_REQUEST_SEARCH_QUERY}`,
  ], repoRoot, { operation: "pr-search" });
  const response = JSON.parse(out) as GhSearchResponse, search = response.data?.search;
  if (response.errors?.length || !search || !Array.isArray(search.nodes)
    || typeof search.pageInfo?.hasNextPage !== "boolean" || !Number.isSafeInteger(search.issueCount) || Number(search.issueCount) < 0) {
    throw new Error("GitHub pull request search is incomplete. Refresh to try again.");
  }
  const pullRequests = await completeSearchPullRequests(repoRoot, owner, name, search.nodes, runner);
  return {
    pullRequests: pullRequests.filter(pr => pr.number > 0),
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
  query: string,
  runner: GhExecute
): Promise<PullRequestInfo | undefined> {
  const match = /^#?(\d+)$/.exec(query.trim());
  if (!match) {
    return undefined;
  }
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || number <= 0 || number > 2_147_483_647) return undefined;
  return (await fetchSearchPullRequestsByNumber(repoRoot, owner, name, [number], runner))[0];
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
  query: string,
  runner: GhExecute
): Promise<PullRequestInfo[]> {
  const hash = pullRequestCommitHashQuery(query);
  if (!hash) {
    return [];
  }
  const route = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    + `/commits/${encodeURIComponent(hash)}/pulls?per_page=100`;
  const numbers = new Set<number>();
  for (let page = 1; ; page++) {
    const out = await runner(["api", `${route}${page > 1 ? `&page=${page}` : ""}`], repoRoot, { operation: "pr-search-associated" }).catch(error => {
      // 첫 페이지의 존재하지 않는 commit만 보완한다. 후속 실패를 완성된 빈 페이지로 숨기지 않는다.
      if (page === 1 && error instanceof GhCliError && (/\bHTTP 404\b/i.test(error.stderr)
        || /\bHTTP 422\b/i.test(error.stderr) && /no commit found for sha/i.test(error.stderr))) return "";
      throw error;
    });
    const associated = out ? JSON.parse(out) as GhAssociatedPullRequest[] : [];
    if (!Array.isArray(associated) || associated.length > 100
      || associated.some(pr => !pr || !Number.isSafeInteger(pr.number) || Number(pr.number) <= 0)) {
      throw new Error("GitHub pull request associations are incomplete. Refresh to try again.");
    }
    const before = numbers.size;
    for (const pr of associated) numbers.add(pr.number!);
    if (associated.length < 100) {
      if (page > 1) logInfo("GitHub associated pull requests loaded", { repoRoot, pages: page, pullRequests: numbers.size });
      break;
    }
    if (numbers.size === before) throw new Error("GitHub pull request association pagination did not advance.");
  }
  return fetchSearchPullRequestsByNumber(repoRoot, owner, name, [...numbers], runner);
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

/** gh 가 해석한 owner/name 을 읽는다. 원격 설정이 같으면 이전 결과를 재사용한다. */
function repositoryName(repoRoot: string, runner: GhExecute): Promise<string> {
  return readGitHubRepositoryName(repoRoot, runner, { operation: "pr-search-repository" });
}

/** GitHub search 문법에 맞는 PR 검색어를 만든다. */
function buildSearchQuery(owner: string, name: string, query: string): string {
  return [`repo:${owner}/${name}`, "is:pr", query].join(" ");
}

/** PR 번호 기준으로 중복 검색 결과를 제거한다. */
function mergeByNumber(values: PullRequestInfo[]): PullRequestInfo[] {
  return Array.from(new Map(values.map((pr) => [pr.number, pr])).values());
}
