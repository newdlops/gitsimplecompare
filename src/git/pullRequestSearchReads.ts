// 검색의 번호별 PR 확장과 연결 완성을 공유한다. 같은 commit의 많은 PR도 20개씩 묶어 읽는다.
import type { GhExecute } from "./ghRunner";
import { GhCliError } from "./ghCli";
import { graphQLResult, GitHubApiError } from "./githubApiError";
import { graphQLRequest } from "./githubReadRequest";
import { completePullRequestCommits, mapPullRequestReads } from "./pullRequestCommitPages";
import { fetchRemainingReviewThreadCommentCounts } from "./pullRequestCommentCounts";
import { buildPullRequestInfoQuery, pullRequestInfoFromGraphQl, type GhPullRequestNode, type PullRequestInfo } from "./pullRequestInfo";
import { gitHubSnapshotIdentity, gitHubReadSessionState } from "./githubReadSession";
import { withStableConnections, sameAnchor } from "./pullRequestListReads";
import { inheritGitHubReadSession } from "./githubReadSession";

const BATCH_SIZE = 20;

/** 한 논리 검색 안에서만 검증된 PR 연결의 진행/완료 결과를 공유한다. 다른 조회의 인증을 대신하지 않는다. */
export class SearchPullRequestReadScope {
  private readonly entries = new Map<number, { anchor: string; result: Promise<PullRequestInfo> }>();
  /** 번호 보완은 이미 받은 PR을 사용하고, 새 metadata 응답은 같은 앵커일 때만 연결을 재사용한다. */
  get(number: number, node?: GhPullRequestNode): Promise<PullRequestInfo> | undefined {
    const entry = this.entries.get(number);
    return entry && (!node || entry.anchor === this.anchor(node)) ? entry.result : undefined;
  }
  /** 필수 identity와 연결을 검사한 node의 전체 pagination Promise를 등록한다. */
  set(node: GhPullRequestNode, result: Promise<PullRequestInfo>): void {
    this.entries.set(node.number!, { anchor: this.anchor(node), result });
  }
  /** 같은 번호라도 head/base/대상 branch나 URL이 달라지면 과거 연결을 합치지 않는다. */
  private anchor(node: GhPullRequestNode): string {
    return JSON.stringify([node.url, node.headRefOid, node.baseRefOid, node.baseRefName]);
  }
}
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
  nodes: GhPullRequestNode[], runner: GhExecute, stableOmitted = false, scope?: SearchPullRequestReadScope): Promise<PullRequestInfo[]> {
  if (stableOmitted) {
    for (const node of nodes) assertSearchPullRequest(node, false);
    const identity = gitHubSnapshotIdentity(runner, `${owner}/${name}`), snapshots = gitHubReadSessionState(runner)?.snapshots;
    const missing: GhPullRequestNode[] = [];
    nodes = nodes.map(node => {
      const known = identity && node.headRefOid && node.baseRefOid && node.baseRefName
        ? snapshots?.commits.get(identity, node.number!, node.headRefOid, node.baseRefOid, node.baseRefName) : undefined;
      if (known) return withStableConnections(node, known);
      missing.push(node); return node;
    });
    const repaired = new Map<number, GhPullRequestNode>();
    const groups: GhPullRequestNode[][] = [];
    for (let index = 0; index < missing.length; index += BATCH_SIZE) groups.push(missing.slice(index, index + BATCH_SIZE));
    await mapPullRequestReads(groups, async group => {
      const values = await readNumberNodes(root, owner, name, group.map(node => node.number!), runner, true);
      group.forEach((anchor, index) => {
        const value = values[index];
        if (!value || !sameAnchor(value, anchor)) throw new Error("Pull request head/base changed while loading search metadata. Refresh to try again.");
        repaired.set(value.number!, value);
      });
    });
    nodes = nodes.map(node => repaired.get(node.number!) ?? node);
  }
  for (const node of nodes) assertSearchPullRequest(node);
  const reused = new Map(nodes.flatMap(node => {
    const result = scope?.get(node.number!, node); return result ? [[node.number!, result] as const] : [];
  }));
  const fresh = nodes.filter(node => !reused.has(node.number!));
  const pending = (async () => {
    const controller = new AbortController();
    const read: GhExecute = (args, cwd, options) => runner(args, cwd, { ...options, signal: controller.signal, waitForReadClose: true });
    inheritGitHubReadSession(runner, read);
    let failure: unknown;
    /** 먼저 실패한 원인을 보존하고 같은 검색 결과를 구성하는 나머지 페이지를 중단한다. */
    const guard = <T>(promise: Promise<T>) => promise.catch(error => { failure ??= error; controller.abort(); throw error; });
    const counts = guard(fetchRemainingReviewThreadCommentCounts(root, owner, name, fresh, controller.signal, read));
    const workers: Promise<PullRequestInfo>[] = [];
    const commits = guard(mapPullRequestReads(fresh, node => {
      // worker 하나의 실패가 즉시 형제를 취소하고, fail-fast aggregate와 별개로 종료를 추적한다.
      const worker = guard((async () => {
        const pr = pullRequestInfoFromGraphQl(node, 0);
        await completePullRequestCommits(root, owner, name, node, pr, controller.signal, read);
        return pr;
      })());
      workers.push(worker); return worker;
    }, controller.signal));
    try {
      const [completeCounts, completeCommits] = await Promise.all([counts, commits]);
      return fresh.map((node, index) => ({ ...pullRequestInfoFromGraphQl(node, completeCounts.get(Number(node.number)) || 0),
        commitHashes: completeCommits[index].commitHashes, commitSummaries: completeCommits[index].commitSummaries,
        commitHashesComplete: completeCommits[index].commitHashesComplete }));
    } catch (error) { controller.abort(); await Promise.allSettled([counts, commits, ...workers]); throw failure ?? error; }
    finally { controller.abort(); }
  })();
  const values = new Map(fresh.map((node, index) => [node.number!, pending.then(results => results[index])]));
  for (const node of fresh) scope?.set(node, values.get(node.number!)!);
  return Promise.all(nodes.map(node => reused.get(node.number!) ?? values.get(node.number!)!));
}

