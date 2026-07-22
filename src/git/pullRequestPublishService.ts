// 로컬 브랜치와 staged 변경을 GitHub Pull Request로 게시하는 서비스 모듈.
// - Preview/UI는 remote 선택과 사용자 확인만 담당하고 commit/push/gh 호출은 이 모듈에 위임한다.
// - 일반 PR 게시에서는 force push를 사용하지 않아 원격이 앞서거나 분기된 경우 Git이 안전하게 중단한다.
import { runGh } from "./ghCli";
import { runGit } from "./gitExec";
import type { PullRequestInfo } from "./pullRequestInfo";
import { resolvePreviewTargetRef } from "./pullRequestPreviewTarget";

/** 새 GitHub Pull Request를 만들 때 필요한 공통 입력이다. */
export interface CreatePullRequestOptions {
  /** GitHub에 게시된 source branch 이름 */
  headBranch: string;
  /** GitHub 저장소 안의 target branch 이름 */
  baseBranch: string;
  /** Pull Request 제목 */
  title: string;
  /** Pull Request 본문 */
  body: string;
  /** Draft Pull Request로 만들지 여부 */
  draft: boolean;
}

/** Preview 게시 대화상자에서 선택할 remote 한 건이다. */
export interface PullRequestPublishRemote {
  /** Git remote 이름 */
  name: string;
  /** 해당 remote에 만들 head branch 이름 */
  branch: string;
  /** upstream/origin 규칙으로 추천된 remote인지 여부 */
  recommended: boolean;
}

/** 실제 변경 전에 UI가 보여 줄 PR 게시 상태와 안전 조건이다. */
export interface PullRequestPublishContext {
  /** 게시할 로컬 source branch */
  sourceBranch: string;
  /** remote 접두사를 제거한 GitHub base branch */
  targetBranch: string;
  /** Preview가 실제 diff 기준으로 사용한 local/remote target ref */
  targetRef: string;
  /** 이 worktree에서 현재 checkout한 branch 또는 HEAD */
  currentBranch: string;
  /** source가 refs/heads 아래 실제 로컬 branch인지 여부 */
  sourceIsLocal: boolean;
  /** 게시 전에 commit해야 할 staged 파일 수 */
  stagedFileCount: number;
  /** commit 대상에 포함되지 않고 작업트리에 남을 unstaged 파일 수 */
  unstagedFileCount: number;
  /** source upstream을 반영한 remote 선택지 */
  remotes: PullRequestPublishRemote[];
}

/** Preview의 현재 제목/본문과 사용자의 게시 선택을 묶은 실행 옵션이다. */
export interface PublishPreviewPullRequestOptions {
  sourceBranch: string;
  targetBranch: string;
  remote: string;
  title: string;
  body: string;
  draft: boolean;
  /** staged 파일이 있을 때 만들 commit 메시지. staged 파일이 없으면 사용하지 않는다. */
  commitMessage?: string;
}

/** commit, push, PR 생성까지 끝난 뒤 UI가 갱신에 사용하는 결과이다. */
export interface PublishPreviewPullRequestResult {
  pullRequest: PullRequestInfo;
  remote: string;
  remoteBranch: string;
  committed: boolean;
  commitHash: string;
}

/** 게시 실패가 어느 변경 단계에서 발생했는지 보존하는 전용 오류이다. */
export class PullRequestPublishError extends Error {
  constructor(
    message: string,
    public readonly phase: "validate" | "commit" | "push" | "create",
    public readonly committed: boolean,
    public readonly pushed: boolean,
    public readonly originalError: unknown
  ) {
    super(message);
    this.name = "PullRequestPublishError";
  }
}

interface GhOpenPullRequest {
  number?: number;
  url?: string;
}

interface GhPublishedPullRequest {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  baseRefOid?: string;
  author?: { login?: string };
  isDraft?: boolean;
  reviewDecision?: string;
  updatedAt?: string;
}

/** 로컬 commit/push와 GitHub PR 생성을 하나의 검증 가능한 작업으로 제공한다. */
export class PullRequestPublishService {
  constructor(public readonly repoRoot: string) {}

