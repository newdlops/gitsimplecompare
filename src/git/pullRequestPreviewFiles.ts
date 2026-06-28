// PR preview 의 Files changed 탭에 필요한 patch/comment 데이터를 읽는 모듈.
// - 기존 drawer 상세는 가벼운 파일 트리에 집중하고, preview 는 GitHub PR처럼 diff snippet 과 review comment 를 함께 보여준다.
import { CommitFileChange } from "../graph/graphTypes";
import { runGh } from "./ghCli";
import { FileChangeStatus } from "./gitTypes";
import { splitRepositoryName } from "./githubRepository";
import { inheritReplyCommentLocations } from "./pullRequestCommentLocations";

/** Files changed 탭에서 review comment 본문과 위치를 표시하기 위한 데이터 */
export interface PullRequestPreviewComment {
  id?: number;
  parentId?: string;
  author: string;
  body: string;
  bodyText?: string;
  bodyHtml?: string;
  diffHunk: string;
  line?: number;
  startLine?: number;
  originalLine?: number;
  originalStartLine?: number;
  side?: string;
  startSide?: string;
  createdAt?: string;
  url?: string;
}

/** Files changed 탭의 파일별 patch snippet 과 review comment 묶음 */
export interface PullRequestPreviewFile extends CommitFileChange {
  patch?: string;
  comments: PullRequestPreviewComment[];
}

interface GhPullFile {
  filename?: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

interface GhReviewComment {
  id?: number;
  in_reply_to_id?: number | string | null;
  path?: string;
  body?: string;
  body_text?: string;
  body_html?: string;
  diff_hunk?: string;
  line?: number;
  start_line?: number;
  original_line?: number;
  original_start_line?: number;
  side?: string;
  start_side?: string;
  created_at?: string;
  html_url?: string;
  user?: { login?: string };
}

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/**
 * GitHub PR 의 파일 patch 와 review comment 를 함께 읽는다.
 * @param cwd gh 를 실행할 저장소 루트
 * @param repository owner/name 형태의 GitHub 저장소 이름
 * @param number PR 번호
 * @returns 파일별 patch/comment preview 데이터
 */
export async function fetchPullRequestPreviewFiles(
  cwd: string,
  repository: string,
  number: number
): Promise<PullRequestPreviewFile[]> {
  const [owner, name] = splitRepositoryName(repository);
  const [files, comments] = await Promise.all([
    readPullFiles(cwd, owner, name, number),
    readReviewComments(cwd, owner, name, number),
  ]);
  const commentsByPath = groupCommentsByPath(comments);
  return files.map((file) => normalizeFile(file, commentsByPath));
}

/**
 * PR changed files REST API 를 페이지 단위로 모두 읽는다.
 * @param cwd gh 실행 경로
 * @param owner GitHub owner
 * @param name GitHub repository 이름
 * @param number PR 번호
 * @returns GitHub changed file 배열
 */
async function readPullFiles(
  cwd: string,
  owner: string,
  name: string,
  number: number
): Promise<GhPullFile[]> {
  return readPaged<GhPullFile>(cwd, owner, name, `pulls/${number}/files`);
}

/**
 * PR review comment REST API 를 페이지 단위로 모두 읽는다.
 * @param cwd gh 실행 경로
 * @param owner GitHub owner
 * @param name GitHub repository 이름
 * @param number PR 번호
 * @returns GitHub review comment 배열
 */
async function readReviewComments(
  cwd: string,
  owner: string,
  name: string,
  number: number
): Promise<GhReviewComment[]> {
  return readPaged<GhReviewComment>(
    cwd,
    owner,
    name,
    `pulls/${number}/comments`,
    ["Accept: application/vnd.github-commitcomment.full+json"]
  );
}

/**
 * gh api REST 배열 응답을 페이지네이션으로 읽는다.
 * @param cwd gh 실행 경로
 * @param owner GitHub owner
 * @param name GitHub repository 이름
 * @param route repository 하위 API route
 * @returns 누적된 REST 배열 응답
 */
async function readPaged<T>(
  cwd: string,
  owner: string,
  name: string,
  route: string,
  headers: string[] = []
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const out = await runGh([
      "api",
      ...headers.flatMap((header) => ["-H", header]),
      `repos/${owner}/${name}/${route}?per_page=${PAGE_SIZE}&page=${page}`,
    ], cwd);
    const items = JSON.parse(out) as T[];
    all.push(...items);
    if (items.length < PAGE_SIZE) {
      break;
    }
  }
  return all;
}

/**
 * review comment 를 파일 경로별로 묶는다.
 * @param comments GitHub review comment 배열
 * @returns path → comment 배열 맵
 */
function groupCommentsByPath(
  comments: GhReviewComment[]
): Map<string, PullRequestPreviewComment[]> {
  const byPath = new Map<string, PullRequestPreviewComment[]>();
  for (const comment of comments) {
    if (!comment.path) {
      continue;
    }
    const list = byPath.get(comment.path) || [];
    list.push(normalizeComment(comment));
    byPath.set(comment.path, list);
  }
  for (const [path, list] of byPath) {
    byPath.set(path, inheritReplyCommentLocations(list));
  }
  return byPath;
}

/**
 * GitHub changed file 을 preview 표시용 파일 데이터로 변환한다.
 * @param file GitHub REST changed file
 * @param commentsByPath 파일별 review comment 맵
 * @returns preview file 데이터
 */
function normalizeFile(
  file: GhPullFile,
  commentsByPath: Map<string, PullRequestPreviewComment[]>
): PullRequestPreviewFile {
  const path = file.filename || "";
  return {
    status: normalizePreviewStatus(file.status),
    path,
    oldPath: file.previous_filename,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    patch: file.patch,
    comments: commentsByPath.get(path) || [],
  };
}

/**
 * GitHub review comment 를 preview 표시용 데이터로 변환한다.
 * @param comment GitHub REST review comment
 * @returns preview comment 데이터
 */
function normalizeComment(comment: GhReviewComment): PullRequestPreviewComment {
  return {
    id: comment.id,
    parentId: comment.in_reply_to_id ? String(comment.in_reply_to_id) : undefined,
    author: comment.user?.login || "unknown",
    body: comment.body || comment.body_text || "",
    bodyText: comment.body_text || undefined,
    bodyHtml: comment.body_html || undefined,
    diffHunk: comment.diff_hunk || "",
    line: comment.line,
    startLine: comment.start_line,
    originalLine: comment.original_line,
    originalStartLine: comment.original_start_line,
    side: comment.side,
    startSide: comment.start_side,
    createdAt: comment.created_at,
    url: comment.html_url,
  };
}

/**
 * GitHub REST file status 값을 git name-status 문자로 바꾼다.
 * @param status GitHub changed file status
 * @returns CommitFileChange.status 값
 */
export function normalizePreviewStatus(status: string | undefined): FileChangeStatus {
  switch (status) {
    case "added":
      return "A";
    case "removed":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    default:
      return "M";
  }
}
