// 현재 브랜치의 GitHub PR inline review comment 를 읽는 서비스.
// - provider/UI 계층이 gh CLI, repository 식별, REST pagination 을 직접 알지 않도록 분리한다.
import { readGitHubInteractive } from "./githubReadCache";
import type { GhExecute } from "./ghRunner";
import { runGit } from "./gitExec";
import { findPullRequestsForBranches } from "./pullRequestBranchLookup";
import { resolveCurrentPullRequestSelector } from "./pullRequestBranchSelector";
import { createGitHubReadSession, completeGitHubReadSession, gitHubReadSessionState, GitHubReadContextChangedError } from "./githubReadSession";
import { readSessionRepository, readSessionRestApiBase } from "./githubRestSession";
import { restRead } from "./githubReadRequest";
import { decodeRestPage, nextRestPage, GitHubRestPageError } from "./githubRestPages";
import { logInfo } from "../ui/outputLog";
import { splitRepositoryName } from "./githubRepository";
import { inheritReplyCommentLocations } from "./pullRequestCommentLocations";
import {
  PullRequestSuggestedChangesetOptions,
  PullRequestSuggestedChangesetRead,
  PullRequestSuggestedChangesetStatus,
  readPullRequestSuggestedChangesets,
} from "./pullRequestSuggestedChangesets";

/** 활성 브랜치에 연결된 PR 과 그 inline review comment 목록 */
export interface ActivePullRequestReviewComments {
  /** PR 번호 */
  number: number;
  /** PR 제목 */
  title: string;
  /** GitHub PR URL */
  url?: string;
  /** PR head branch 이름 */
  headRefName: string;
  /** PR 에 달린 파일별 inline review comment 목록 */
  comments: PullRequestReviewComment[];
  /** GitHub 웹 HTML 에서 suggested changeset 을 보조 조회한 상태 */
  suggestedChangesetStatus?: PullRequestSuggestedChangesetStatus;
}

/** 에디터 라인에 표시할 GitHub inline review comment */
export interface PullRequestReviewComment {
  /** GitHub review comment id */
  id: string;
  /** 답글이면 부모 review comment id */
  parentId?: string;
  /** 댓글 작성자 login */
  author: string;
  /** GitHub markdown 본문 */
  body: string;
  /** GitHub plain text 본문. raw body 가 비어 있을 때 fallback 으로 사용한다. */
  bodyText?: string;
  /** GitHub 렌더링 HTML 본문. raw body 에 없는 suggested changeset fallback 에 사용한다. */
  bodyHtml?: string;
  /** GitHub PR files 웹 HTML 에서 읽은 apply 가능한 suggested changeset 코드 */
  suggestedChangesets?: string[];
  /** GitHub review comment 가 달린 diff hunk */
  diffHunk?: string;
  /** 저장소 루트 기준 파일 경로 */
  path: string;
  /** 현재 diff 오른쪽 라인 번호 */
  line?: number;
  /** 현재 diff 오른쪽 시작 라인 번호 */
  startLine?: number;
  /** 원본 diff 왼쪽 라인 번호 */
  originalLine?: number;
  /** 원본 diff 왼쪽 시작 라인 번호 */
  originalStartLine?: number;
  /** GitHub diff side 값 */
  side?: string;
  /** GitHub diff start_side 값 */
  startSide?: string;
  /** 댓글 생성 시각 */
  createdAt?: string;
  /** GitHub 댓글 URL */
  url?: string;
}

interface GhPullRequestView {
  number?: number;
  title?: string;
  url?: string;
  headRefName?: string;
}


interface GhReviewComment {
  id?: number | string;
  in_reply_to_id?: number | string | null;
  body?: string;
  body_text?: string;
  body_html?: string;
  diff_hunk?: string;
  path?: string;
  line?: number | null;
  start_line?: number | null;
  original_line?: number | null;
  original_start_line?: number | null;
  side?: string;
  start_side?: string;
  created_at?: string;
  html_url?: string;
  user?: { login?: string };
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** PR comment 조회에 사용할 선택 인증 정보 */
export interface PullRequestReviewCommentServiceOptions {
  /** suggested changeset 웹 HTML 을 읽기 위한 VS Code GitHub OAuth token */
  suggestedChangeset?: PullRequestSuggestedChangesetOptions;
  /** API 댓글이 준비되면 HTML 보완 전에 표시하는 선택적 callback. 예외는 조회를 실패시키지 않는다. */
  onApiReady?: (data: ActivePullRequestReviewComments) => void;
  /** 활성 에디터 교체 시 gh/웹 보조 조회를 중단할 신호 */
  signal?: AbortSignal;
}

/**
 * 현재 checkout 된 브랜치의 GitHub PR review comment 를 조회한다.
 * - gh CLI 실행과 GitHub REST pagination 을 한곳에 모아, 에디터 표시 로직과 분리한다.
 */
export class PullRequestReviewCommentService {
  constructor(
    private readonly repoRoot: string,
    private readonly options: PullRequestReviewCommentServiceOptions = {},
    private readonly execute: GhExecute = readGitHubInteractive
  ) {}

