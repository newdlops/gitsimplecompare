// branch→PR 선택을 GraphQL 묶음으로 읽고 gh의 head/base/OPEN 우선 의미를 보존한다.
import type { GhExecute } from "./ghRunner";
import { readGitHub } from "./githubReadCache";
import { graphqlRead, type GitHubVariables } from "./githubReadRequest";
import { createGitHubReadSession, completeGitHubReadSession, gitHubReadSessionState } from "./githubReadSession";
import { GitHubApiError, graphQLResult } from "./githubApiError";
import { GhCliError } from "./ghCli";
import { PriorityReadQueue } from "../utils/priorityReadQueue";

/** 현재 branch의 push/upstream 해석 또는 명시 branch가 요구하는 PR 선택 조건이다. */
export interface PullRequestBranchSelector {
  key: string;
  headRefName?: string;
  owner?: string;
  baseRefName?: string;
  number?: number;
  headRepository?: { host: string; owner: string; name: string };
}
/** 스택·댓글이 공유하는 검증된 PR 정보이며 body는 요청했을 때만 제공한다. */
export interface BranchPullRequest {
  number: number; title: string; state: string; url: string; headRefName: string; baseRefName: string;
  isCrossRepository: boolean; headRepositoryOwner?: { login: string }; body?: string;
}
/** 쓰기 전 최신 조회와 UI 탐색은 같은 선택 규칙을 쓰며 API 페이지 캐시는 공유하지 않는다. */
export interface BranchLookupOptions {
  signal?: AbortSignal; includeBody?: boolean; states?: readonly string[];
  /** 읽기 전용 Advance만 개별 일반 오류를 건너뛴다. 쓰기 전 조회는 누락을 추측하지 않는다. */
  allowPartialFailures?: boolean;
}

interface Repository {
  nameWithOwner: string; url: string; defaultBranchRef?: { name?: string } | null;
  [alias: string]: unknown;
}
interface Response {
  data?: { repository?: Repository | null };
  errors?: Array<{ type?: string; path?: unknown }>;
}
const FIELDS = "number title state url headRefName baseRefName isCrossRepository headRepositoryOwner { login }";

/** 원문 응답·branch 인자를 보관하지 않는 조회/경합 오류다. */
export class PullRequestBranchLookupError extends Error {
  readonly kind = "branch-lookup";
  constructor(readonly reason: "selector" | "response" | "changed") {
    super("Cannot read complete branch pull requests. Refresh and try again.");
    this.name = "PullRequestBranchLookupError";
  }
}

/**
 * 최대 20개 branch씩 읽고 선택한 PR만 두 번째 body 조회로 확장한다.
 * @param root GitHub 실행 루트, selectors 원래 key와 head/base 조건, options 취소/본문/state 범위
 * @param execute 공통 read 실행기 또는 외부 경계 대역
 * @returns 입력 key 순서의 검증된 PR/명시적 없음. 완전한 sibling은 개별 alias 오류로 잃지 않는다.
 */
