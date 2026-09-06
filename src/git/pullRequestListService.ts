// Graph용 PR 목록을 한 번의 저장소 조회와 제한된 후속 pagination으로 읽는 모듈.
// - UI에 전달하기 전에 모든 commit OID와 기존 기준의 댓글 수를 완성한다.
import { runGh } from "./ghCli";
import type { GhExecute, GhRunnerOptions } from "./ghRunner";
import { splitRepositoryName } from "./githubRepository";
import { fetchRemainingReviewThreadCommentCounts } from "./pullRequestCommentCounts";
import { buildPullRequestInfoQuery, pullRequestInfoFromGraphQl } from "./pullRequestInfo";
import type { GhPageInfo, GhPullRequestNode, PullRequestInfo } from "./pullRequestInfo";
import { logInfo } from "../ui/outputLog";

/** 화면의 기존 PR 페이지 크기를 유지하고 중첩 connection만 작게 시작한다. */
const PULL_REQUEST_PAGE_SIZE = 80;
const COMMIT_PREVIEW_PAGE_SIZE = 30;
const REVIEW_THREAD_PREVIEW_PAGE_SIZE = 20;
/** 큰 PR 여러 개가 있어도 동시에 실행하는 추가 GitHub 요청은 네 개로 제한한다. */
const MAX_PARALLEL_REQUESTS = 4;
/** 응답 없는 네트워크 한 건이 Graph PR 목록을 무기한 붙잡지 않도록 하는 대기 상한이다. */
const QUERY_TIMEOUT_MS = 30_000;

/** 네트워크 환경 또는 결정적 테스트에서 PR read 한 건의 대기 상한을 조정한다. */
export interface PullRequestListOptions {
  /** 요청당 허용 시간(밀리초). 미지정 시 30초이며 실패 시 기존 성공 목록을 유지한다. */
  requestTimeoutMs?: number;
}