  /**
   * Preview 선택을 변경하지 않고 게시 가능 상태와 remote 후보를 조사한다.
   * @param sourceBranch Preview에서 선택한 source branch
   * @param targetBranch Preview에서 선택한 target branch
   * @returns 현재 branch, staged/unstaged 수, 추천 remote를 포함한 게시 문맥
   */
  async inspect(
    sourceBranch: string,
    targetBranch: string
  ): Promise<PullRequestPublishContext> {
    const source = requiredValue(sourceBranch, "Source branch is required.");
    const target = requiredValue(targetBranch, "Target branch is required.");
    const remotes = await this.listRemotes();
    const [
      currentBranch,
      sourceIsLocal,
      stagedFileCount,
      unstagedFileCount,
      upstream,
      targetRef,
    ] = await Promise.all([
      this.currentBranch(),
      this.localBranchExists(source),
      this.changedFileCount(["diff", "--cached", "--name-only", "-z"]),
      this.unstagedFileCount(),
      this.branchUpstream(source),
      resolvePreviewTargetRef(this.repoRoot, target),
    ]);
    const upstreamRemote = splitRemoteBranch(upstream, remotes)?.remote;
    const recommendedRemote = upstreamRemote
      || (remotes.includes("origin") ? "origin" : undefined)
      || (remotes.length === 1 ? remotes[0] : undefined);
    return {
      sourceBranch: source,
      targetBranch: normalizeGithubBranch(target, remotes),
      targetRef,
      currentBranch,
      sourceIsLocal,
      stagedFileCount,
      unstagedFileCount,
      remotes: remotes.map((name) => ({
        name,
        branch: remoteBranchFor(source, name, upstream, remotes),
        recommended: name === recommendedRemote,
      })),
    };
  }

  /**
   * staged 변경을 선택적으로 commit한 뒤 source를 일반 push하고 GitHub PR을 생성한다.
   * - staged 파일은 현재 checkout branch의 index에 속하므로 source와 current가 다르면 commit 전에 중단한다.
   * - PR이 이미 있거나 target보다 앞선 commit이 없으면 로컬/원격을 변경하기 전에 가능한 한 조기에 중단한다.
   * @param options Preview 제목/본문, remote, draft 및 선택적 commit 메시지
   * @returns 생성된 PR 정보와 실제 remote/head/commit 결과
   */
  async publishPreview(
    options: PublishPreviewPullRequestOptions
  ): Promise<PublishPreviewPullRequestResult> {
    const context = await this.inspect(options.sourceBranch, options.targetBranch);
    const remote = context.remotes.find((item) => item.name === options.remote);
    const title = options.title.trim();
    if (!context.sourceIsLocal) {
      throw new Error(`Source branch '${context.sourceBranch}' is not a local branch.`);
    }
    if (!remote) {
      throw new Error(`Git remote '${options.remote}' is not available.`);
    }
    if (!title) {
      throw new Error("Pull request title is required.");
    }
    if (context.stagedFileCount > 0 && context.currentBranch !== context.sourceBranch) {
      throw new Error(
        `Staged changes belong to '${context.currentBranch}'. Select that branch as the PR source before publishing.`
      );
    }
    const commitMessage = options.commitMessage?.trim() || "";
    if (context.stagedFileCount > 0 && !commitMessage) {
      throw new Error("A commit message is required for staged changes.");
    }
    await this.assertNoOpenPullRequest(remote.branch);

    let phase: PullRequestPublishError["phase"] = "validate";
    let committed = false;
    let pushed = false;
    try {
      if (context.stagedFileCount > 0) {
        phase = "commit";
        await runGit(["commit", "-m", commitMessage], this.repoRoot);
        committed = true;
      }
      phase = "validate";
      await this.assertCommitsAhead(
        context.targetRef,
        context.targetBranch,
        context.sourceBranch
      );
      phase = "push";
      await this.publishBranch(context.sourceBranch, remote.name, remote.branch);
      pushed = true;
      const commitHash = await this.resolveCommit(context.sourceBranch);
      phase = "create";
      const url = await this.createPullRequest({
        headBranch: remote.branch,
        baseBranch: context.targetBranch,
        title,
        body: options.body,
        draft: options.draft,
      });
      const pullRequest = await this.readPublishedPullRequest(
        remote.branch,
        url,
        title,
        context.targetBranch,
        commitHash,
        options.draft
      ).catch(() => fallbackPullRequest(
        url,
        title,
        remote.branch,
        context.targetBranch,
        commitHash,
        options.draft
      ));
      return { pullRequest, remote: remote.name, remoteBranch: remote.branch, committed, commitHash };
    } catch (error) {
      throw new PullRequestPublishError(
        `${publishPhaseLabel(phase)}: ${errorText(error)}`,
        phase,
        committed,
        pushed,
        error
      );
    }
  }