  /**
   * 현재 브랜치 이름을 읽는다.
   * - detached HEAD 에서는 PR 을 branch 기준으로 찾을 수 없으므로 undefined 를 반환한다.
   * @returns 현재 브랜치 이름 또는 undefined
   */
  async getCurrentBranch(): Promise<string | undefined> {
    const branch = (await runGit(["branch", "--show-current"], this.repoRoot, { signal: this.options.signal })).trim();
    return branch || undefined;
  }

  /**
   * 현재 브랜치의 PR 과 inline review comment 를 읽는다.
   * @param branch 이미 알고 있는 현재 브랜치 이름. 생략하면 git 에서 다시 읽는다.
   * @returns PR 이 없으면 undefined, 있으면 PR metadata 와 comment 목록
   */
  async getActiveBranchReviewComments(
    branch?: string
  ): Promise<ActivePullRequestReviewComments | undefined> {
    const started = Date.now();
    throwIfAborted(this.options.signal);
    const currentBranch = branch || await this.getCurrentBranch();
    if (!currentBranch) {
      return undefined;
    }
    const read = createGitHubReadSession(this.repoRoot, this.execute);
    const pr = await this.readCurrentPullRequest(currentBranch, read);
    throwIfAborted(this.options.signal);
    if (!pr?.number) {
      await completeGitHubReadSession(read, this.options.signal);
      return undefined;
    }
    const repository = await this.repositoryName(read);
    throwIfAborted(this.options.signal);
    const [owner, name] = splitRepositoryName(repository);
    const comments = await this.readReviewComments(owner, name, Number(pr.number), read);
    const core: ActivePullRequestReviewComments = {
      number: Number(pr.number), title: pr.title || "", url: pr.url,
      headRefName: pr.headRefName || currentBranch, comments,
    };
    await this.assertCurrentBranch(currentBranch);
    await completeGitHubReadSession(read, this.options.signal, false);
    try { this.options.onApiReady?.({ ...core, comments: comments.map(comment => ({ ...comment })) }); }
    catch { logInfo("pr editor comments API-ready callback skipped", { reason: "callback-failed" }); }
    logInfo("pr editor comments API ready", { comments: comments.length, pr: core.number, firstReadyMs: Date.now() - started });
    let suggested = skippedSuggestedChangesets();
    if (comments.length) {
      try {
        suggested = await readPullRequestSuggestedChangesets(this.repoRoot, owner, name, core.number,
          { ...this.options.suggestedChangeset, signal: this.options.signal }, comments.map(comment => ({ id: comment.id, url: comment.url })));
      } catch {
        throwIfAborted(this.options.signal);
        suggested = { byCommentId: new Map(), status: { attempted: true, comments: 0, changesets: 0, reason: "web HTML enrichment failed or timed out" } };
      }
    }
    await this.assertCurrentBranch(currentBranch);
    await completeGitHubReadSession(read, this.options.signal);
    logInfo("pr editor comments enrichment complete", { comments: comments.length, totalMs: Date.now() - started });
    return { ...core, comments: attachSuggestedChangesets(comments, suggested.byCommentId), suggestedChangesetStatus: suggested.status };
  }

  /** 현재 branch의 native push/upstream 선택을 같은 typed session의 PR query로 읽는다. */
  private async readCurrentPullRequest(branch: string, read: GhExecute): Promise<GhPullRequestView | undefined> {
    const env = Object.fromEntries(Object.entries(gitHubReadSessionState(read)?.env ?? process.env)
      .filter((pair): pair is [string, string] => pair[1] !== undefined));
    const selector = await resolveCurrentPullRequestSelector(this.repoRoot, branch, this.options.signal, runGit, env);
    return (await findPullRequestsForBranches(this.repoRoot, [selector], { signal: this.options.signal }, read)).get(branch);
  }

  /** 같은 bootstrap 응답의 canonical owner/name만 사용해 별도 repo view와 CLI 고정을 피한다. */
  private async repositoryName(read: GhExecute): Promise<string> { return readSessionRepository(read).name; }