const PULL_REQUESTS_QUERY = `
query($owner: String!, $name: String!, $limit: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef { name }
    pullRequests(first: $limit, after: $cursor, states: [OPEN, CLOSED, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
${buildPullRequestInfoQuery(COMMIT_PREVIEW_PAGE_SIZE, REVIEW_THREAD_PREVIEW_PAGE_SIZE)}
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const PULL_REQUEST_COMMITS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: 100, after: $cursor) {
        nodes { commit { oid } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/** Graph 목록과 stack이 같은 응답에서 재사용할 저장소 정보 및 완성된 PR 페이지다. */
export interface PullRequestListPage {
  repository: string;
  defaultBranch?: string;
  pullRequests: PullRequestInfo[];
  pageInfo?: GhPageInfo;
}

interface GhListResponse {
  data?: {
    repository?: {
      nameWithOwner?: string;
      defaultBranchRef?: { name?: string };
      pullRequests?: { nodes?: GhPullRequestNode[]; pageInfo?: GhPageInfo };
    };
  };
}

interface GhCommitPageResponse {
  data?: {
    repository?: {
      pullRequest?: { commits?: GhPullRequestNode["commits"] };
    };
  };
}

/**
 * Graph용 PR 목록을 읽되 gh의 저장소 문맥을 GraphQL 변수로 직접 전달한다.
 * - 별도 `gh repo view` 네트워크 왕복 없이 nameWithOwner/defaultBranchRef를 함께 받는다.
 * - GH_REPO, default remote 등 저장소 선택은 gh가 기존 규칙대로 처리한다.
 * @param repoRoot gh를 실행할 저장소 루트
 * @param cursor 이전 PR 페이지의 endCursor. 없으면 첫 페이지
 * @param signal 패널 수명주기와 연결된 선택적 취소 신호
 * @param runner production gh 또는 지연/실패를 제어하는 테스트 실행기
 * @param options 요청당 대기 상한. 전체 PR 페이지 수나 반환 데이터는 제한하지 않는다.
 * @returns commit과 댓글 pagination을 완료한 PR 페이지. 취소·조회 실패는 그대로 던진다.
 */
export async function fetchPullRequestListPage(
  repoRoot: string,
  cursor?: string,
  signal?: AbortSignal,
  runner: GhExecute = runGh,
  options: PullRequestListOptions = {}
): Promise<PullRequestListPage> {
  throwIfAborted(signal);
  const timeoutMs = options.requestTimeoutMs ?? QUERY_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Pull request query timeout must be a positive timer duration.");
  }
  const started = Date.now();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  let requests = 0;
  const measuredRunner: GhExecute = async (args, cwd, options) => {
    throwIfAborted(options.signal);
    requests++;
    return executeQuery(args, cwd, options, runner, timeoutMs);
  };
  try {
    const output = await measuredRunner([
      "api", "graphql", "-F", "owner={owner}", "-F", "name={repo}",
      "-F", `limit=${PULL_REQUEST_PAGE_SIZE}`,
      ...(cursor ? ["-f", `cursor=${cursor}`] : []),
      "-f", `query=${PULL_REQUESTS_QUERY}`,
    ], repoRoot, { signal: controller.signal, operation: "graph-pr-list-page" });
    throwIfAborted(controller.signal);
    const repository = (JSON.parse(output) as GhListResponse).data?.repository;
    if (!repository?.nameWithOwner || !repository.pullRequests) {
      throw new Error("GitHub pull request list is not available.");
    }
    const [owner, name] = splitRepositoryName(repository.nameWithOwner);
    const nodes = repository.pullRequests.nodes || [];
    const pullRequests = nodes.map((node) => pullRequestInfoFromGraphQl(node));
    const tasks: Array<() => Promise<void>> = [];
    nodes.forEach((node, index) => {
      if (node.commits?.pageInfo?.hasNextPage) {
        tasks.push(() => appendCommitHashes(repoRoot, owner, name, node, pullRequests[index], controller.signal, measuredRunner));
      }
      if (node.reviewThreads?.pageInfo?.hasNextPage) {
        tasks.push(async () => {
          const counts = await fetchRemainingReviewThreadCommentCounts(repoRoot, owner, name, [node], controller.signal, measuredRunner);
          pullRequests[index].commentCount += counts.get(Number(node.number)) || 0;
        });
      }
    });
    await completePagination(tasks, controller);
    throwIfAborted(controller.signal);
    logInfo("graph pull request page complete", {
      repoRoot, pullRequests: pullRequests.length, requests, paginationTasks: tasks.length,
      elapsedMs: Date.now() - started,
    });
    return {
      repository: repository.nameWithOwner,
      defaultBranch: repository.defaultBranchRef?.name,
      pullRequests,
      pageInfo: repository.pullRequests.pageInfo,
    };
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

/**
 * 원격 조회 한 건의 시간·취소·실패를 기록하고 무응답 네트워크를 중단한다.
 * - 전체 pagination의 signal과 별도 child signal을 연결하므로 timeout은 일반 조회 오류로
 *   전달되고, 패널 숨김에 따른 취소는 기존 AbortError 의미를 유지한다.
 * - 실행기가 늦게 완료돼도 race가 응답을 관찰하므로 timeout 뒤 성공이 게시되거나
 *   늦은 거절이 처리되지 않은 promise로 남지 않는다. production gh 프로세스도 함께 종료한다.
 * @param args 조회 전용 gh 인자. 로그에는 인증 정보가 섞일 수 있는 원문을 기록하지 않는다.
 * @param repoRoot gh 실행 디렉터리
 * @param options 안전한 operation 이름과 전체 페이지의 취소 신호
 * @param runner gh 실행 구현 또는 테스트 실행기
 * @param timeoutMs 이 요청에서 허용할 최대 응답 대기 시간
 * @returns 제한 시간 안에 성공한 stdout. timeout·조회 실패·취소는 각각 오류로 전달한다.
 */
async function executeQuery(
  args: readonly string[],
  repoRoot: string,
  options: GhRunnerOptions,
  runner: GhExecute,
  timeoutMs: number
): Promise<string> {
  throwIfAborted(options.signal);
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  let status = "error";
  const interrupted = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      status = "cancelled";
      controller.abort();
      reject(new DOMException("Graph pull request request was cancelled.", "AbortError"));
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      status = "timeout";
      // 거절을 먼저 확정해 child의 abort 오류가 일반 timeout을 숨기지 않게 한다.
      reject(new Error("GitHub pull request query timed out. Refresh pull requests to try again."));
      controller.abort();
    }, timeoutMs);
  });
  try {
    const output = await Promise.race([
      interrupted,
      runner(args, repoRoot, { ...options, signal: controller.signal }),
    ]);
    status = "success";
    return output;
  } finally {
    clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener("abort", cancel);
    logInfo("graph pull request query finished", {
      repoRoot,
      operation: options.operation,
      status,
      elapsedMs: Date.now() - started,
      timeoutMs,
    });
  }
}

/**
 * 큰 PR의 나머지 commit OID를 cursor 순서대로 읽어 중복 없이 기존 배열에 덧붙인다.
 * @param repoRoot gh 실행 디렉터리
 * @param owner GitHub owner
 * @param name GitHub repository 이름
 * @param node 첫 페이지에서 받은 원본 PR 및 commit cursor
 * @param pullRequest 이 PR의 완성된 commit 배열을 기록할 결과 객체
 * @param signal 전체 페이지 조회의 취소 신호
 * @param runner 소요 시간과 요청 수를 기록하는 gh 실행기
 * @returns 모든 후속 commit 페이지가 합쳐졌을 때 완료된다.
 */
async function appendCommitHashes(
  repoRoot: string, owner: string, name: string,
  node: GhPullRequestNode, pullRequest: PullRequestInfo,
  signal: AbortSignal, runner: GhExecute
): Promise<void> {
  const number = Number(node.number);
  if (!Number.isFinite(number) || number <= 0) return;
  // head fallback은 모든 페이지 뒤에 붙여 중간 commit보다 먼저 적용되는 순서 오류를 막는다.
  const hashes = new Set((node.commits?.nodes || []).map((entry) => entry.commit?.oid || "").filter(Boolean));
  const cursors = new Set<string>();
  let pageInfo = node.commits?.pageInfo;
  while (pageInfo?.hasNextPage) {
    throwIfAborted(signal);
    const cursor = pageInfo.endCursor;
    if (!cursor || cursors.has(cursor)) {
      throw new Error("GitHub pull request commit pagination did not advance.");
    }
    cursors.add(cursor);
    const output = await runner([
      "api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`,
      "-F", `number=${number}`, "-f", `cursor=${cursor}`,
      "-f", `query=${PULL_REQUEST_COMMITS_QUERY}`,
    ], repoRoot, { signal, operation: "graph-pr-commit-page" });
    throwIfAborted(signal);
    const commits = (JSON.parse(output) as GhCommitPageResponse).data?.repository?.pullRequest?.commits;
    if (!commits) throw new Error("GitHub pull request commits are not available.");
    for (const entry of commits.nodes || []) {
      const hash = entry.commit?.oid;
      if (hash && !hashes.has(hash)) {
        hashes.add(hash);
      }
    }
    pageInfo = commits.pageInfo;
  }
  if (node.headRefOid) hashes.add(node.headRefOid);
  pullRequest.commitHashes = [...hashes];
}