  /**
   * 로컬 branch를 지정 remote branch로 일반 push하고 upstream을 연결한다.
   * @param localBranch refs/heads 아래 게시할 branch
   * @param remote 등록된 Git remote 이름
   * @param remoteBranch remote에 만들 branch 이름
   * @returns GitHub PR head로 사용할 remote branch 이름
   */
  async publishBranch(
    localBranch: string,
    remote: string,
    remoteBranch = localBranch
  ): Promise<string> {
    const branch = requiredValue(localBranch, "Local branch is required.");
    const target = requiredValue(remoteBranch, "Remote branch is required.");
    if (!(await this.listRemotes()).includes(remote)) {
      throw new Error(`Git remote '${remote}' is not available.`);
    }
    await runGit(["show-ref", "--verify", `refs/heads/${branch}`], this.repoRoot);
    await runGit(
      ["push", "-u", remote, `${branch}:refs/heads/${target}`],
      this.repoRoot
    );
    return target;
  }

  /**
   * 이미 게시된 head/base와 Preview 메시지로 GitHub Pull Request를 만든다.
   * @param options head/base/title/body/draft 생성 옵션
   * @returns gh가 출력한 새 Pull Request URL
   */
  async createPullRequest(options: CreatePullRequestOptions): Promise<string> {
    const head = requiredValue(options.headBranch, "Head branch is required.");
    const base = requiredValue(options.baseBranch, "Base branch is required.");
    const title = options.title.trim();
    if (!title) {
      throw new Error("Pull request title is required.");
    }
    const args = [
      "pr", "create", "--head", head, "--base", base,
      "--title", title, "--body", options.body,
    ];
    if (options.draft) {
      args.push("--draft");
    }
    const output = (await runGh(args, this.repoRoot)).trim();
    return output.match(/https?:\/\/\S+/g)?.at(-1) || output;
  }

  /** 저장소 remote를 origin 우선, 이후 이름순으로 반환한다. */
  private async listRemotes(): Promise<string[]> {
    return (await runGit(["remote"], this.repoRoot))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort((left, right) => Number(right === "origin") - Number(left === "origin")
        || left.localeCompare(right));
  }

  /** 같은 head branch의 열린 PR이 이미 있으면 중복 생성 전에 URL과 함께 중단한다. */
  private async assertNoOpenPullRequest(headBranch: string): Promise<void> {
    const output = await runGh([
      "pr", "list", "--state", "open", "--head", headBranch,
      "--json", "number,url", "--limit", "1",
    ], this.repoRoot);
    const values = JSON.parse(output) as GhOpenPullRequest[];
    const existing = values[0];
    if (existing?.number) {
      throw new Error(
        `Pull request #${existing.number} already exists for '${headBranch}'${existing.url ? `: ${existing.url}` : "."}`
      );
    }
  }

  /** target..source에 실제 commit이 하나 이상 있는지 확인해 빈 PR push를 막는다. */
  private async assertCommitsAhead(
    targetRef: string,
    targetBranch: string,
    sourceBranch: string
  ): Promise<void> {
    const count = Number((await runGit([
      "rev-list", "--count", `${targetRef}..refs/heads/${sourceBranch}`,
    ], this.repoRoot)).trim());
    if (!Number.isFinite(count) || count < 1) {
      throw new Error(`Branch '${sourceBranch}' has no commits ahead of '${targetBranch}'.`);
    }
  }

  /** 생성 직후 gh 응답을 공통 PullRequestInfo 형태로 읽는다. */
  private async readPublishedPullRequest(
    headBranch: string,
    createdUrl: string,
    fallbackTitle: string,
    fallbackBase: string,
    fallbackHeadHash: string,
    draft: boolean
  ): Promise<PullRequestInfo> {
    const output = await runGh([
      "pr", "view", headBranch, "--json",
      "number,title,state,url,headRefName,headRefOid,baseRefName,baseRefOid,author,isDraft,reviewDecision,updatedAt",
    ], this.repoRoot);
    const value = JSON.parse(output) as GhPublishedPullRequest;
    return {
      number: Number(value.number) || pullRequestNumber(value.url || createdUrl),
      title: value.title || fallbackTitle,
      state: value.state || "OPEN",
      url: value.url || createdUrl,
      headRefName: value.headRefName || headBranch,
      headHash: value.headRefOid || fallbackHeadHash,
      baseRefName: value.baseRefName || fallbackBase,
      baseHash: value.baseRefOid,
      author: value.author?.login || "",
      isDraft: value.isDraft ?? draft,
      reviewDecision: value.reviewDecision,
      updatedAt: value.updatedAt,
      commentCount: 0,
      fileCount: 0,
      commitHashes: [value.headRefOid || fallbackHeadHash].filter(Boolean),
    };
  }

