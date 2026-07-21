// GitHub Pull Request POC 데이터를 읽는 서비스.
// - git graph UI 가 gh CLI/remote URL/스테이징 diff 해석을 직접 알지 않도록 분리한다.
import { CommitFileChange, LocalBranchStatus } from "../graph/graphTypes";
import { parseNameStatusZ, parseNumstat } from "./diffParse";
import { runGh } from "./ghCli";
import { runGit } from "./gitExec";
import { splitRepositoryName } from "./githubRepository";
import { fetchPullRequestDetail } from "./pullRequestDetail";
import type { PullRequestDetailInfo } from "./pullRequestDetail";
import { fetchPullRequestChangedFiles, fetchPullRequestPreviewFiles } from "./pullRequestPreviewFiles";
import type { PullRequestChangedFilesResult, PullRequestPreviewFile } from "./pullRequestPreviewFiles";
import {
  buildLocalPullRequestPreview,
  commitLabels,
  fetchExistingPullRequestCommits,
  fetchLocalCommitPreviewFiles,
  previewStat,
} from "./pullRequestPreviewCommits";
import type { PullRequestPreviewCommit } from "./pullRequestPreviewCommits";
import { buildPullRequestConversation } from "./pullRequestPreviewConversation";
import type { PullRequestConversationItem } from "./pullRequestPreviewConversation";
import { previewTargetBranches } from "./pullRequestPreviewBranches";
import { previewBody } from "./pullRequestPreviewBody";
import { resolvePreviewHeadRef, resolvePreviewTargetRef } from "./pullRequestPreviewTarget";
import { previewTitle } from "./pullRequestPreviewTitle";
import { fetchRemainingReviewThreadCommentCounts } from "./pullRequestCommentCounts";
import {
  PULL_REQUEST_INFO_QUERY,
  pullRequestInfoFromGraphQl,
} from "./pullRequestInfo";
import type {
  GhPageInfo,
  GhPullRequestNode,
  PullRequestInfo,
} from "./pullRequestInfo";
export type { PullRequestInfo } from "./pullRequestInfo";
export type { PullRequestChangedFileInfo, PullRequestDetailInfo } from "./pullRequestDetail";
/** PR 목록을 한 번에 읽는 페이지 크기 */
const PULL_REQUEST_PAGE_SIZE = 80;
/** PR 목록 GraphQL 쿼리. gh pr list 의 commits 필드가 과도한 author 연결을 펴지 않도록 필요한 값만 직접 요청한다. */
const PULL_REQUESTS_QUERY = `
query($owner: String!, $name: String!, $limit: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $limit, after: $cursor, states: [OPEN, CLOSED, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
${PULL_REQUEST_INFO_QUERY}
      }
      pageInfo {
        hasNextPage
        endCursor
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
/** graph 웹뷰에 보내는 PR 전체 상태 */
export interface PullRequestOverview {
  available: boolean;
  repository?: string;
  currentBranch?: string;
  targetBranch?: string;
  error?: string;
  hasMore: boolean;
  nextCursor?: string;
  pullRequests: PullRequestInfo[];
}

/** staged 상태로 PR 을 만들 때의 모의 내용 */
export interface StagedPullRequestPreview {
  repository?: string;
  currentBranch: string; sourceBranch: string; sourceRef: string;
  targetBranch: string; targetRef: string; headRef: string;
  sourceBranches: string[]; targetBranches: string[];
  title: string;
  body: string;
  files: CommitFileChange[];
  previewFiles: PullRequestPreviewFile[];
  commits: string[];
  previewCommits: PullRequestPreviewCommit[];
  conversation: PullRequestConversationItem[];
  stat: string;
  hasStagedChanges: boolean;
  existingPr?: PullRequestInfo;
}

interface GhPullRequestPreview {
  title?: string;
  body?: string;
}

interface GhGraphQlResponse {
  data?: {
    repository?: {
      pullRequests?: {
        nodes?: GhPullRequestNode[];
        pageInfo?: GhPageInfo;
      };
    };
  };
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

/** 저장소 한 개의 GitHub PR POC 조회 서비스 */
export class PullRequestService {
  constructor(public readonly repoRoot: string) {}

  /**
   * gh CLI 로 저장소 PR 목록을 읽고, graph 배지용 PR commit 해시들을 붙인다.
   * @param localBranches 현재 로컬 브랜치 상태. current branch/target 추정에 사용한다.
   */
  async getOverview(
    localBranches: LocalBranchStatus[],
    cursor?: string
  ): Promise<PullRequestOverview> {
    try {
      const repository = await this.repositoryName();
      const page = await this.listPullRequests(repository, cursor);
      const prs = page.pullRequests;
      const current = localBranches.find((branch) => branch.current);
      return {
        available: true,
        repository,
        currentBranch: current?.name,
        targetBranch: this.targetBranchFor(current, prs),
        hasMore: Boolean(page.pageInfo?.hasNextPage),
        nextCursor: page.pageInfo?.endCursor,
        pullRequests: prs,
      };
    } catch (error) {
      return {
        available: false,
        currentBranch: localBranches.find((branch) => branch.current)?.name,
        error: error instanceof Error ? error.message : String(error),
        hasMore: false,
        pullRequests: [],
      };
    }
  }

  /**
   * 현재 staged 상태를 target branch 로 PR 한다고 가정한 모의 내용을 만든다.
   * @param baseBranch 명시 target branch. 새 staged preview 에서는 없으면 선택 전 상태로 둔다.
   * @param existingPr 기존 PR 이 있으면 제목/본문 힌트에 포함한다.
   * @param sourceBranch 명시 source branch. 없으면 기존 PR head/current branch 순서로 추정한다.
   */
  async getStagedPreview(
    baseBranch?: string,
    existingPr?: PullRequestInfo,
    sourceBranch?: string
  ): Promise<StagedPullRequestPreview> {
    const currentBranch = await this.currentBranch();
    const selectedSource = sourceBranch || existingPr?.headRefName || currentBranch;
    const targetBranch = baseBranch || existingPr?.baseRefName || "";
    const hasTargetBranch = Boolean(targetBranch);
    const [targetRef, sourceRef] = await Promise.all([
      hasTargetBranch ? resolvePreviewTargetRef(this.repoRoot, targetBranch) : Promise.resolve(""),
      resolvePreviewTargetRef(this.repoRoot, selectedSource),
    ]);
    const [targetBranches, sourceBranches] = await Promise.all([previewTargetBranches(this.repoRoot, targetBranch, selectedSource), previewTargetBranches(this.repoRoot, selectedSource, targetBranch)]);
    const effectivePr = (baseBranch && existingPr?.baseRefName && baseBranch !== existingPr.baseRefName)
      || (sourceBranch && existingPr?.headRefName && sourceBranch !== existingPr.headRefName)
      ? undefined
      : existingPr;
    const headRef = effectivePr ? await resolvePreviewHeadRef(this.repoRoot, effectivePr.headRefName, effectivePr.headHash) : "HEAD";
    const [stagedFiles, repository, existingPreview] = await Promise.all([
      this.stagedFiles(),
      this.repositoryName().catch(() => undefined),
      this.existingPullRequestPreview(effectivePr).catch(() => undefined),
    ]);
    const prPreviewFiles = await this.existingPullRequestPreviewFiles(repository, effectivePr).catch(() => []);
    const prPreviewCommits = await fetchExistingPullRequestCommits(this.repoRoot, repository, effectivePr).catch(() => []);
    const localPreview = !hasTargetBranch || prPreviewFiles.length || prPreviewCommits.length
      ? { files: [] as PullRequestPreviewFile[], commits: [] as PullRequestPreviewCommit[] }
      : await buildLocalPullRequestPreview(this.repoRoot, targetRef, sourceRef, stagedFiles);
    const previewFiles = prPreviewFiles.length ? prPreviewFiles : localPreview.files;
    const previewCommits = prPreviewCommits.length ? prPreviewCommits : localPreview.commits;
    const commits = commitLabels(previewCommits);
    const stat = previewStat(previewFiles);
    const generatedBody = hasTargetBranch ? previewBody(previewFiles, commits, stat) : "";
    const body = existingPreview ? existingPreview.body ?? "" : generatedBody;
    const conversation = hasTargetBranch || effectivePr
      ? await buildPullRequestConversation(
        this.repoRoot,
        repository,
        effectivePr,
        body,
        selectedSource
      ).catch(() => [{ kind: "body" as const, author: effectivePr?.author || selectedSource, body }])
      : [];
    return {
      repository,
      currentBranch,
      sourceBranch: selectedSource,
      sourceRef,
      targetBranch,
      targetRef,
      headRef,
      sourceBranches,
      targetBranches,
      title: existingPreview?.title || effectivePr?.title || (hasTargetBranch ? previewTitle(selectedSource, targetBranch, commits, previewFiles) : ""),
      body,
      files: previewFiles,
      previewFiles,
      commits,
      previewCommits,
      conversation,
      stat,
      hasStagedChanges: stagedFiles.length > 0 || previewFiles.length > 0,
      existingPr: effectivePr,
    };
  }

  /**
   * PR 상세 drawer 에 필요한 changed files 와 파일별 review comment 수를 읽는다.
   * @param number 조회할 PR 번호
   * @returns PR 상세 drawer 데이터
   */
  async getDetail(number: number): Promise<PullRequestDetailInfo> {
    const repository = await this.repositoryName();
    return fetchPullRequestDetail(this.repoRoot, repository, number);
  }

  /**
   * Explorer 비교 표시에 필요한 PR changed files 만 읽는다.
   * - 상세/preview 경로와 달리 review comment API 를 호출하지 않으므로 파일 장식을
   *   갱신할 때 댓글 본문이나 patch 데이터를 함께 내려받지 않는다.
   * @param number 조회할 GitHub Pull Request 번호
   * @returns 상태·이전 경로·라인 증감이 정규화된 파일 목록과 API 상한 도달 여부
   */
  async getChangedFiles(number: number): Promise<PullRequestChangedFilesResult> {
    const repository = await this.repositoryName();
    return fetchPullRequestChangedFiles(this.repoRoot, repository, number);
  }

  /**
   * PR preview Commits 탭에서 선택한 로컬 commit 의 파일 변경을 지연 조회한다.
   * @param hash 파일 변경을 읽을 commit hash
   * @returns 해당 commit 의 changed files
   */
  async getPreviewCommitFiles(hash: string): Promise<PullRequestPreviewFile[]> {
    return fetchLocalCommitPreviewFiles(this.repoRoot, hash);
  }

  /**
   * 열린 PR 목록을 GitHub GraphQL 로 가볍게 조회한다.
   * - `gh pr list --json commits` 는 commit author 연결까지 크게 펼쳐 GraphQL 한도를 넘을 수 있어 사용하지 않는다.
   * @param repository owner/name 형태의 GitHub 저장소 이름
   */
  private async listPullRequests(
    repository: string,
    cursor?: string
  ): Promise<{ pullRequests: PullRequestInfo[]; pageInfo?: GhPageInfo }> {
    const [owner, name] = splitRepositoryName(repository);
    const args = [
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `limit=${PULL_REQUEST_PAGE_SIZE}`,
      "-f",
      `query=${PULL_REQUESTS_QUERY}`,
    ];
    if (cursor) {
      args.splice(args.length - 2, 0, "-f", `cursor=${cursor}`);
    }
    const out = await runGh(args, this.repoRoot);
    const parsed = JSON.parse(out) as GhGraphQlResponse;
    const connection = parsed.data?.repository?.pullRequests;
    const nodes = connection?.nodes || [];
    const extraReviewCommentCounts = await fetchRemainingReviewThreadCommentCounts(this.repoRoot, owner, name, nodes);
    const prs = nodes.map((pr) => pullRequestInfoFromGraphQl(
      pr,
      extraReviewCommentCounts.get(Number(pr.number)) || 0
    ));
    await this.appendRemainingCommitHashes(owner, name, nodes, prs);
    return { pullRequests: prs, pageInfo: connection?.pageInfo };
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
    nodes: GhPullRequestNode[],
    prs: PullRequestInfo[]
  ): Promise<void> {
    for (let index = 0; index < nodes.length; index++) {
      const prNumber = Number(nodes[index]?.number);
      if (!Number.isFinite(prNumber)) {
        continue;
      }
      let pageInfo = nodes[index]?.commits?.pageInfo;
      while (pageInfo?.hasNextPage && pageInfo.endCursor) {
        const page = await this.listCommitHashPage(owner, name, prNumber, pageInfo.endCursor);
        const hashes = prs[index]?.commitHashes;
        if (hashes) {
          hashes.push(...page.hashes.filter((hash) => !hashes.includes(hash)));
        }
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

  /** staged diff 의 파일 목록과 증감 라인을 읽는다. */
  private async stagedFiles(): Promise<CommitFileChange[]> {
    const [nameStatus, numstat] = await Promise.all([
      runGit(["diff", "--cached", "--name-status", "-z"], this.repoRoot),
      runGit(["diff", "--cached", "--numstat", "-z"], this.repoRoot),
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

  /**
   * 기존 PR 기준으로 preview 를 연 경우 GitHub 에 저장된 실제 제목/본문을 읽는다.
   * @param existingPr graph PR 목록에서 선택된 기존 PR 정보
   * @returns GitHub PR 의 현재 title/body. 조회 실패 시 호출부가 staged preview 본문으로 fallback 한다.
   */
  private async existingPullRequestPreview(
    existingPr?: PullRequestInfo
  ): Promise<GhPullRequestPreview | undefined> {
    if (!existingPr?.number) {
      return undefined;
    }
    const out = await runGh([
      "pr",
      "view",
      String(existingPr.number),
      "--json",
      "title,body",
    ], this.repoRoot);
    return JSON.parse(out) as GhPullRequestPreview;
  }

  /**
   * 기존 PR preview 의 Files changed 탭에 넣을 실제 PR changed files 를 읽는다.
   * @param repository owner/name 형태의 GitHub 저장소 이름
   * @param existingPr graph PR 목록에서 선택된 기존 PR 정보
   * @returns PR 상세 changed files. 조회할 PR 이 없으면 undefined
   */
  private async existingPullRequestPreviewFiles(
    repository: string | undefined,
    existingPr?: PullRequestInfo
  ): Promise<PullRequestPreviewFile[]> {
    if (!repository || !existingPr?.number) {
      return [];
    }
    return fetchPullRequestPreviewFiles(this.repoRoot, repository, existingPr.number);
  }

  /** 현재 branch 이름을 반환한다. detached 이면 HEAD 로 표시한다. */
  private async currentBranch(): Promise<string> {
    return (await runGit(["branch", "--show-current"], this.repoRoot).catch(() => "")).trim() || "HEAD";
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