/**
 * 연결된 PR 번호들을 20개 이하의 GraphQL alias로 읽어 PR마다 별도 왕복하지 않는다.
 * @param numbers 같은 저장소의 양의 PR 번호. 중복은 처음 순서를 유지해 한 번만 읽는다.
 * @returns 존재하는 PR 전체. 명시적인 null만 누락 PR로 인정하고 잘못된 번호/부분 응답은 거절한다.
 */
export async function fetchSearchPullRequestsByNumber(root: string, owner: string, name: string,
  numbers: readonly number[], runner: GhExecute, reuseStable = false, scope?: SearchPullRequestReadScope): Promise<PullRequestInfo[]> {
  if (numbers.some(number => !Number.isSafeInteger(number) || number <= 0)) throw incomplete();
  const selected = [...new Set(numbers)], groups: number[][] = [];
  const reused = new Map(selected.flatMap(number => { const value = scope?.get(number); return value ? [[number, value] as const] : []; }));
  const missing = selected.filter(number => !reused.has(number));
  for (let index = 0; index < missing.length; index += BATCH_SIZE) groups.push(missing.slice(index, index + BATCH_SIZE));
  const pending = mapPullRequestReads(groups, async group => {
    const nodes = await readNumberNodes(root, owner, name, group, runner, !reuseStable);
    return completeSearchPullRequests(root, owner, name, nodes.filter((node): node is GhPullRequestNode => node !== null), runner, reuseStable, scope);
  });
  const [pages, shared] = await Promise.all([pending, Promise.all([...reused].map(async ([number, value]) => [number, await value] as const))]);
  const values = new Map([...pages.flat().map(pr => [pr.number, pr] as const), ...shared]);
  return selected.flatMap(number => { const value = values.get(number); return value ? [value] : []; });
}

/** 양의 번호 묶음을 raw node로 읽으며 예상한 null+NOT_FOUND만 정상 누락으로 허용한다. */
async function readNumberNodes(root: string, owner: string, name: string, group: readonly number[], runner: GhExecute,
  stable: boolean): Promise<Array<GhPullRequestNode | null>> {
    const fields = group.map(number => `p${number}: pullRequest(number: ${number}) { ${buildPullRequestInfoQuery(100, 100, stable)} }`).join("\n");
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
    return group.map(number => {
      const node = repository[`p${number}`];
      if (node === null) return null;
      if (!node || node.number !== number) throw incomplete();
      return node;
    });
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
function assertSearchPullRequest(node: GhPullRequestNode, stable = true): void {
  if (!node || !Number.isSafeInteger(node.number) || Number(node.number) <= 0 || typeof node.title !== "string"
    || !["OPEN", "CLOSED", "MERGED"].includes(node.state || "") || !node.url || !node.headRefOid || !node.baseRefOid
    || typeof node.headRefName !== "string" || typeof node.baseRefName !== "string"
    || !Array.isArray(node.reviewThreads?.nodes) || typeof node.reviewThreads.pageInfo?.hasNextPage !== "boolean"
    || !Number.isSafeInteger(node.comments?.totalCount) || Number(node.comments?.totalCount) < 0
    || stable && (!Array.isArray(node.commits?.nodes) || typeof node.commits.pageInfo?.hasNextPage !== "boolean"
      || !Number.isSafeInteger(node.files?.totalCount) || Number(node.files?.totalCount) < 0)) throw incomplete();
}

/** API 원문이나 인증값을 포함하지 않는 재시도 가능한 검색 계약 오류다. */
function incomplete(): Error { return new Error("GitHub pull request search metadata is incomplete. Refresh to try again."); }
