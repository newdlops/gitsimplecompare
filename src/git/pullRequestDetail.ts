// GitHub Pull Request 상세 데이터를 필요할 때만 읽는 서비스 함수.
// - graph 최초 로드를 막지 않도록 changed files/review thread 정보는 PR 상세 drawer 가 열릴 때 조회한다.
import { CommitFileChange } from "../graph/graphTypes";
import { FileChangeStatus } from "./gitTypes";
import { runGh } from "./ghCli";
import { splitRepositoryName } from "./githubRepository";
import { reviewThreadCommentCount } from "./pullRequestCommentCounts";

/** PR 상세에서 한 changed file 의 파일별 리뷰 댓글 수를 함께 표현한다. */
export interface PullRequestChangedFileInfo extends CommitFileChange {
  commentCount: number;
}

/** PR 상세 drawer 에서 사용하는 changed files 중심 데이터 */
export interface PullRequestDetailInfo {
  number: number;
  /** conversation comment 와 file review comment 를 합친 PR 전체 댓글 수 */
  commentCount: number;
  /** file review thread 에 달린 댓글 수 */
  fileCommentCount: number;
  fileCount: number;
  files: PullRequestChangedFileInfo[];
  filesTruncated: boolean;
  reviewThreadsTruncated: boolean;
}

/** 방대한 PR 에서 drawer 로딩이 과도해지는 것을 막는 페이지 상한 */
const MAX_DETAIL_PAGES = 20;

/** PR 하나의 첫 상세 페이지를 읽는 GraphQL 쿼리 */
const PULL_REQUEST_DETAIL_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      comments(first: 1) { totalCount }
      files(first: 100) {
        totalCount
        nodes { path additions deletions changeType }
        pageInfo { hasNextPage endCursor }
      }
      reviewThreads(first: 100) {
        nodes {
          path
          comments(first: 1) { totalCount }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/** PR changed files 추가 페이지 GraphQL 쿼리 */
const PULL_REQUEST_FILES_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: 100, after: $cursor) {
        nodes { path additions deletions changeType }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/** PR review thread 추가 페이지 GraphQL 쿼리 */
const PULL_REQUEST_REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          path
          comments(first: 1) { totalCount }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

interface GhPullRequestDetailResponse {
  data?: {
    repository?: {
      pullRequest?: GhPullRequestDetail;
    };
  };
}

interface GhPullRequestDetail {
  number?: number;
  comments?: { totalCount?: number };
  files?: GhConnection<GhChangedFile>;
  reviewThreads?: GhConnection<GhReviewThread>;
}

interface GhFilesPageResponse {
  data?: {
    repository?: {
      pullRequest?: {
        files?: GhConnection<GhChangedFile>;
      };
    };
  };
}

interface GhReviewThreadsPageResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: GhConnection<GhReviewThread>;
      };
    };
  };
}

interface GhConnection<T> {
  totalCount?: number;
  nodes?: T[];
  pageInfo?: GhPageInfo;
}

interface GhChangedFile {
  path?: string;
  additions?: number;
  deletions?: number;
  changeType?: string;
}

interface GhReviewThread {
  path?: string;
  comments?: { totalCount?: number };
}

interface GhPageInfo {
  hasNextPage?: boolean;
  endCursor?: string;
}

/**
 * PR 하나의 changed files 와 파일별 review comment 수를 읽는다.
 * @param cwd        gh 를 실행할 저장소 루트
 * @param repository owner/name 형태의 GitHub 저장소 이름
 * @param number     조회할 PR 번호
 * @returns drawer 에 표시할 PR 상세 데이터
 */
export async function fetchPullRequestDetail(
  cwd: string,
  repository: string,
  number: number
): Promise<PullRequestDetailInfo> {
  const [owner, name] = splitRepositoryName(repository);
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
    `query=${PULL_REQUEST_DETAIL_QUERY}`,
  ], cwd);
  const parsed = JSON.parse(out) as GhPullRequestDetailResponse;
  const pr = parsed.data?.repository?.pullRequest;
  if (!pr) {
    throw new Error(`Pull request #${number} is not available.`);
  }

  const files = [...(pr.files?.nodes || [])];
  const threads = [...(pr.reviewThreads?.nodes || [])];
  const fileState = await appendRemainingFiles(cwd, owner, name, number, pr.files?.pageInfo, files);
  const threadState = await appendRemainingReviewThreads(cwd, owner, name, number, pr.reviewThreads?.pageInfo, threads);
  const fileCommentCounts = reviewCommentCountsByPath(threads);
  const normalizedFiles = normalizeFiles(files, fileCommentCounts);
  const fileCommentCount = Array.from(fileCommentCounts.values()).reduce((sum, count) => sum + count, 0);
  return {
    number: pr.number || number,
    commentCount: (pr.comments?.totalCount ?? 0) + fileCommentCount,
    fileCommentCount,
    fileCount: pr.files?.totalCount ?? normalizedFiles.length,
    files: normalizedFiles,
    filesTruncated: fileState.truncated,
    reviewThreadsTruncated: threadState.truncated,
  };
}