  /** checkout 중 늦은 API/HTML 결과가 이전 branch snapshot으로 게시되지 못하게 한다. */
  private async assertCurrentBranch(expected: string): Promise<void> {
    throwIfAborted(this.options.signal);
    if (await this.getCurrentBranch() !== expected) throw new GitHubReadContextChangedError();
  }

  /**
   * PR inline review comment 를 페이지 단위로 읽는다.
   * @param owner GitHub owner
   * @param name repository 이름
   * @param number PR 번호
   * @returns 정규화된 review comment 목록
   */
  private async readReviewComments(
    owner: string,
    name: string,
    number: number,
    read: GhExecute,
    apiBase: string = readSessionRestApiBase(read)
  ): Promise<PullRequestReviewComment[]> {
    const all: PullRequestReviewComment[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const path = `/repos/${owner}/${name}/pulls/${number}/comments?per_page=${PAGE_SIZE}&page=${page}`;
      const accept = "application/vnd.github-commitcomment.full+json";
      const request = restRead(path, accept, ["api", "-H", `Accept: ${accept}`, path.slice(1)]);
      const out = await read(request.args, this.repoRoot, { signal: this.options.signal, operation: "pr-review-comments",
        request: { ...request.request, responseMode: "page" } });
      throwIfAborted(this.options.signal);
      const result = decodeRestPage<GhReviewComment[]>(out);
      if (!Array.isArray(result.data)) throw new GitHubRestPageError("invalid-json");
      all.push(...result.data.map(normalizeReviewComment).filter(isReviewComment));
      if (nextRestPage(result, path, page, PAGE_SIZE, apiBase) === undefined) break;
      if (page === MAX_PAGES) throw new GitHubRestPageError("pagination");
    }
    return inheritReplyCommentLocations(all);
  }
}

/** review comment가 없을 때 GitHub 웹 HTML 보조 조회를 생략한 상태를 만든다. */
function skippedSuggestedChangesets(): PullRequestSuggestedChangesetRead {
  return {
    byCommentId: new Map(),
    status: { attempted: false, comments: 0, changesets: 0, reason: "no review comments" },
  };
}

/** 취소된 활성 에디터 요청이 후속 gh/웹 작업을 시작하지 못하게 한다. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("PR review comment request was cancelled.", "AbortError");
  }
}

/**
 * GitHub REST review comment 응답을 에디터 표시용 타입으로 바꾼다.
 * @param comment GitHub REST 응답 comment
 * @returns 필수 path 가 있으면 정규화된 comment, 아니면 undefined
 */
function normalizeReviewComment(
  comment: GhReviewComment
): PullRequestReviewComment | undefined {
  const path = comment.path?.trim();
  if (!path) {
    return undefined;
  }
  return {
    id: String(comment.id || `${path}:${comment.created_at || ""}:${comment.body || ""}`),
    parentId: comment.in_reply_to_id ? String(comment.in_reply_to_id) : undefined,
    author: comment.user?.login || "unknown",
    body: comment.body || comment.body_text || "",
    bodyText: comment.body_text || undefined,
    bodyHtml: comment.body_html || undefined,
    diffHunk: comment.diff_hunk || undefined,
    path,
    line: normalizeLine(comment.line),
    startLine: normalizeLine(comment.start_line),
    originalLine: normalizeLine(comment.original_line),
    originalStartLine: normalizeLine(comment.original_start_line),
    side: comment.side,
    startSide: comment.start_side,
    createdAt: comment.created_at,
    url: comment.html_url,
  };
}

/** 숫자 line 값만 1-base 라인 번호로 인정한다. */
function normalizeLine(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** filter(Boolean) 이 타입을 좁히도록 돕는다. */
function isReviewComment(
  comment: PullRequestReviewComment | undefined
): comment is PullRequestReviewComment {
  return Boolean(comment);
}

/**
 * 웹 HTML 에서 읽은 suggested changeset 을 REST comment 에 병합한다.
 * @param comments REST API 로 읽은 review comment 목록
 * @param byCommentId comment id 별 suggested changeset 코드
 * @returns suggested changeset 이 붙은 comment 목록
 */
function attachSuggestedChangesets(
  comments: PullRequestReviewComment[],
  byCommentId: Map<string, string[]>
): PullRequestReviewComment[] {
  if (!byCommentId.size) {
    return comments;
  }
  return comments.map((comment) => {
    const suggestedChangesets = byCommentId.get(comment.id);
    return suggestedChangesets?.length
      ? { ...comment, suggestedChangesets }
      : comment;
  });
}
