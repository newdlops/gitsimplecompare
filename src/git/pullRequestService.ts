// GitHub Pull Request POC 데이터를 읽는 서비스.
// - git graph UI 가 gh CLI/remote URL/스테이징 diff 해석을 직접 알지 않도록 분리한다.
import { execFile } from "node:child_process";
import { CommitFileChange, LocalBranchStatus } from "../graph/graphTypes";
import { parseNameStatusZ, parseNumstat } from "./diffParse";
import { runGit } from "./gitExec";

/** 그래프에 한 번에 표시할 열린 PR 최대 개수 */
const PULL_REQUEST_LIMIT = 80;

/** PR 목록 GraphQL 쿼리. gh pr list 의 commits 필드가 과도한 author 연결을 펴지 않도록 필요한 값만 직접 요청한다. */
const PULL_REQUESTS_QUERY = `
query($owner: String!, $name: String!, $limit: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $limit, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        state
        url
        headRefName
        headRefOid
        baseRefName
        author { login }
        isDraft
        reviewDecision
        updatedAt
        comments(last: 3) {
          totalCount
          nodes {
            author { login }
            body
            url
            createdAt
          }
        }
        commits(first: 100) {
          nodes {
            commit { oid }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
}`;

/** PR 하나의 추가 commit OID 페이지를 읽는 GraphQL 쿼리 */
const PULL_REQUEST_COMMITS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: 100, after: $cursor) {
        nodes {
          commit { oid }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

/** PR 댓글 요약 */
export interface PullRequestCommentInfo {
  author: string;
  body: string;
  url?: string;
  createdAt?: string;
}

/** graph 에 표시할 Pull Request 한 건 */
export interface PullRequestInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  headRefName: string;
  headHash?: string;
  baseRefName: string;
  author: string;
  isDraft: boolean;
  reviewDecision?: string;
  updatedAt?: string;
  commentCount: number;
  comments: PullRequestCommentInfo[];
  commitHashes: string[];
}

/** graph 웹뷰에 보내는 PR 전체 상태 */
export interface PullRequestOverview {
  available: boolean;
  repository?: string;
  currentBranch?: string;
  targetBranch?: string;
  error?: string;
  pullRequests: PullRequestInfo[];
}

/** staged 상태로 PR 을 만들 때의 모의 내용 */
export interface StagedPullRequestPreview {
  repository?: string;
  currentBranch: string;
  targetBranch: string;
  title: string;
  body: string;
  files: CommitFileChange[];
  commits: string[];
  stat: string;
  hasStagedChanges: boolean;
  existingPr?: PullRequestInfo;
}

interface GhPullRequest {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  author?: { login?: string };
  isDraft?: boolean;
  reviewDecision?: string;
  updatedAt?: string;
  comments?: GhComment[];
  commits?: GhCommit[];
  commentCount?: number;
  commitHashes?: string[];
}

interface GhCommit {
  oid?: string;
}

interface GhGraphQlResponse {
  data?: {
    repository?: {
      pullRequests?: {
        nodes?: GhGraphQlPullRequest[];
      };
    };
  };
}

interface GhGraphQlPullRequest {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  author?: { login?: string };
  isDraft?: boolean;
  reviewDecision?: string;
  updatedAt?: string;
  comments?: {
    totalCount?: number;
    nodes?: GhComment[];
  };
  commits?: {
    nodes?: Array<{ commit?: { oid?: string } }>;
    pageInfo?: GhPageInfo;
  };
}

interface GhPageInfo {
  hasNextPage?: boolean;
  endCursor?: string;
}

interface GhCommitPageResponse {
  data?: {
    repository?: {
      pullRequest?: {
        commits?: {
          nodes?: Array<{ commit?: { oid?: string } }>;
          pageInfo?: GhPageInfo;
        };
      };
    };
  };
}

interface GhComment {
  author?: { login?: string };
  body?: string;
  url?: string;
  createdAt?: string;
}

/** 저장소 한 개의 GitHub PR POC 조회 서비스 */
export class PullRequestService {
  constructor(public readonly repoRoot: string) {}

  /**
   * gh CLI 로 저장소 PR 목록을 읽고, graph 배지용 PR commit 해시들을 붙인다.
   * @param localBranches 현재 로컬 브랜치 상태. current branch/target 추정에 사용한다.
   */
  async getOverview(
    localBranches: LocalBranchStatus[]
  ): Promise<PullRequestOverview> {
    try {
      const repository = await this.repositoryName();
      const rawPrs = await this.listPullRequests(repository);
      const prs = rawPrs.map((pr) => this.toPullRequestInfo(pr));
      const current = localBranches.find((branch) => branch.current);
      return {
        available: true,
        repository,
        currentBranch: current?.name,
        targetBranch: this.targetBranchFor(current, prs),
        pullRequests: prs,
      };
    } catch (error) {
      return {
        available: false,
        currentBranch: localBranches.find((branch) => branch.current)?.name,
        error: error instanceof Error ? error.message : String(error),
        pullRequests: [],
      };
    }
  }

  /**
   * 현재 staged 상태를 target branch 로 PR 한다고 가정한 모의 내용을 만든다.
   * @param baseBranch 명시 target branch. 없으면 현재 PR/base/upstream/main 순서로 추정한다.
   * @param existingPr 기존 PR 이 있으면 제목/본문 힌트에 포함한다.
   */
  async getStagedPreview(
    baseBranch?: string,
    existingPr?: PullRequestInfo
  ): Promise<StagedPullRequestPreview> {
    const currentBranch = await this.currentBranch();
    const targetBranch = baseBranch || existingPr?.baseRefName || await this.defaultBaseBranch();
    const [files, stat, commits, repository] = await Promise.all([
      this.stagedFiles(),
      runGit(["diff", "--cached", "--stat"], this.repoRoot).catch(() => ""),
      this.previewCommits(targetBranch),
      this.repositoryName().catch(() => undefined),
    ]);
    return {
      repository,
      currentBranch,
      targetBranch,
      title: existingPr?.title || `${currentBranch} -> ${targetBranch}`,
      body: previewBody(files, commits, stat),
      files,
      commits,
      stat: stat.trim(),
      hasStagedChanges: files.length > 0,
      existingPr,
    };
  }

  /**
   * 열린 PR 목록을 GitHub GraphQL 로 가볍게 조회한다.
   * - `gh pr list --json commits` 는 commit author 연결까지 크게 펼쳐 GraphQL 한도를 넘을 수 있어 사용하지 않는다.
   * @param repository owner/name 형태의 GitHub 저장소 이름
   */
  private async listPullRequests(repository: string): Promise<GhPullRequest[]> {
    const [owner, name] = splitRepositoryName(repository);
    const out = await runGh([
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `limit=${PULL_REQUEST_LIMIT}`,
      "-f",
      `query=${PULL_REQUESTS_QUERY}`,
    ], this.repoRoot);
    const parsed = JSON.parse(out) as GhGraphQlResponse;
    const nodes = parsed.data?.repository?.pullRequests?.nodes || [];
    const prs = nodes.map(fromGraphQlPullRequest);
    await this.appendRemainingCommitHashes(owner, name, nodes, prs);
    return prs;
  }

  /** gh PR JSON 을 graph 표시용 타입으로 정규화한다. */
  private toPullRequestInfo(pr: GhPullRequest): PullRequestInfo {
    return {
      number: Number(pr.number) || 0,
      title: pr.title || "",
      state: pr.state || "",
      url: pr.url || "",
      headRefName: pr.headRefName || "",
      headHash: pr.headRefOid,
      baseRefName: pr.baseRefName || "",
      author: pr.author?.login || "",
      isDraft: Boolean(pr.isDraft),
      reviewDecision: pr.reviewDecision,
      updatedAt: pr.updatedAt,
      commentCount: pr.commentCount ?? pr.comments?.length ?? 0,
      comments: normalizeComments(pr.comments),
      commitHashes: normalizeCommitHashes(pr),
    };
  }

  /**
   * 첫 GraphQL 페이지에 담기지 않은 PR commit OID 를 이어 붙인다.
   * - 대부분의 PR 은 100개 이하라 추가 호출이 없고, 큰 PR 만 순차적으로 더 읽는다.
   * @param owner GitHub owner
   * @param name  GitHub repository name
   * @param nodes 첫 PR 목록 GraphQL node 배열
   * @param prs   내부 PR 데이터 배열(nodes 와 같은 순서)
   */
  private async appendRemainingCommitHashes(
    owner: string,
    name: string,
    nodes: GhGraphQlPullRequest[],
    prs: GhPullRequest[]
  ): Promise<void> {
    for (let index = 0; index < nodes.length; index++) {
      const prNumber = Number(nodes[index]?.number);
      if (!Number.isFinite(prNumber)) {
        continue;
      }
      let pageInfo = nodes[index]?.commits?.pageInfo;
      while (pageInfo?.hasNextPage && pageInfo.endCursor) {
        const page = await this.listCommitHashPage(owner, name, prNumber, pageInfo.endCursor);
        prs[index]?.commitHashes?.push(...page.hashes);
        pageInfo = page.pageInfo;
      }
    }
  }

  /**
   * PR 하나의 다음 commit OID 페이지를 읽는다.
   * @param owner  GitHub owner
   * @param name   GitHub repository name
   * @param number PR 번호
   * @param cursor 이전 commit page 의 endCursor
   */
  private async listCommitHashPage(
    owner: string,
    name: string,
    number: number,
    cursor: string
  ): Promise<{ hashes: string[]; pageInfo?: GhPageInfo }> {
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
      `cursor=${cursor}`,
      "-f",
      `query=${PULL_REQUEST_COMMITS_QUERY}`,
    ], this.repoRoot);
    const parsed = JSON.parse(out) as GhCommitPageResponse;
    const commits = parsed.data?.repository?.pullRequest?.commits;
    return {
      hashes: (commits?.nodes || []).map((node) => node.commit?.oid || "").filter(Boolean),
      pageInfo: commits?.pageInfo,
    };
  }

  /** 후보 ref 중 실제 commit 으로 해석되는 첫 번째 값을 반환한다. */
  private async resolveCommit(candidates: string[]): Promise<string | undefined> {
    for (const ref of candidates) {
      const hash = await runGit(["rev-parse", "--verify", `${ref}^{commit}`], this.repoRoot)
        .then((out) => out.trim())
        .catch(() => "");
      if (hash) {
        return hash;
      }
    }
    return undefined;
  }

  /** staged diff 의 파일 목록과 증감 라인을 읽는다. */
  private async stagedFiles(): Promise<CommitFileChange[]> {
    const [nameStatus, numstat] = await Promise.all([
      runGit(["diff", "--cached", "--name-status", "-z"], this.repoRoot),
      runGit(["diff", "--cached", "--numstat"], this.repoRoot),
    ]);
    const stats = parseNumstat(numstat);
    return parseNameStatusZ(nameStatus).map((file) => {
      const stat = stats.get(file.path);
      return {
        status: file.status,
        path: file.path,
        oldPath: file.oldPath,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
      };
    });
  }

  /** target branch 이후 HEAD 까지의 커밋 제목을 모의 PR 본문에 넣기 위해 읽는다. */
  private async previewCommits(targetBranch: string): Promise<string[]> {
    const out = await runGit(
      ["log", "--oneline", `${targetBranch}..HEAD`],
      this.repoRoot
    ).catch(() => "");
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  /** 현재 branch 이름을 반환한다. detached 이면 HEAD 로 표시한다. */
  private async currentBranch(): Promise<string> {
    return (await runGit(["branch", "--show-current"], this.repoRoot).catch(() => "")).trim() || "HEAD";
  }

  /** 현재 branch upstream/base 를 기준으로 PR target branch 를 추정한다. */
  private async defaultBaseBranch(): Promise<string> {
    const upstream = (await runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      this.repoRoot
    ).catch(() => "")).trim();
    if (upstream) {
      return upstream.replace(/^[^/]+\//, "");
    }
    return await this.resolveCommit(["origin/main"]).then((hash) => hash ? "origin/main" : "main");
  }

  /** gh repo view 로 owner/name 을 읽는다. */
  private async repositoryName(): Promise<string> {
    const out = await runGh(["repo", "view", "--json", "nameWithOwner"], this.repoRoot);
    const parsed = JSON.parse(out) as { nameWithOwner?: string };
    return parsed.nameWithOwner || "";
  }

  /** 현재 branch 의 PR 이 있으면 그 base 를 target 으로 우선 사용한다. */
  private targetBranchFor(
    current: LocalBranchStatus | undefined,
    prs: PullRequestInfo[]
  ): string | undefined {
    if (!current) {
      return prs[0]?.baseRefName;
    }
    return prs.find((pr) => pr.headRefName === current.name)?.baseRefName || current.upstream;
  }
}

