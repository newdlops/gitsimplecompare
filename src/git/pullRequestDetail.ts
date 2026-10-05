// PR 상세의 전체 파일·리뷰 댓글을 읽고 페이지 누락·ref 변경이 섞인 결과를 거절한다.
import { CommitFileChange } from "../graph/graphTypes";
import { FileChangeStatus } from "./gitTypes";
import type { GhExecute } from "./ghRunner";
import { readGitHubInteractive } from "./githubReadCache";
import { splitRepositoryName } from "./githubRepository";
import { reviewThreadCommentCount } from "./pullRequestCommentCounts";

/** changed file의 변경량과 파일별 리뷰 댓글 수다. */
export interface PullRequestChangedFileInfo extends CommitFileChange { commentCount: number; }
/** 상세 drawer에 표시할 전체 파일·댓글 데이터와 명시적인 페이지 상한 상태다. */
export interface PullRequestDetailInfo {
  number: number;
  commentCount: number;
  fileCommentCount: number;
  fileCount: number;
  files: PullRequestChangedFileInfo[];
  filesTruncated: boolean;
  reviewThreadsTruncated: boolean;
}

const MAX_DETAIL_PAGES = 20;
const FILE_FIELDS = "nodes { path additions deletions changeType } pageInfo { hasNextPage endCursor }";
const THREAD_FIELDS = "nodes { path comments(first: 1) { totalCount } } pageInfo { hasNextPage endCursor }";
/** 첫 응답과 후속 응답 모두 같은 head/base를 읽었는지 추가 요청 없이 판별한다. */
const ANCHOR_FIELDS = "number headRefOid baseRefOid";
const DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    ${ANCHOR_FIELDS} comments(first: 1) { totalCount }
    files(first: 100) { totalCount ${FILE_FIELDS} }
    reviewThreads(first: 100) { ${THREAD_FIELDS} }
  } }
}`;

interface PageInfo { hasNextPage: boolean; endCursor?: string | null; }
interface Connection<T> { nodes: T[]; pageInfo: PageInfo; totalCount?: number; }
interface ChangedFile { path: string; additions: number; deletions: number; changeType: string; }
interface ReviewThread { path: string; comments: { totalCount: number }; }
interface Detail {
  number: number; headRefOid: string; baseRefOid: string;
  comments?: { totalCount?: number };
  files?: Connection<ChangedFile>;
  reviewThreads?: Connection<ReviewThread>;
}
interface Response { errors?: unknown[]; data?: { repository?: { pullRequest?: Detail } }; }
type ConnectionKind = "files" | "reviewThreads";

/**
 * PR 하나의 파일과 리뷰 댓글을 읽는다. 두 꼬리는 병렬로 읽고 한쪽 실패 시 다른 쪽도 취소한다.
 * @param cwd 실행 저장소, repository owner/name(gh placeholder 포함), number PR 번호
 * @param signal 소비자 취소 신호, runner 테스트 또는 production 조회 실행기
 * @returns 같은 head/base에서 읽은 상세. 누락·잘못된 페이지는 불완전한 성공 대신 오류다.
 */
export async function fetchPullRequestDetail(
  cwd: string, repository: string, number: number, signal?: AbortSignal, runner: GhExecute = readGitHubInteractive
): Promise<PullRequestDetailInfo> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const [owner, name] = splitRepositoryName(repository);
  try {
    const out = await runner(graphQlArgs(owner, name, number, DETAIL_QUERY), cwd,
      { operation: "pr-detail", signal: controller.signal });
    controller.signal.throwIfAborted();
    const pr = parseDetail(out, number);
    const firstFiles = connection<ChangedFile>(pr, "files");
    const firstThreads = connection<ReviewThread>(pr, "reviewThreads");
    const total = count(firstFiles.totalCount, "file count");
    const conversation = count(pr.comments?.totalCount, "conversation count");
    const files = [...firstFiles.nodes], threads = [...firstThreads.nodes];
    let failure: unknown;
    /** 처음 실패한 원인을 보존하면서 이미 필요 없는 다른 페이지 조회를 해제한다. */
    const guard = <T>(promise: Promise<T>) => promise.catch(error => { failure ??= error; controller.abort(); throw error; });
    const tails = [
      guard(appendPages(cwd, owner, name, pr, "files", firstFiles, files, runner, controller.signal)),
      guard(appendPages(cwd, owner, name, pr, "reviewThreads", firstThreads, threads, runner, controller.signal)),
    ];
    let states: boolean[];
    try { states = await Promise.all(tails); }
    catch (error) { await Promise.allSettled(tails); throw failure ?? error; }
    controller.signal.throwIfAborted();
    if (!states[0] && files.length !== total) throw new Error("Pull request file pagination is incomplete. Refresh to try again.");
    const fileCounts = reviewCommentCountsByPath(threads);
    const fileCommentCount = [...fileCounts.values()].reduce((sum, value) => sum + value, 0);
    return {
      number, commentCount: conversation + fileCommentCount, fileCommentCount, fileCount: total,
      files: normalizeFiles(files, fileCounts), filesTruncated: states[0], reviewThreadsTruncated: states[1],
    };
  } catch (error) { controller.abort(); throw error; }
  finally { signal?.removeEventListener("abort", abort); }
}

/**
 * 파일·스레드 꼬리를 같은 규칙으로 이어 읽어 누락 연결과 반복 커서가 성공으로 끝나는 것을 막는다.
 * @param initial 첫 연결, output 누적 배열, anchor 처음 읽은 PR 번호/head/base
 * @returns 기존 20페이지 상한 때문에 남은 페이지가 있는지 여부
 */
async function appendPages<T>(cwd: string, owner: string, name: string, anchor: Detail, kind: ConnectionKind,
  initial: Connection<T>, output: T[], runner: GhExecute, signal: AbortSignal): Promise<boolean> {
  let page = initial, pages = 1;
  const cursors = new Set<string>();
  while (page.pageInfo.hasNextPage && pages < MAX_DETAIL_PAGES) {
    signal.throwIfAborted();
    const cursor = page.pageInfo.endCursor!;
    if (cursors.has(cursor)) throw new Error(`Pull request ${kind} pagination cursor repeated. Refresh to try again.`);
    cursors.add(cursor);
    const query = pageQuery(kind);
    const out = await runner(graphQlArgs(owner, name, anchor.number, query, cursor), cwd,
      { operation: kind === "files" ? "pr-detail-files" : "pr-detail-threads", signal });
    signal.throwIfAborted();
    const pr = parseDetail(out, anchor.number);
    if (pr.headRefOid !== anchor.headRefOid || pr.baseRefOid !== anchor.baseRefOid) {
      throw new Error("Pull request head/base changed while loading details. Refresh to try again.");
    }
    page = connection<T>(pr, kind);
    output.push(...page.nodes); pages++;
  }
  return page.pageInfo.hasNextPage;
}

/** PR 존재 여부·GraphQL 오류·ref 식별자를 검사해 null/부분 응답을 빈 목록으로 오해하지 않는다. */
function parseDetail(out: string, number: number): Detail {
  const response = JSON.parse(out) as Response;
  if (response.errors?.length) throw new Error("GitHub returned incomplete pull request details. Refresh to try again.");
  const pr = response.data?.repository?.pullRequest;
  if (!pr) throw new Error(`Pull request #${number} is not available.`);
  if (pr.number !== number || typeof pr.headRefOid !== "string" || !pr.headRefOid || typeof pr.baseRefOid !== "string" || !pr.baseRefOid) {
    throw new Error("Pull request detail identity is incomplete. Refresh to try again.");
  }
  return pr;
}

