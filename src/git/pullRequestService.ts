// GitHub Pull Request POC 데이터를 읽는 서비스.
// - git graph UI 가 gh CLI/remote URL/스테이징 diff 해석을 직접 알지 않도록 분리한다.
import { CommitFileChange, LocalBranchStatus } from "../graph/graphTypes";
import { parseNameStatusZ, parseNumstat } from "./diffParse";
import { runGh } from "./ghCli";
import { runGit } from "./gitExec";
import { fetchPullRequestListPage } from "./pullRequestListService";
import { fetchPullRequestDetail } from "./pullRequestDetail";
import type { PullRequestDetailInfo } from "./pullRequestDetail";
import { fetchPullRequestChangedFiles, fetchPullRequestPreviewFiles } from "./pullRequestPreviewFiles";
import type { PullRequestChangedFilesResult, PullRequestPreviewFile } from "./pullRequestPreviewFiles";
import {
  applyStagedPullRequestPreviewOverlay,
  buildIndexedPullRequestPreviewFiles,
  buildLocalPullRequestPreview,
  buildStagedPullRequestPreviewOverlay,
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
import type { PullRequestInfo } from "./pullRequestInfo";
export type { PullRequestInfo } from "./pullRequestInfo";
export type { PullRequestChangedFileInfo, PullRequestDetailInfo } from "./pullRequestDetail";
/** graph 웹뷰에 보내는 PR 전체 상태 */
export interface PullRequestOverview {
  available: boolean;
  repository?: string;
  defaultBranch?: string;
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
  sourceIsLocal: boolean;
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
  stagedFileCount: number;
  existingPr?: PullRequestInfo;
}

interface GhPullRequestPreview {
  title?: string;
  body?: string;
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
    cursor?: string,
    signal?: AbortSignal
  ): Promise<PullRequestOverview> {
    try {
      throwIfAborted(signal);
      const page = await fetchPullRequestListPage(this.repoRoot, cursor, signal);
      const prs = page.pullRequests;
      const current = localBranches.find((branch) => branch.current);
      return {
        available: true,
        repository: page.repository,
        defaultBranch: page.defaultBranch,
        currentBranch: current?.name,
        targetBranch: this.targetBranchFor(current, prs),
        hasMore: Boolean(page.pageInfo?.hasNextPage),
        nextCursor: page.pageInfo?.endCursor,
        pullRequests: prs,
      };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
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
    const [stagedFiles, repository, existingPreview, sourceIsLocal] = await Promise.all([
      this.stagedFiles(),
      this.repositoryName().catch(() => undefined),
      this.existingPullRequestPreview(effectivePr).catch(() => undefined),
      this.localBranchExists(selectedSource),
    ]);
    const prPreviewFiles = await this.existingPullRequestPreviewFiles(repository, effectivePr).catch(() => []);
    const prPreviewCommits = await fetchExistingPullRequestCommits(this.repoRoot, repository, effectivePr).catch(() => []);
    const hasRemotePreview = prPreviewFiles.length > 0 || prPreviewCommits.length > 0;
    const previewStagedFiles =
      currentBranch === selectedSource ? stagedFiles : [];
    let previewModel: {
      files: PullRequestPreviewFile[];
      commits: PullRequestPreviewCommit[];
    };
    if (!hasTargetBranch) {
      previewModel = { files: [], commits: [] };
    } else if (hasRemotePreview && previewStagedFiles.length) {
      const [overlay, indexedFiles] = await Promise.all([
        buildStagedPullRequestPreviewOverlay(
          this.repoRoot,
          previewStagedFiles
        ),
        buildIndexedPullRequestPreviewFiles(
          this.repoRoot,
          targetRef,
          sourceRef
        ),
      ]);
      previewModel = applyStagedPullRequestPreviewOverlay(
        prPreviewFiles,
        prPreviewCommits,
        overlay,
        indexedFiles
      );
    } else if (hasRemotePreview) {
      previewModel = {
        files: prPreviewFiles,
        commits: prPreviewCommits,
      };
    } else {
      previewModel = await buildLocalPullRequestPreview(
        this.repoRoot,
        targetRef,
        sourceRef,
        previewStagedFiles
      );
    }
    const previewFiles = previewModel.files;
    const previewCommits = previewModel.commits;
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
      sourceIsLocal,
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
      stagedFileCount: stagedFiles.length,
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

  /** Preview source가 게시 가능한 실제 로컬 branch인지 확인한다. */
  private async localBranchExists(branch: string): Promise<boolean> {
    return runGit(
      ["show-ref", "--verify", `refs/heads/${branch}`],
      this.repoRoot
    ).then(() => true, () => false);
  }

  /** gh repo view 로 owner/name 을 읽는다. */
  private async repositoryName(signal?: AbortSignal, operation = "pull-request-repository"): Promise<string> {
    const out = await runGh(["repo", "view", "--json", "nameWithOwner"], this.repoRoot, { signal, operation });
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

/** 취소 신호와 gh의 취소 오류를 공통으로 판별해 오류 overview로 잘못 바꾸지 않는다. */
function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return error.name === "AbortError" || code === "ABORTED" || code === "ABORT_ERR";
}

/** pagination 직전에 취소 여부를 확인해 불필요한 후속 gh 프로세스를 만들지 않는다. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Graph pull request request was cancelled.", "AbortError");
}
