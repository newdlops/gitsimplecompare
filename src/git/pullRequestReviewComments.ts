// 현재 브랜치의 GitHub PR inline review comment 를 읽는 서비스.
// - provider/UI 계층이 gh CLI, repository 식별, REST pagination 을 직접 알지 않도록 분리한다.
import { runGh } from "./ghCli";
import { runGit } from "./gitExec";
import { splitRepositoryName } from "./githubRepository";

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
}

/** 에디터 라인에 표시할 GitHub inline review comment */
export interface PullRequestReviewComment {
  /** GitHub review comment id */
  id: string;
  /** 댓글 작성자 login */
  author: string;
  /** GitHub markdown 본문 */
  body: string;
  /** 저장소 루트 기준 파일 경로 */
  path: string;
  /** 현재 diff 오른쪽 라인 번호 */
  line?: number;
  /** 원본 diff 왼쪽 라인 번호 */
  originalLine?: number;
  /** GitHub diff side 값 */
  side?: string;
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

interface GhRepositoryView {
  nameWithOwner?: string;
}

interface GhReviewComment {
  id?: number | string;
  body?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  side?: string;
  created_at?: string;
  html_url?: string;
  user?: { login?: string };
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * 현재 checkout 된 브랜치의 GitHub PR review comment 를 조회한다.
 * - gh CLI 실행과 GitHub REST pagination 을 한곳에 모아, 에디터 표시 로직과 분리한다.
 */
export class PullRequestReviewCommentService {
  constructor(private readonly repoRoot: string) {}

  /**
   * 현재 브랜치 이름을 읽는다.
   * - detached HEAD 에서는 PR 을 branch 기준으로 찾을 수 없으므로 undefined 를 반환한다.
   * @returns 현재 브랜치 이름 또는 undefined
   */
  async getCurrentBranch(): Promise<string | undefined> {
    const branch = (await runGit(["branch", "--show-current"], this.repoRoot)).trim();
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
    const currentBranch = branch || await this.getCurrentBranch();
    if (!currentBranch) {
      return undefined;
    }
    const pr = await this.readCurrentPullRequest();
    if (!pr?.number) {
      return undefined;
    }
    const repository = await this.repositoryName();
    const [owner, name] = splitRepositoryName(repository);
    const comments = await this.readReviewComments(owner, name, Number(pr.number));
    return {
      number: Number(pr.number),
      title: pr.title || "",
      url: pr.url,
      headRefName: pr.headRefName || currentBranch,
      comments,
    };
  }

  /**
   * gh 가 현재 브랜치에 연결된 PR 을 찾도록 한다.
   * - PR 이 없는 브랜치는 에디터 기능에서 정상적인 빈 상태이므로 undefined 로 처리한다.
   */
  private async readCurrentPullRequest(): Promise<GhPullRequestView | undefined> {
    try {
      const out = await runGh([
        "pr",
        "view",
        "--json",
        "number,title,url,headRefName",
      ], this.repoRoot);
      return JSON.parse(out) as GhPullRequestView;
    } catch (error) {
      if (isNoPullRequestError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * gh repo view 로 owner/name 저장소 식별자를 읽는다.
   * @returns GitHub REST route 에 사용할 owner/name 문자열
   */
  private async repositoryName(): Promise<string> {
    const out = await runGh(["repo", "view", "--json", "nameWithOwner"], this.repoRoot);
    const parsed = JSON.parse(out) as GhRepositoryView;
    if (!parsed.nameWithOwner) {
      throw new Error("GitHub repository name is not available.");
    }
    return parsed.nameWithOwner;
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
    number: number
  ): Promise<PullRequestReviewComment[]> {
    const all: PullRequestReviewComment[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const out = await runGh([
        "api",
        "-H",
        "Accept: application/vnd.github+json",
        `repos/${owner}/${name}/pulls/${number}/comments?per_page=${PAGE_SIZE}&page=${page}`,
      ], this.repoRoot);
      const items = JSON.parse(out) as GhReviewComment[];
      all.push(...items.map(normalizeReviewComment).filter(isReviewComment));
      if (items.length < PAGE_SIZE) {
        break;
      }
    }
    return all;
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
    author: comment.user?.login || "unknown",
    body: comment.body || "",
    path,
    line: normalizeLine(comment.line),
    originalLine: normalizeLine(comment.original_line),
    side: comment.side,
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

/** gh pr view 가 현재 브랜치의 PR 을 찾지 못한 오류인지 확인한다. */
function isNoPullRequestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no pull requests? found|could not find.*pull request|not found.*pull request/i.test(message);
}