/** 요청한 연결의 노드·pageInfo·필수 스칼라를 검사해 필터로 누락된 파일/댓글이 숨지 않게 한다. */
function connection<T>(pr: Detail, kind: ConnectionKind): Connection<T> {
  const value = pr[kind];
  if (!value || !Array.isArray(value.nodes) || !value.pageInfo || typeof value.pageInfo.hasNextPage !== "boolean" ||
    (value.pageInfo.hasNextPage && (typeof value.pageInfo.endCursor !== "string" || !value.pageInfo.endCursor))) {
    throw new Error(`Pull request ${kind} page is incomplete. Refresh to try again.`);
  }
  for (const node of value.nodes) {
    if (!node || typeof node.path !== "string" || !node.path) throw new Error(`Pull request ${kind} node is incomplete.`);
    if (kind === "files") {
      const file = node as ChangedFile;
      count(file.additions, "additions"); count(file.deletions, "deletions");
      if (typeof file.changeType !== "string" || !file.changeType) throw new Error("Pull request file status is incomplete.");
    } else count((node as ReviewThread).comments?.totalCount, "review comment count");
  }
  return value as Connection<T>;
}

/** 응답의 개수를 검증해 필수 값 누락이나 음수를 0으로 조용히 바꾸지 않는다. */
function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Pull request ${label} is incomplete.`);
  return value;
}

/** 같은 필드와 ref 앵커를 파일·스레드 꼬리 쿼리에 넣으며 기존 요청 수를 유지한다. */
function pageQuery(kind: ConnectionKind): string {
  return `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      ${ANCHOR_FIELDS} ${kind}(first: 100, after: $cursor) { ${kind === "files" ? FILE_FIELDS : THREAD_FIELDS} }
    } }
  }`;
}

/** owner/name·PR 번호와 선택적인 커서를 gh에 개별 인자로 전달한다. */
function graphQlArgs(owner: string, name: string, number: number, query: string, cursor?: string): string[] {
  return ["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`,
    ...(cursor === undefined ? [] : ["-f", `cursor=${cursor}`]), "-f", `query=${query}`];
}

/** 같은 파일의 모든 리뷰 스레드 댓글을 합산하고 conversation 댓글과 별도로 유지한다. */
function reviewCommentCountsByPath(threads: ReviewThread[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads) counts.set(thread.path, (counts.get(thread.path) || 0) + reviewThreadCommentCount([thread]));
  return counts;
}

/** 검증한 모든 파일을 순서·변경량·댓글 수를 보존하며 drawer DTO로 정규화한다. */
function normalizeFiles(files: ChangedFile[], commentCounts: Map<string, number>): PullRequestChangedFileInfo[] {
  return files.map(file => ({ status: changeTypeToStatus(file.changeType), path: file.path,
    additions: file.additions, deletions: file.deletions, commentCount: commentCounts.get(file.path) || 0 }));
}

/** GitHub PatchStatus를 기존 git name-status 문자로 변환한다. */
function changeTypeToStatus(changeType: string): FileChangeStatus {
  switch (changeType) {
    case "ADDED": return "A";
    case "DELETED": return "D";
    case "RENAMED": return "R";
    case "COPIED": return "C";
    case "TYPE_CHANGED": return "T";
    default: return "M";
  }
}
