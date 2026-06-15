// GitHub Pull Request POC 데이터를 읽는 서비스.
// - git graph UI 가 gh CLI/remote URL/스테이징 diff 해석을 직접 알지 않도록 분리한다.
import { execFile } from "node:child_process";
import { CommitFileChange, LocalBranchStatus } from "../graph/graphTypes";
import { parseNameStatusZ, parseNumstat } from "./diffParse";
import { runGit } from "./gitExec";

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
   * gh CLI 로 저장소 PR 목록을 읽고, graph 배지용 head commit 해시를 붙인다.
   * @param localBranches 현재 로컬 브랜치 상태. current branch/target 추정에 사용한다.
   */
  async getOverview(
    localBranches: LocalBranchStatus[]
  ): Promise<PullRequestOverview> {
    try {
      const [repository, rawPrs] = await Promise.all([
        this.repositoryName(),
        this.listPullRequests(),
      ]);
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

  /** gh pr list 를 JSON 으로 호출한다. */
  private async listPullRequests(): Promise<GhPullRequest[]> {
    const out = await runGh([
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "80",
      "--json",
      "number,title,state,url,headRefName,headRefOid,baseRefName,author,isDraft,reviewDecision,updatedAt,comments",
    ], this.repoRoot);
    const parsed = JSON.parse(out) as unknown;
    return Array.isArray(parsed) ? parsed as GhPullRequest[] : [];
  }

  /** gh PR JSON 을 graph 표시용 타입으로 정규화한다. */
  private toPullRequestInfo(pr: GhPullRequest): PullRequestInfo {
    return {
      number: Number(pr.number) || 0,
      title: pr.title || "",
      state: pr.state || "",
      url: pr.url || "",
      headRefName: pr.headRefName || "",
      baseRefName: pr.baseRefName || "",
      author: pr.author?.login || "",
      isDraft: Boolean(pr.isDraft),
      reviewDecision: pr.reviewDecision,
      updatedAt: pr.updatedAt,
      commentCount: pr.comments?.length ?? 0,
      comments: normalizeComments(pr.comments),
      commitHashes: pr.headRefOid ? [pr.headRefOid] : [],
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

/** gh 댓글 JSON 을 최신 3개 요약으로 줄인다. */
function normalizeComments(comments: GhComment[] | undefined): PullRequestCommentInfo[] {
  return (comments || []).slice(-3).map((comment) => ({
    author: comment.author?.login || "",
    body: comment.body || "",
    url: comment.url,
    createdAt: comment.createdAt,
  }));
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
