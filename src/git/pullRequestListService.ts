// Graph용 PR 목록을 가벼운 요약 조회와 제한된 정보/pagination 조회로 읽는 모듈.
// - 제목·상태·브랜치를 먼저 알리고, 최종 반환 전에는 모든 commit OID와 댓글 수를 완성한다.
import { readGitHub } from "./githubReadCache";
import { completePullRequestCommits } from "./pullRequestCommitPages";
import { PriorityReadQueue } from "../utils/priorityReadQueue";
import type { GhExecute, GhRunnerOptions } from "./ghRunner";
import { splitRepositoryName } from "./githubRepository";
import { fetchRemainingReviewThreadCommentCounts } from "./pullRequestCommentCounts";
import { buildPullRequestInfoQuery, pullRequestInfoFromGraphQl, PULL_REQUEST_SUMMARY_QUERY } from "./pullRequestInfo";
import type { GhPageInfo, GhPullRequestNode, PullRequestInfo } from "./pullRequestInfo";
import { logError, logInfo } from "../ui/outputLog";

/** 가벼운 80개 요약 뒤에는 최대 connection 크기로 후속 네트워크 왕복을 줄인다. */
const PULL_REQUEST_PAGE_SIZE = 80;
const COMMIT_PREVIEW_PAGE_SIZE = 100;
const REVIEW_THREAD_PREVIEW_PAGE_SIZE = 100;
/** 정렬된 80개 connection 아래에서 중첩 정보를 한꺼번에 확장하지 않는 묶음 크기다. */
const PULL_REQUEST_METADATA_BATCH_SIZE = 20;
/** 큰 PR 여러 개가 있어도 동시에 실행하는 추가 GitHub 요청은 네 개로 제한한다. */
const MAX_PARALLEL_REQUESTS = 4;
/** 응답 없는 네트워크 한 건이 Graph PR 목록을 무기한 붙잡지 않도록 하는 대기 상한이다. */
const QUERY_TIMEOUT_MS = 30_000;

/** 네트워크 환경 또는 결정적 테스트에서 PR read 한 건의 대기 상한을 조정한다. */
export interface PullRequestListOptions {
  /** 요청당 허용 시간(밀리초). 미지정 시 30초이며 실패 시 기존 성공 목록을 유지한다. */
  requestTimeoutMs?: number;
  /** 첫 표시와 후속 정보 완성 때 호출한다. 불완전한 commit은 Git 쓰기에 사용할 수 없다. */
  onProgress?: (page: PullRequestListPage) => void;
  /** 같은 repository·base/head OID의 완성된 commit 목록만 재사용한다. */
  previous?: { repository: string; pullRequests: PullRequestInfo[] };
}