export async function findPullRequestsForBranches(root: string, selectors: readonly (string | PullRequestBranchSelector)[],
  options: BranchLookupOptions = {}, execute: GhExecute = readGitHub): Promise<Map<string, BranchPullRequest | undefined>> {
  options.signal?.throwIfAborted();
  const unique = new Map<string, PullRequestBranchSelector>();
  for (const input of selectors) {
    const selector = normalizeSelector(input), previous = unique.get(selector.key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(selector)) throw new PullRequestBranchLookupError("selector");
    unique.set(selector.key, selector);
  }
  if (!unique.size) return new Map();
  if (options.states?.some(state => !["OPEN", "CLOSED", "MERGED"].includes(state))) throw new PullRequestBranchLookupError("selector");
  const owns = !gitHubReadSessionState(execute), read = createGitHubReadSession(root, execute);
  const queue = new PriorityReadQueue(4), controller = new AbortController();
  const abort = () => controller.abort(); options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    let result = await groups([...unique.values()], false);
    if (options.includeBody) {
      const selected = [...result].flatMap(([key, value]) => value ? [{ key, number: value.number }] : []);
      const bodies = await groups(selected, true);
      for (const [key, before] of result) {
        if (!before) continue;
        const current = bodies.get(key);
        if (!current || current.number !== before.number || current.headRefName !== before.headRefName
          || current.baseRefName !== before.baseRefName || current.state !== before.state) throw new PullRequestBranchLookupError("changed");
        result.set(key, current);
      }
    }
    if (owns) await completeGitHubReadSession(read, controller.signal);
    return new Map([...unique.keys()].map(key => [key, result.get(key)]));
  } finally { options.signal?.removeEventListener("abort", abort); controller.abort(); }

  /** 네 개 이하의 실제 read만 허용하고 첫 fatal 오류 뒤 다른 묶음도 취소·종료한다. */
  async function groups(values: PullRequestBranchSelector[], body: boolean): Promise<Map<string, BranchPullRequest | undefined>> {
    const result = new Map<string, BranchPullRequest | undefined>();
    let failure: { error: unknown } | undefined;
    const batches: PullRequestBranchSelector[][] = [];
    for (let start = 0; start < values.length; start += 20) batches.push(values.slice(start, start + 20));
    await Promise.all(batches.map(async batch => {
      try { for (const [key, value] of await group(batch, body, false)) result.set(key, value); }
      catch (error) { failure ??= { error }; controller.abort(); }
    }));
    if (failure) throw failure.error;
    return result;
  }

  /** 식별 가능한 GraphQL alias 실패만 같은 credential의 개별 query로 한 번 분리한다. */
  async function group(values: PullRequestBranchSelector[], body: boolean, retry: boolean): Promise<Map<string, BranchPullRequest | undefined>> {
    const request = branchQuery(values, options.states, body);
    let response: Response, originalError: unknown;
    try {
      response = JSON.parse(await queue.run(() => read(request.args, root, { operation: "branch-pr-lookup",
        request: request.request, signal: controller.signal }), controller.signal)) as Response;
    } catch (error) {
      const partial = error instanceof GitHubApiError && error.kind === "graphql" ? graphQLResult(error)
        : error instanceof GhCliError && error.stdout ? parsePartial(error.stdout) : undefined;
      if (!partial) throw error;
      response = partial as Response; originalError = error;
    }
    const errors = response.errors ?? [];
    if (!Array.isArray(errors) || errors.some(error => /^(?:FORBIDDEN|UNAUTHORIZED|RATE_LIMITED)$/i.test(error.type ?? ""))) {
      throw originalError ?? new PullRequestBranchLookupError("response");
    }
    const repository = response.data?.repository;
    if (!repository || typeof repository.nameWithOwner !== "string" || typeof repository.url !== "string") {
      throw originalError ?? new PullRequestBranchLookupError("response");
    }
    const affected = new Set<string>();
    for (const error of errors) {
      if (!Array.isArray(error.path) || error.path[0] !== "repository" || !/^p\d+$/.test(String(error.path[1]))) {
        throw originalError ?? new PullRequestBranchLookupError("response");
      }
      affected.add(String(error.path[1]));
    }
    if (originalError && !errors.length) throw originalError;
    const result = new Map<string, BranchPullRequest | undefined>();
    for (let index = 0; index < values.length; index++) {
      const selector = values[index], alias = `p${index}`;
      if (affected.has(alias)) {
        if (retry) {
          if (!options.allowPartialFailures) throw originalError ?? new PullRequestBranchLookupError("response");
          result.set(selector.key, undefined);
        }
        else result.set(selector.key, (await group([selector], body, true)).get(selector.key));
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(repository, alias)) throw new PullRequestBranchLookupError("response");
      const raw = repository[alias];
      if (selector.number !== undefined) {
        const value = raw === null ? undefined : normalizeNode(raw, body);
        if (value && value.number !== selector.number) throw new PullRequestBranchLookupError("response");
        result.set(selector.key, value); continue;
      }
      const connection = raw as { nodes?: unknown[] } | undefined;
      if (!connection || !Array.isArray(connection.nodes) || connection.nodes.length > 30) throw new PullRequestBranchLookupError("response");
      const nodes = connection.nodes.map(node => normalizeNode(node, body));
      const ordered = [...nodes.filter(node => node.state === "OPEN"), ...nodes.filter(node => node.state !== "OPEN")];
      const head = expectedHead(selector, repository);
      const value = ordered.find(node => (!options.states || options.states.includes(node.state))
        && (!selector.baseRefName || selector.baseRefName === node.baseRefName)
        && (node.isCrossRepository ? `${node.headRepositoryOwner?.login ?? ""}:${node.headRefName}` : node.headRefName) === head
        && (node.state === "OPEN" || repository.defaultBranchRef?.name !== head));
      result.set(selector.key, value);
    }
    return result;
  }
}