  /** 현재 worktree branch를 반환하고 detached 상태는 HEAD로 표시한다. */
  private async currentBranch(): Promise<string> {
    return (await runGit(["branch", "--show-current"], this.repoRoot).catch(() => ""))
      .trim() || "HEAD";
  }

  /** 정확한 로컬 branch ref가 존재하는지 Git exit status로 확인한다. */
  private async localBranchExists(branch: string): Promise<boolean> {
    return runGit(["show-ref", "--verify", `refs/heads/${branch}`], this.repoRoot)
      .then(() => true, () => false);
  }

  /** branch upstream short name을 읽고 미게시 branch는 빈 문자열로 반환한다. */
  private async branchUpstream(branch: string): Promise<string> {
    const output = await runGit([
      "for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`,
    ], this.repoRoot).catch(() => "");
    return output.trim().split(/\r?\n/)[0] || "";
  }

  /** NUL 구분 파일 목록의 실제 항목 수를 센다. */
  private async changedFileCount(args: string[]): Promise<number> {
    const output = await runGit(args, this.repoRoot);
    return output.split("\0").filter(Boolean).length;
  }

  /** tracked 작업트리 변경과 아직 추적하지 않은 파일을 합쳐 commit에서 제외될 파일 수를 센다. */
  private async unstagedFileCount(): Promise<number> {
    const [tracked, untracked] = await Promise.all([
      runGit(["diff", "--name-only", "-z"], this.repoRoot),
      runGit(["ls-files", "--others", "--exclude-standard", "-z"], this.repoRoot),
    ]);
    return new Set(
      `${tracked}${untracked}`.split("\0").filter(Boolean)
    ).size;
  }

  /** branch/commit ref를 전체 OID로 정규화한다. */
  private async resolveCommit(ref: string): Promise<string> {
    return (await runGit(
      ["rev-parse", "--verify", `${ref}^{commit}`],
      this.repoRoot
    )).trim();
  }
}

/** 입력 문자열을 trim하고 필수값이 비면 사용자에게 표시 가능한 오류를 던진다. */
function requiredValue(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(message);
  return trimmed;
}

/** upstream short name을 등록된 remote와 내부 branch 이름으로 안전하게 나눈다. */
function splitRemoteBranch(
  upstream: string,
  remotes: string[]
): { remote: string; branch: string } | undefined {
  const remote = [...remotes]
    .sort((left, right) => right.length - left.length)
    .find((name) => upstream.startsWith(`${name}/`));
  return remote ? { remote, branch: upstream.slice(remote.length + 1) } : undefined;
}

/** 선택 remote가 기존 upstream과 같으면 원격 branch 이름을 보존하고 아니면 local 이름을 쓴다. */
function remoteBranchFor(
  sourceBranch: string,
  remote: string,
  upstream: string,
  remotes: string[]
): string {
  const published = splitRemoteBranch(upstream, remotes);
  return published?.remote === remote ? published.branch : sourceBranch;
}

/** origin/main 같은 Preview ref를 GitHub API가 받는 main 형태로 바꾼다. */
function normalizeGithubBranch(branch: string, remotes: string[]): string {
  return splitRemoteBranch(branch, remotes)?.branch || branch;
}

/** URL 끝의 Pull Request 번호를 fallback 숫자로 읽는다. */
function pullRequestNumber(url: string): number {
  return Number(url.match(/\/pull\/(\d+)(?:\D|$)/)?.[1]) || 0;
}

/** 생성 후 상세 조회가 실패해도 이미 만들어진 PR을 Preview에 반영할 최소 모델을 만든다. */
function fallbackPullRequest(
  url: string,
  title: string,
  headBranch: string,
  baseBranch: string,
  headHash: string,
  draft: boolean
): PullRequestInfo {
  return {
    number: pullRequestNumber(url), title, state: "OPEN", url,
    headRefName: headBranch, headHash, baseRefName: baseBranch,
    author: "", isDraft: draft, commentCount: 0, fileCount: 0,
    commitHashes: [headHash],
  };
}

/** 오류 단계에 사람이 읽을 작업명을 붙인다. */
function publishPhaseLabel(phase: PullRequestPublishError["phase"]): string {
  return ({
    validate: "Pull request validation failed",
    commit: "Committing staged changes failed",
    push: "Publishing the source branch failed",
    create: "Creating the GitHub pull request failed",
  })[phase];
}

/** 알 수 없는 throw 값을 사용자에게 표시할 문자열로 정규화한다. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