/**
 * 서로 독립인 PR/connection은 병렬로 읽되 실행 수와 오류 후 추가 요청을 제한한다.
 * - 한 작업 실패 시 다른 작업도 취소하고 모두 정리한 뒤 최초 오류를 전달한다.
 * @param tasks PR별 commit 또는 review thread pagination 작업
 * @param controller 외부 취소와 작업 실패를 함께 전달할 페이지 수명주기
 * @returns 모든 작업이 성공하면 완료되며, 부분 결과는 호출부에 반환하지 않는다.
 */
async function completePagination(tasks: Array<() => Promise<void>>, controller: AbortController): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (next < tasks.length) {
      throwIfAborted(controller.signal);
      const task = tasks[next++];
      try { await task(); }
      catch (error) {
        failure ??= { error };
        controller.abort();
        return;
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(MAX_PARALLEL_REQUESTS, tasks.length) }, worker));
  if (failure) throw failure.error;
  throwIfAborted(controller.signal);
}

/**
 * 취소된 조회가 후속 gh 프로세스를 시작하거나 성공 결과를 반환하지 않도록 중단한다.
 * - gh 실행 전과 JSON 처리 뒤에 같은 신호를 확인해 늦은 결과의 게시를 차단한다.
 * - timeout은 별도의 일반 오류로 전달하므로 이 함수는 사용자·패널 취소만 판정한다.
 * @param signal 현재 PR 페이지 조회가 소유한 선택적 취소 신호
 * @throws 신호가 취소됐을 때 호출부의 기존 취소 처리가 인식하는 AbortError
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Graph pull request request was cancelled.", "AbortError");
}