const PULL_REQUESTS_QUERY = `
query($owner: String!, $name: String!, $limit: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef { name }
    pullRequests(first: $limit, after: $cursor, states: [OPEN, CLOSED, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        id
${PULL_REQUEST_SUMMARY_QUERY}
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/** 원래 목록과 같은 전체 필드를 global ID로 직접 읽어 무거운 root connection을 피한다. */
const PULL_REQUEST_NODES_QUERY = `
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
${buildPullRequestInfoQuery(COMMIT_PREVIEW_PAGE_SIZE, REVIEW_THREAD_PREVIEW_PAGE_SIZE)}
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
  errors?: unknown[];
  data?: {
    repository?: {
      nameWithOwner?: string;
      defaultBranchRef?: { name?: string };
      pullRequests?: { nodes?: Array<GhPullRequestNode | null>; pageInfo?: GhPageInfo };
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
 * @param options 요청당 대기 상한·진행 callback·이전 완성 목록. 반환 데이터를 제한하지 않는다.
 * @returns commit과 댓글 pagination을 완료한 PR 페이지. 취소·조회 실패는 그대로 던진다.
 */
export async function fetchPullRequestListPage(
  repoRoot: string,
  cursor?: string,
  signal?: AbortSignal,
  runner: GhExecute = readGitHub,
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
  let requestFailure: { error: unknown } | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const pagination: Promise<void>[] = [];
  let paginationError: { error: unknown } | undefined;
  /** 내부 peer 취소가 동시에 도착한 실제 네트워크/pagination 실패를 숨기지 않게 한다. */
  const ensureActive = () => {
    if (controller.signal.aborted) throw requestFailure?.error ?? paginationError?.error
      ?? new DOMException("Graph pull request request was cancelled.", "AbortError");
  };
  const requestQueue = new PriorityReadQueue(MAX_PARALLEL_REQUESTS);
  const measuredRunner: GhExecute = async (args, cwd, options) => {
    throwIfAborted(options.signal);
    return requestQueue.run(async () => {
      requests++;
      try { return await executeQuery(args, cwd, options, runner, timeoutMs); }
      catch (error) {
        // 슬롯 반환 전에 대기 요청을 취소해 실패 뒤 새 CLI가 시작되는 틈을 막는다.
        if (!(error instanceof Error && error.name === "AbortError")) requestFailure ??= { error };
        controller.abort(); throw error;
      }
    }, options.signal ?? controller.signal);
  };
  try {
    const output = await measuredRunner([
      "api", "graphql", "-F", "owner={owner}", "-F", "name={repo}",
      "-F", `limit=${PULL_REQUEST_PAGE_SIZE}`,
      ...(cursor ? ["-f", `cursor=${cursor}`] : []),
      "-f", `query=${PULL_REQUESTS_QUERY}`,
    ], repoRoot, { signal: controller.signal, operation: "graph-pr-list-page" });
    ensureActive();
    const response = JSON.parse(output) as GhListResponse;
    const repository = response.data?.repository;
    if (response.errors?.length || !repository?.nameWithOwner || !Array.isArray(repository.pullRequests?.nodes)
      || typeof repository.pullRequests.pageInfo?.hasNextPage !== "boolean") {
      throw new Error("GitHub pull request list is not available.");
    }
    const [owner, name] = splitRepositoryName(repository.nameWithOwner);
    const references = repository.pullRequests.nodes || [];
    validateSummaryNodes(references);
    const previous = new Map(options.previous?.repository === repository.nameWithOwner
      ? options.previous.pullRequests.map(pr => [pr.number, pr] as const) : []);
    const summaries = references.map(node => {
      const pr = pullRequestInfoFromGraphQl(node!);
      // 요약에는 합계·commit을 요청하지 않았으므로 아직 모르는 값을 완료로 표시하지 않는다.
      pr.commentCountComplete = false; pr.commitHashesComplete = false; pr.fileCountComplete = false;
      reuseCommitSnapshot(pr, previous.get(pr.number));
      return pr;
    });
    const basePage = { repository: repository.nameWithOwner, defaultBranch: repository.defaultBranchRef?.name,
      pageInfo: repository.pullRequests.pageInfo };
    // 제목·상태·branch는 첫 왕복에서 게시하고 기존 UI의 완료 플래그로 Git 작업을 보호한다.
    if (summaries.length) publishProgress({ ...basePage, pullRequests: summaries }, options.onProgress, repoRoot);
    logInfo("graph pull request summary ready", { repoRoot, pullRequests: summaries.length, elapsedMs: Date.now() - started });
    logInfo("graph pull request list identities ready", {
      repoRoot, pullRequests: references.length, elapsedMs: Date.now() - started,
      metadataBatches: Math.ceil(references.length / PULL_REQUEST_METADATA_BATCH_SIZE),
    });
    const metadataStarted = Date.now();
    const pullRequests = summaries;
    const page = { ...basePage, pullRequests };
    let paginationTasks = 0, reusedCommits = 0;
    // 객체 복사로 이미 표시한 snapshot을 보호하고 완료 burst는 100ms 간격으로 모아 보낸다.
    const publish = () => {
      progressTimer = undefined;
      if (!controller.signal.aborted) publishProgress(page, options.onProgress, repoRoot);
    };
    // PR 전체 pagination이 끝나기 전에도 완료된 PR의 숫자를 먼저 게시한다.
    const scheduleProgress = () => {
      if (options.onProgress && !progressTimer && !controller.signal.aborted) progressTimer = setTimeout(publish, 100);
    };
    /** 검증한 metadata 묶음은 다른 느린 묶음을 기다리지 않고 후속 connection 조회를 시작한다. */
    const hydrate = (nodes: GhPullRequestNode[], offset: number) => {
      const tasks: Array<() => Promise<void>> = [];
      nodes.forEach((node, index) => {
        const pr = pullRequestInfoFromGraphQl(node); pullRequests[offset + index] = pr;
        if (reuseCommitSnapshot(pr, previous.get(pr.number))) reusedCommits++;
        if (pr.commitHashesComplete === false) tasks.push(() => appendCommitHashes(repoRoot, owner, name, node, pr, controller.signal, measuredRunner));
      });
      const reviews = nodes.map((node, index) => ({ node, pr: pullRequests[offset + index] }))
        .filter(({ node }) => node.reviewThreads?.pageInfo?.hasNextPage);
      for (let reviewOffset = 0; reviewOffset < reviews.length; reviewOffset += 4) {
        const batch = reviews.slice(reviewOffset, reviewOffset + 4);
        tasks.push(async () => {
          await fetchRemainingReviewThreadCommentCounts(repoRoot, owner, name, batch.map(item => item.node), controller.signal, measuredRunner,
            (number, count) => {
              const pr = batch.find(item => item.pr.number === number)!.pr;
              pr.commentCount += count; pr.commentCountComplete = true; scheduleProgress();
            });
        });
      }
      paginationTasks += tasks.length;
      const completion = completePagination(tasks, controller, scheduleProgress).catch(error => {
        paginationError ??= { error }; controller.abort(); throw error;
      });
      pagination.push(completion); void completion.catch(() => undefined);
      scheduleProgress();
    };
    let nodes: GhPullRequestNode[];
    try { nodes = await readPullRequestNodes(repoRoot, references, controller, measuredRunner, hydrate); }
    catch (error) { throw paginationFailure(error, requestFailure?.error ?? paginationError?.error); }
    ensureActive();
    logInfo("graph pull request metadata ready", { repoRoot, pullRequests: nodes.length, elapsedMs: Date.now() - started,
      metadataElapsedMs: Date.now() - metadataStarted });
    if (paginationTasks) {
      publish();
      logInfo("graph pull request first page ready", { repoRoot, pullRequests: pullRequests.length,
        elapsedMs: Date.now() - started, paginationTasks, reusedCommits });
    }
    await Promise.allSettled(pagination);
    if (paginationError) throw paginationFailure(paginationError.error, requestFailure?.error);
    ensureActive();
    logInfo("graph pull request page complete", {
      repoRoot, pullRequests: pullRequests.length, requests, paginationTasks,
      elapsedMs: Date.now() - started, reusedCommits,
    });
    return page;
  } finally {
    controller.abort(); await Promise.allSettled(pagination);
    clearTimeout(progressTimer);
    signal?.removeEventListener("abort", cancel);
  }
}

/**
 * 첫 목록의 표시 필드와 global ID를 검증해 잘못된 제목/빈 PR이 먼저 게시되지 않게 한다.
 * @param nodes root connection의 순서대로 받은 기본 PR 정보
 * @returns 모두 검증되면 정상 완료. 누락·중복·부분 응답은 전체 조회 오류다.
 */
function validateSummaryNodes(nodes: Array<GhPullRequestNode | null>): void {
  const ids = new Set<string>(), numbers = new Set<number>();
  for (const node of nodes) {
    if (!node?.id || !node.id.trim() || ids.has(node.id) || !Number.isSafeInteger(node.number) || Number(node.number) <= 0
      || numbers.has(node.number!) || typeof node.title !== "string" || !["OPEN", "CLOSED", "MERGED"].includes(node.state || "")
      || !node.url || typeof node.headRefName !== "string" || typeof node.baseRefName !== "string") {
      throw new Error("GitHub pull request identities or summary are incomplete.");
    }
    ids.add(node.id); numbers.add(node.number!);
  }
}

/** 같은 base/head로 검증한 원래 commit snapshot만 첫/후속 표시에서 재사용한다. */
function reuseCommitSnapshot(pr: PullRequestInfo, known: PullRequestInfo | undefined): boolean {
  if (pr.commitHashesComplete !== false || known?.commitHashesComplete !== true
    || !pr.headHash || !pr.baseHash || pr.headHash !== known.headHash || pr.baseHash !== known.baseHash
    || pr.baseRefName !== known.baseRefName) return false;
  pr.commitHashes = [...known.commitHashes]; pr.commitHashesComplete = true; return true;
}

/** 복사한 진행 snapshot만 UI에 보내며 callback 실패가 실제 조회를 중단하지 않게 한다. */
function publishProgress(page: PullRequestListPage, callback: PullRequestListOptions["onProgress"], repoRoot: string): void {
  try { callback?.({ ...page, pullRequests: page.pullRequests.map(pr => ({ ...pr, commitHashes: [...pr.commitHashes], labels: pr.labels?.map(label => ({ ...label })) })) }); }
  catch (error) { logError("graph pull request progress publication failed", error, { repoRoot }); }
}

/**
 * 정렬된 목록의 global ID를 작은 묶음으로 직접 조회하고 모든 PR 필드를 원래 순서로 돌려준다.
 * - 기존 페이지 크기·cursor·commit/review 첫 페이지 크기는 유지한다.
 * - measuredRunner의 공통 슬롯을 써 실제 네트워크 동시 실행은 네 개를 넘지 않는다.
 * - 누락·중복·다른 ID·GraphQL 부분 오류는 전체 조회 오류로 처리해 불완전한 성공을 막는다.
 * @param repoRoot gh가 host와 인증 문맥을 해석할 저장소 루트
 * @param references 첫 root connection에서 받은 PR global ID 목록
 * @param controller 모든 조회의 취소·첫 실패를 공유하는 수명주기
 * @param runner 요청 시간 상한과 동시 실행을 적용한 실행기
 * @param onBatch 검증한 묶음과 원래 목록 위치를 알려 후속 페이지를 즉시 시작할 콜백
 * @returns 모든 필드가 준비된 PR node 배열. 순서는 root connection과 같다.
 */
async function readPullRequestNodes(
  repoRoot: string,
  references: Array<GhPullRequestNode | null>,
  controller: AbortController,
  runner: GhExecute,
  onBatch: (nodes: GhPullRequestNode[], offset: number) => void
): Promise<GhPullRequestNode[]> {
  const ids = references.map(node => node?.id);
  if (ids.some(id => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error("GitHub pull request identities are not available.");
  }
  const nodes = new Array<GhPullRequestNode>(references.length);
  const tasks: Array<() => Promise<void>> = [];
  for (let offset = 0; offset < ids.length; offset += PULL_REQUEST_METADATA_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + PULL_REQUEST_METADATA_BATCH_SIZE) as string[];
    tasks.push(async () => {
      const output = await runner([
        "api", "graphql", ...batch.flatMap(id => ["-F", `ids[]=${id}`]), "-f", `query=${PULL_REQUEST_NODES_QUERY}`,
      ], repoRoot, { signal: controller.signal, operation: "graph-pr-list-nodes" });
      throwIfAborted(controller.signal);
      const response = JSON.parse(output) as { errors?: unknown[]; data?: { nodes?: Array<GhPullRequestNode | null> } };
      if (response.errors?.length || !Array.isArray(response.data?.nodes) || response.data.nodes.length !== batch.length) {
        throw new Error("GitHub pull request information is not available.");
      }
      const byId = new Map<string, GhPullRequestNode>();
      const expectedNumbers = new Map(batch.map((id, index) => [id, references[offset + index]!.number]));
      for (const node of response.data.nodes) {
        if (!node?.id || !batch.includes(node.id) || byId.has(node.id) || !Number.isSafeInteger(node.number) || Number(node.number) <= 0
          || node.number !== expectedNumbers.get(node.id) || !hasPullRequestNodeConnections(node)) {
          throw new Error("GitHub pull request identity is incomplete.");
        }
        byId.set(node.id, node);
      }
      for (let index = 0; index < batch.length; index++) nodes[offset + index] = byId.get(batch[index])!;
      onBatch(nodes.slice(offset, offset + batch.length), offset);
    });
  }
  await completePagination(tasks, controller, () => {});
  return nodes;
}

/**
 * 조회한 commit·review 연결의 nodes/pageInfo와 파일·대화 합계가 응답에 실제로 있는지 확인한다.
 * - pagination이 남아 있는 정상 연결은 허용하며, 빠진 연결을 빈 완료 목록으로 해석하지 않는다.
 * @param node 직접 ID 조회에서 받은 PR 메타데이터
 * @returns 요청한 연결과 합계 필드가 모두 있으면 true
 */
function hasPullRequestNodeConnections(node: GhPullRequestNode): boolean {
  return Array.isArray(node.commits?.nodes) && typeof node.commits?.pageInfo?.hasNextPage === "boolean"
    && Array.isArray(node.reviewThreads?.nodes) && typeof node.reviewThreads?.pageInfo?.hasNextPage === "boolean"
    && Number.isSafeInteger(node.comments?.totalCount) && Number(node.comments?.totalCount) >= 0
    && Number.isSafeInteger(node.files?.totalCount) && Number(node.files?.totalCount) >= 0;
}

/**
 * peer 취소가 첫 네트워크 오류를 숨기지 않되, JSON/identity 오류는 취소 오류로 바꾸지 않는다.
 * @param error 작업 그룹에서 관찰한 첫 오류
 * @param requestError 실제 실행 경계에서 취소 전 기록한 원래 요청 오류
 * @returns 사용자에게 전달할 원래 실패 또는 외부 취소 오류
 */
function paginationFailure(error: unknown, requestError: unknown): unknown {
  return error instanceof Error && error.name === "AbortError" ? requestError ?? error : error;
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
  await completePullRequestCommits(repoRoot, owner, name, node, pullRequest, signal, runner);
}

/**
 * 모든 PR/connection을 등록하고 요청 단위 큐가 페이지마다 공정하게 실행 기회를 나누게 한다.
 * - 한 작업 실패 시 다른 작업도 취소하고 모두 정리한 뒤 최초 오류를 전달한다.
 * @param tasks PR별 commit 또는 review thread pagination 작업
 * @param controller 외부 취소와 작업 실패를 함께 전달할 페이지 수명주기
 * @returns 모든 작업이 성공하면 완료되며, 부분 결과는 호출부에 반환하지 않는다.
 */
async function completePagination(tasks: Array<() => Promise<void>>, controller: AbortController, onCompleted: () => void): Promise<void> {
  let failure: { error: unknown } | undefined;
  await Promise.allSettled(tasks.map(async task => {
    try {
      throwIfAborted(controller.signal);
      await task();
      if (!controller.signal.aborted) onCompleted();
    } catch (error) {
      failure ??= { error };
      controller.abort();
    }
  }));
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