/**
 * 첫 페이지 뒤에 남은 changed files 를 이어서 읽는다.
 * @param cwd      gh 실행 경로
 * @param owner    GitHub owner
 * @param name     GitHub repository name
 * @param number   PR 번호
 * @param pageInfo 첫 페이지 pageInfo
 * @param files    결과를 누적할 배열
 * @returns 상한 때문에 잘렸는지 여부
 */
async function appendRemainingFiles(
  cwd: string,
  owner: string,
  name: string,
  number: number,
  pageInfo: GhPageInfo | undefined,
  files: GhChangedFile[]
): Promise<{ truncated: boolean }> {
  let pages = 1;
  while (pageInfo?.hasNextPage && pageInfo.endCursor && pages < MAX_DETAIL_PAGES) {
    const page = await readFilesPage(cwd, owner, name, number, pageInfo.endCursor);
    files.push(...(page.nodes || []));
    pageInfo = page.pageInfo;
    pages++;
  }
  return { truncated: Boolean(pageInfo?.hasNextPage) };
}

/**
 * 첫 페이지 뒤에 남은 review thread 를 이어서 읽는다.
 * @param cwd      gh 실행 경로
 * @param owner    GitHub owner
 * @param name     GitHub repository name
 * @param number   PR 번호
 * @param pageInfo 첫 페이지 pageInfo
 * @param threads  결과를 누적할 배열
 * @returns 상한 때문에 잘렸는지 여부
 */
async function appendRemainingReviewThreads(
  cwd: string,
  owner: string,
  name: string,
  number: number,
  pageInfo: GhPageInfo | undefined,
  threads: GhReviewThread[]
): Promise<{ truncated: boolean }> {
  let pages = 1;
  while (pageInfo?.hasNextPage && pageInfo.endCursor && pages < MAX_DETAIL_PAGES) {
    const page = await readReviewThreadsPage(cwd, owner, name, number, pageInfo.endCursor);
    threads.push(...(page.nodes || []));
    pageInfo = page.pageInfo;
    pages++;
  }
  return { truncated: Boolean(pageInfo?.hasNextPage) };
}

/** PR changed files 한 페이지를 읽는다. */
async function readFilesPage(
  cwd: string,
  owner: string,
  name: string,
  number: number,
  cursor: string
): Promise<GhConnection<GhChangedFile>> {
  const out = await runGh(graphQlArgs(owner, name, number, cursor, PULL_REQUEST_FILES_QUERY), cwd);
  const parsed = JSON.parse(out) as GhFilesPageResponse;
  return parsed.data?.repository?.pullRequest?.files || {};
}

/** PR review threads 한 페이지를 읽는다. */
async function readReviewThreadsPage(
  cwd: string,
  owner: string,
  name: string,
  number: number,
  cursor: string
): Promise<GhConnection<GhReviewThread>> {
  const out = await runGh(graphQlArgs(owner, name, number, cursor, PULL_REQUEST_REVIEW_THREADS_QUERY), cwd);
  const parsed = JSON.parse(out) as GhReviewThreadsPageResponse;
  return parsed.data?.repository?.pullRequest?.reviewThreads || {};
}

/** gh api graphql 공통 인자를 만든다. */
function graphQlArgs(owner: string, name: string, number: number, cursor: string, query: string): string[] {
  return ["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`, "-f", `cursor=${cursor}`, "-f", `query=${query}`];
}

/** review thread 들을 파일 경로별 comment 총합으로 접는다. */
function reviewCommentCountsByPath(threads: GhReviewThread[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    const path = thread.path || "";
    if (!path) {
      continue;
    }
    counts.set(path, (counts.get(path) || 0) + reviewThreadCommentCount([thread]));
  }
  return counts;
}

/** GitHub changed file JSON 을 drawer 파일 트리 타입으로 정규화한다. */
function normalizeFiles(files: GhChangedFile[], commentCounts: Map<string, number>): PullRequestChangedFileInfo[] {
  return files.map((file) => ({
    status: changeTypeToStatus(file.changeType),
    path: file.path || "",
    additions: file.additions || 0,
    deletions: file.deletions || 0,
    commentCount: commentCounts.get(file.path || "") || 0,
  })).filter((file) => Boolean(file.path));
}

/** GitHub PatchStatus 값을 git name-status 문자로 바꾼다. */
function changeTypeToStatus(changeType: string | undefined): FileChangeStatus {
  switch (changeType) {
    case "ADDED":
      return "A";
    case "DELETED":
      return "D";
    case "RENAMED":
      return "R";
    case "COPIED":
      return "C";
    case "TYPE_CHANGED":
      return "T";
    default:
      return "M";
  }
}