/** head 값은 GraphQL 문서에 삽입하지 않고 타입을 보존한 변수로만 전달한다. */
function branchQuery(values: PullRequestBranchSelector[], states: readonly string[] | undefined, body: boolean) {
  const variables: Record<string, GitHubVariables[string]> = { owner: "{owner}", name: "{repo}" };
  const definitions = ["$owner:String!", "$name:String!"];
  if (values.some(value => value.number === undefined)) { definitions.push("$states:[PullRequestState!]"); variables.states = states ?? null; }
  const fields = values.map((value, index) => {
    if (value.number !== undefined) {
      definitions.push(`$number${index}:Int!`); variables[`number${index}`] = value.number;
      return `p${index}:pullRequest(number:$number${index}) { ${FIELDS}${body ? " body" : ""} }`;
    }
    definitions.push(`$head${index}:String!`); variables[`head${index}`] = value.headRefName!;
    return `p${index}:pullRequests(headRefName:$head${index},states:$states,first:30,orderBy:{field:CREATED_AT,direction:DESC}) { nodes { ${FIELDS} } }`;
  });
  return graphqlRead(`query(${definitions.join(",")}) { repository(owner:$owner,name:$name) {
    nameWithOwner url defaultBranchRef { name } ${fields.join("\n")} } }`, variables);
}

/** selector의 불완전한 key·번호·head를 요청 전에 거절한다. 숫자 branch는 branch로 유지한다. */
function normalizeSelector(input: string | PullRequestBranchSelector): PullRequestBranchSelector {
  const parts = typeof input === "string" ? input.split(":") : undefined;
  if (parts && parts.length > 2) throw new PullRequestBranchLookupError("selector");
  const value: PullRequestBranchSelector = typeof input === "string"
    ? { key: input, headRefName: parts!.at(-1), ...(parts!.length === 2 ? { owner: parts![0] } : {}) } : { ...input };
  if (!value.key || /[\r\n\0]/.test(value.key) || value.number !== undefined
    && (!Number.isSafeInteger(value.number) || value.number <= 0 || value.number > 2_147_483_647)) throw new PullRequestBranchLookupError("selector");
  if (value.number === undefined && (!value.headRefName || value.headRefName.length > 4096 || /[\r\n\0]/.test(value.headRefName))) {
    throw new PullRequestBranchLookupError("selector");
  }
  return value;
}

/** API 응답의 필수 선택 필드와 요청한 body를 확인하고 원본 객체 참조를 반환하지 않는다. */
function normalizeNode(raw: unknown, body: boolean): BranchPullRequest {
  if (!raw || typeof raw !== "object") throw new PullRequestBranchLookupError("response");
  const node = raw as Record<string, unknown>, owner = node.headRepositoryOwner as { login?: unknown } | null;
  if (!Number.isSafeInteger(node.number) || Number(node.number) <= 0 || typeof node.title !== "string" || typeof node.url !== "string"
    || typeof node.headRefName !== "string" || typeof node.baseRefName !== "string" || typeof node.isCrossRepository !== "boolean"
    || !["OPEN", "CLOSED", "MERGED"].includes(String(node.state)) || body && typeof node.body !== "string") {
    throw new PullRequestBranchLookupError("response");
  }
  return { number: node.number as number, title: node.title, url: node.url, state: node.state as string,
    headRefName: node.headRefName, baseRefName: node.baseRefName, isCrossRepository: node.isCrossRepository,
    ...(typeof owner?.login === "string" ? { headRepositoryOwner: { login: owner.login } } : {}),
    ...(body ? { body: node.body as string } : {}) };
}

/** 현재 branch의 head remote가 base repo와 다를 때만 owner-qualified label을 요구한다. */
function expectedHead(selector: PullRequestBranchSelector, repository: Repository): string {
  let owner = selector.owner;
  if (selector.headRepository) {
    let host: string;
    try { host = new URL(repository.url).host; } catch { throw new PullRequestBranchLookupError("response"); }
    const head = selector.headRepository;
    if (host.toLowerCase() !== head.host.toLowerCase()) throw new PullRequestBranchLookupError("selector");
    if (repository.nameWithOwner.toLowerCase() !== `${head.owner}/${head.name}`.toLowerCase()) owner = head.owner;
  }
  return owner ? `${owner}:${selector.headRefName}` : selector.headRefName!;
}

/** CLI의 JSON partial 응답만 구조화하고 원문 parse 오류는 노출하지 않는다. */
function parsePartial(value: string): Response | undefined {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed?.errors) ? parsed : undefined; } catch { return undefined; }
}
