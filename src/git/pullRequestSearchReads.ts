// 검색의 번호별 PR 확장과 연결 완성을 공유한다. 같은 commit의 많은 PR도 20개씩 묶어 읽는다.
import type { GhExecute } from "./ghRunner";
import { GhCliError } from "./ghCli";
import { graphQLResult, GitHubApiError } from "./githubApiError";
import { graphQLRequest } from "./githubReadRequest";
import { completePullRequestCommits, mapPullRequestReads } from "./pullRequestCommitPages";
import { fetchRemainingReviewThreadCommentCounts } from "./pullRequestCommentCounts";
import { PULL_REQUEST_INFO_QUERY, pullRequestInfoFromGraphQl, type GhPullRequestNode, type PullRequestInfo } from "./pullRequestInfo";

const BATCH_SIZE = 20;
interface SearchNodesResponse {
  errors?: Array<{ type?: string; path?: unknown }>;
  data?: { repository?: Record<string, GhPullRequestNode | null> };
}

/**
 * 검색/번호 응답의 필수 연결을 확인하고 모든 commit·review tail을 완성한다.
 * @param nodes 같은 저장소에서 검증한 PR node 목록. 일부 연결 누락도 빈 성공으로 인정하지 않는다.
 * @param runner 검색 전체의 큐·환경·취소를 소유한 실행기
 * @returns 정확한 원본 순서의 완성된 PR. 한 연결 실패도 호출자에게 전파한다.
 */
export async function completeSearchPullRequests(root: string, owner: string, name: string,
  nodes: GhPullRequestNode[], runner: GhExecute): Promise<PullRequestInfo[]> {
  for (const node of nodes) assertSearchPullRequest(node);
  const counts = await fetchRemainingReviewThreadCommentCounts(root, owner, name, nodes, undefined, runner);
  return mapPullRequestReads(nodes, async node => {
    const pr = pullRequestInfoFromGraphQl(node, counts.get(Number(node.number)) || 0);
    await completePullRequestCommits(root, owner, name, node, pr, undefined, runner);
    return pr;
  });
}

/**
 * 연결된 PR 번호들을 20개 이하의 GraphQL alias로 읽어 PR마다 별도 왕복하지 않는다.
 * @param numbers 같은 저장소의 양의 PR 번호. 중복은 처음 순서를 유지해 한 번만 읽는다.
 * @returns 존재하는 PR 전체. 명시적인 null만 누락 PR로 인정하고 잘못된 번호/부분 응답은 거절한다.
 */
export async function fetchSearchPullRequestsByNumber(root: string, owner: string, name: string,
  numbers: readonly number[], runner: GhExecute): Promise<PullRequestInfo[]> {
  if (numbers.some(number => !Number.isSafeInteger(number) || number <= 0)) throw incomplete();
  const selected = [...new Set(numbers)], groups: number[][] = [];
  for (let index = 0; index < selected.length; index += BATCH_SIZE) groups.push(selected.slice(index, index + BATCH_SIZE));
  const pages = await mapPullRequestReads(groups, async group => {
    const fields = group.map(number => `p${number}: pullRequest(number: ${number}) { ${PULL_REQUEST_INFO_QUERY} }`).join("\n");
    let requestError: GhCliError | GitHubApiError | undefined;
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
    const out = await runner(["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-f",
      `query=${query}`], root,
    { operation: group.length === 1 ? "pr-search-number" : "pr-search-number-batch", request: graphQLRequest(query, { owner, name }) }).catch(error => {
      // gh는 존재하지 않는 PR alias도 data:null + NOT_FOUND를 stdout에 넣고 exit=1로 반환한다.
      if (error instanceof GitHubApiError && error.kind === "graphql" && graphQLResult(error)) {
        requestError = error; return JSON.stringify(graphQLResult(error));
      }
      if (!(error instanceof GhCliError) || !error.stdout) throw error;
      requestError = error; return error.stdout;
    });
    const repository = parseNumberBatch(out, group, requestError);
    const nodes = group.flatMap(number => {
      const node = repository[`p${number}`];
      if (node === null) return [];
      if (!node || node.number !== number) throw incomplete();
      return [node];
    });
    return completeSearchPullRequests(root, owner, name, nodes, runner);
  });
  return pages.flat();
}

/**
 * 요청한 PR alias의 명시적 NOT_FOUND만 정상 누락으로 허용하고 다른 부분 오류는 보존한다.
 * @param output 성공 또는 gh exit=1의 GraphQL stdout, numbers 이 묶음에서 요청한 PR 번호
 * @param requestError 원래 CLI 실패. 응답이 허용한 누락 형태가 아니면 그대로 전파한다.
 * @returns 정확한 alias별 node/null. 저장소 접근 실패·인증 오류를 빈 PR 목록으로 바꾸지 않는다.
 */
function parseNumberBatch(output: string, numbers: readonly number[], requestError?: GhCliError | GitHubApiError): Record<string, GhPullRequestNode | null> {
  let response: SearchNodesResponse;
  try { response = JSON.parse(output); } catch { throw requestError ?? incomplete(); }
  const repository = response?.data?.repository;
  if (!repository) throw requestError ?? incomplete();
  const aliases = new Set(numbers.map(number => `p${number}`));
  const errors = response.errors ?? [];
  const missingOnly = Array.isArray(errors) && errors.length > 0 && errors.every(error => {
    const path = error?.path;
    return error?.type === "NOT_FOUND" && Array.isArray(path) && path.length === 2
      && path[0] === "repository" && typeof path[1] === "string" && aliases.has(path[1]) && repository[path[1]] === null;
  });
  if (errors.length && !missingOnly || requestError && !missingOnly) throw requestError ?? incomplete();
  return repository;
}

/** 필수 identity/합계/연결을 검증해 검색의 부분 데이터를 쓰기 가능한 PR snapshot으로 바꾸지 않는다. */
function assertSearchPullRequest(node: GhPullRequestNode): void {
  if (!node || !Number.isSafeInteger(node.number) || Number(node.number) <= 0 || typeof node.title !== "string"
    || !["OPEN", "CLOSED", "MERGED"].includes(node.state || "") || !node.url || !node.headRefOid || !node.baseRefOid
    || typeof node.headRefName !== "string" || typeof node.baseRefName !== "string"
    || !Array.isArray(node.commits?.nodes) || typeof node.commits.pageInfo?.hasNextPage !== "boolean"
    || !Array.isArray(node.reviewThreads?.nodes) || typeof node.reviewThreads.pageInfo?.hasNextPage !== "boolean"
    || !Number.isSafeInteger(node.comments?.totalCount) || Number(node.comments?.totalCount) < 0
    || !Number.isSafeInteger(node.files?.totalCount) || Number(node.files?.totalCount) < 0) throw incomplete();
}

/** API 원문이나 인증값을 포함하지 않는 재시도 가능한 검색 계약 오류다. */
function incomplete(): Error { return new Error("GitHub pull request search metadata is incomplete. Refresh to try again."); }