/** gh CLI 를 실행하고 stdout 을 반환한다. */
function runGh(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`gh ${args.join(" ")} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * owner/name 형태의 저장소명을 GraphQL 변수로 나눈다.
 * @param repository gh repo view 가 반환한 nameWithOwner 문자열
 * @returns owner 와 repository name tuple
 */
function splitRepositoryName(repository: string): [string, string] {
  const [owner, name] = repository.split("/");
  if (!owner || !name) {
    throw new Error("GitHub repository name is not available.");
  }
  return [owner, name];
}

/**
 * 직접 작성한 GraphQL PR node 를 내부 PR JSON 형태로 변환한다.
 * @param pr GitHub GraphQL pull request node
 * @returns graph 표시용 정규화 전 PR 데이터
 */
function fromGraphQlPullRequest(pr: GhGraphQlPullRequest): GhPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    author: pr.author,
    isDraft: pr.isDraft,
    reviewDecision: pr.reviewDecision,
    updatedAt: pr.updatedAt,
    comments: pr.comments?.nodes || [],
    commentCount: pr.comments?.totalCount ?? pr.comments?.nodes?.length ?? 0,
    commitHashes: (pr.commits?.nodes || []).map((node) => node.commit?.oid || ""),
  };
}

/** gh 댓글 JSON 을 최신 3개 요약으로 줄인다. */
function normalizeComments(comments: GhComment[] | undefined): PullRequestCommentInfo[] {
  return (comments || []).slice(-3).map((comment) => ({
    author: comment.author?.login || "",
    body: comment.body || "",
    url: comment.url,
    createdAt: comment.createdAt,
  }));
}

/**
 * gh PR JSON 에 포함된 commit OID 목록을 graph 배지용 해시 목록으로 정규화한다.
 * - `commits` 필드가 비어 있거나 일부만 내려온 경우에도 headRefOid 를 fallback 으로 포함한다.
 * @param pr gh CLI 가 반환한 PR JSON
 * @returns 중복이 제거된 commit hash 배열
 */
function normalizeCommitHashes(pr: GhPullRequest): string[] {
  return Array.from(new Set([
    ...(pr.commitHashes || []),
    ...(pr.commits || []).map((commit) => commit.oid || ""),
    pr.headRefOid || "",
  ].filter(Boolean)));
}

/** staged PR preview 의 기본 본문을 만든다. */
function previewBody(
  files: CommitFileChange[],
  commits: string[],
  stat: string
): string {
  const lines = [
    "## Summary",
    files.length ? `- ${files.length} staged files included.` : "- No staged files yet.",
    commits.length ? `- ${commits.length} local commits are ahead of the target branch.` : "- No local commits detected against the target branch.",
    "",
    "## Staged files",
    ...files.slice(0, 20).map((file) => `- ${file.status} ${file.path} (+${file.additions}/-${file.deletions})`),
  ];
  if (files.length > 20) {
    lines.push(`- ...and ${files.length - 20} more files`);
  }
  if (stat.trim()) {
    lines.push("", "## Diff stat", "```", stat.trim(), "```");
  }
  return lines.join("\n");
}
