// git graph 웹뷰의 PR 관련 메시지 처리를 돕는 모듈.
// - graphPanel 이 패널 수명주기와 그래프 로딩에 집중하도록 PR 조회/열기/preview 동작을 분리한다.
import * as vscode from "vscode";
import { LocalBranchStatus } from "../graph/graphTypes";
import { PullRequestInfo, PullRequestService } from "../git/pullRequestService";
import { PullRequestStackService } from "../git/pullRequestStackService";
import { searchPullRequests } from "../git/pullRequestSearchService";
import {
  resolvePreviewHeadRef,
  resolvePreviewTargetRef,
} from "../git/pullRequestPreviewTarget";
import { logError, logInfo, logWarn } from "../ui/outputLog";
import { openPullRequestPreviewDiff } from "../ui/pullRequestPreviewDiff";
import { PullRequestPreviewPanel } from "./pullRequestPreviewPanel";
import { ToWebviewMessage } from "./graphProtocol";

type PostGraphMessage = (message: ToWebviewMessage) => void;

/** repository 수명 안에서 같은 stack snapshot의 중복 webview 게시를 막는다. */
export class GraphPullRequestStackPublication {
  private fingerprint: string | undefined;
  /** 새 repository 수명에서 첫 snapshot을 반드시 게시하도록 이전 식별자를 지운다. */
  reset(): void { this.fingerprint = undefined; }
  /** snapshot 내용이 바뀐 경우에만 게시하고 실제 게시 여부를 반환한다. */
  publish(snapshot: Extract<ToWebviewMessage, { type: "pullRequestStackSnapshot" }> ["snapshot"], post: PostGraphMessage): boolean {
    const next = `success:${JSON.stringify(snapshot)}`;
    if (this.fingerprint === next) return false;
    this.fingerprint = next;
    post({ type: "pullRequestStackSnapshot", snapshot });
    return true;
  }
  /** 같은 오류는 한 번만 게시하고, 다음 성공이 오류 상태를 해제하도록 상태를 구분한다. */
  publishError(message: string, post: PostGraphMessage): boolean {
    const next = `error:${message}`;
    if (this.fingerprint === next) return false;
    this.fingerprint = next; post({ type: "pullRequestStackError", message }); return true;
  }
}

/** graph PR 목록의 cursor/누적 상태를 관리한다. */
export class GraphPullRequestPager {
  private pullRequests: PullRequestInfo[] = [];
  private nextCursor: string | undefined;
  private hasMore = false;
  private loading = false;
  private repository = "";
  private defaultBranch = "";
  private activeRequest: AbortController | undefined;
  private lastOverviewFingerprint: string | undefined;
  // 진행 중인 조회를 식별하는 세대 토큰. refresh 는 세대를 올려 이전 조회 결과를 무효화한다.
  // 이 값이 도중에 바뀐 조회는 응답을 화면/상태에 반영하지 않아(latest-wins) 목록이 늘었다 줄었다 깜박이는 것을 막는다.
  private generation = 0;

  /** open/preview 동작에서 사용할 현재 누적 PR 목록을 반환한다. */
  get items(): PullRequestInfo[] {
    return this.pullRequests;
  }

  /** stack graph snapshot이 추가 원격 조회 없이 재사용할 owner/name 저장소 이름을 반환한다. */
  get repositoryName(): string {
    return this.repository;
  }

  /** 마지막 성공 overview에서 받은 기본 branch를 stack snapshot hint로 반환한다. */
  get defaultBranchName(): string {
    return this.defaultBranch;
  }

  /** 저장소 교체·패널 폐기 때만 게시 fingerprint를 버려 다음 수명주기의 첫 상태를 보장한다. */
  resetPublication(): void {
    this.lastOverviewFingerprint = undefined;
  }

  /** 저장소 수명 경계에서 이전 repository의 PR·cursor·metadata hint를 모두 버린다. */
  resetRepository(): void {
    this.pullRequests = []; this.nextCursor = undefined; this.hasMore = false;
    this.repository = ""; this.defaultBranch = ""; this.resetPublication();
  }

  /** 패널 숨김·폐기·저장소 교체 시 진행 중인 gh 조회를 중단하고 세대를 무효화한다. */
  cancel(reason: string): void {
    if (!this.activeRequest) return;
    this.activeRequest.abort();
    this.activeRequest = undefined;
    this.generation++;
    this.loading = false;
    logInfo("graph pull request request cancelled", { reason, generation: this.generation });
  }

  /**
   * PR 목록을 첫 페이지부터 다시 읽고 성공했을 때만 누적 상태를 교체한다.
   * - 조회 시작 시점에 기존 목록을 비우지 않는다. 일시적 gh 실패로 배지가 사라졌다 나타나는 깜박임을 막기 위함.
   * - 세대 토큰을 올려 앞서 진행 중이던 조회 응답은 폐기한다(최신 refresh 우선).
   * @param repoRoot      대상 저장소 루트
   * @param localBranches 현재 로컬 브랜치 상태
   * @param reason        OUTPUT 로그에 남길 조회 원인
   * @param post          graph 웹뷰 메시지 전송 함수
   */
  async refresh(
    repoRoot: string,
    localBranches: LocalBranchStatus[],
    reason: string,
    post: PostGraphMessage
  ): Promise<boolean> {
    this.cancel("superseded");
    const generation = ++this.generation;
    const controller = new AbortController();
    this.activeRequest = controller;
    this.loading = true;
    logInfo("graph pull request request started", { repoRoot, reason, generation });
    return this.fetchPage(repoRoot, localBranches, reason, post, undefined, "replace", generation, controller.signal);
  }

  /**
   * 다음 PR 페이지가 있으면 이어 읽어 기존 목록 뒤에 붙인다.
   * @param repoRoot      대상 저장소 루트
   * @param localBranches 현재 로컬 브랜치 상태
   * @param post          graph 웹뷰 메시지 전송 함수
   */
  async loadMore(
    repoRoot: string,
    localBranches: LocalBranchStatus[],
    post: PostGraphMessage
  ): Promise<boolean> {
    if (this.loading || !this.hasMore || !this.nextCursor) {
      return false;
    }
    // loadMore 는 세대를 올리지 않는다. 도중에 refresh 가 시작되면 세대가 어긋나 이 페이지 결과는 폐기된다.
    const generation = this.generation;
    this.loading = true;
    const controller = new AbortController();
    this.activeRequest = controller;
    return this.fetchPage(repoRoot, localBranches, "loadMore", post, this.nextCursor, "append", generation, controller.signal);
  }

  /**
   * GitHub repository-wide PR 검색 결과를 읽고 누적 목록에 병합한다.
   * @param repoRoot 대상 저장소 루트
   * @param requestId 웹뷰가 최신 검색 응답만 적용하기 위한 요청 ID
   * @param query 사용자가 입력한 검색어
   * @param post graph 웹뷰 메시지 전송 함수
   */
  async search(
    repoRoot: string,
    requestId: string,
    query: string,
    cursor: string | undefined,
    post: PostGraphMessage
  ): Promise<void> {
    try {
      const result = await searchPullRequests(repoRoot, query, cursor);
      this.pullRequests = mergePullRequests(this.pullRequests, result.pullRequests);
      post({ type: "pullRequestSearchResult", requestId, result });
      logInfo("graph pull request search sent", {
        repoRoot,
        requestId,
        query,
        matches: result.pullRequests.length,
        totalCount: result.totalCount,
        hasMore: result.hasMore,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("graph pull request search failed", error, { repoRoot, requestId, query });
      post({ type: "pullRequestSearchError", requestId, query, message });
    }
  }

  /**
   * GitHub PR 한 페이지를 읽고, 성공했을 때만 누적 목록/커서를 갱신해 웹뷰에 보낸다.
   * - 세대 토큰이 도중에 바뀌면(더 최신 refresh 시작) 응답을 폐기해 stale 결과가 화면을 덮어쓰지 않게 한다.
   * - `available:false`(gh 실패) 응답이면 기존 누적 목록/커서를 그대로 유지해 그래프 배지가 사라지지 않게 한다.
   * @param repoRoot      대상 저장소 루트
   * @param localBranches 현재 로컬 브랜치 상태
   * @param reason        OUTPUT 로그에 남길 조회 원인
   * @param post          graph 웹뷰 메시지 전송 함수
   * @param cursor        이어 읽을 GitHub GraphQL cursor
   * @param mode          "replace"=첫 페이지로 목록 교체(refresh), "append"=뒤에 이어붙임(loadMore)
   * @param generation    이 조회가 속한 세대 토큰
   */
  private async fetchPage(
    repoRoot: string,
    localBranches: LocalBranchStatus[],
    reason: string,
    post: PostGraphMessage,
    cursor: string | undefined,
    mode: "replace" | "append",
    generation: number,
    signal: AbortSignal
  ): Promise<boolean> {
    try {
      const service = new PullRequestService(repoRoot);
      const overview = await service.getOverview(localBranches, cursor, signal);
      if (generation !== this.generation) {
        logInfo("graph pull request stale skip", {
          repoRoot,
          reason,
          generation,
          current: this.generation,
        });
        return false;
      }
      if (overview.available) {
        // 성공 시에만 상태를 갱신한다. replace 는 첫 페이지로 교체, append 는 기존 목록 뒤에 병합한다.
        this.pullRequests = mode === "replace"
          ? overview.pullRequests
          : mergePullRequests(this.pullRequests, overview.pullRequests);
        this.nextCursor = overview.nextCursor;
        this.hasMore = overview.hasMore;
        this.repository = overview.repository || this.repository;
        this.defaultBranch = overview.defaultBranch || this.defaultBranch;
      }
      const effectiveOverview = { ...overview, pullRequests: this.pullRequests, hasMore: this.hasMore, nextCursor: this.nextCursor };
      const fingerprint = JSON.stringify(effectiveOverview);
      const changed = this.lastOverviewFingerprint !== fingerprint;
      if (changed) {
        this.lastOverviewFingerprint = fingerprint;
        post({ type: "pullRequestOverview", overview: effectiveOverview });
      }
      logInfo("graph pull request overview publication", {
        repoRoot,
        reason,
        action: changed ? "sent" : "retained",
        available: overview.available,
        pageCount: overview.pullRequests.length,
        totalCount: this.pullRequests.length,
        hasMore: this.hasMore,
      });
      return true;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        logInfo("graph pull request request cancelled", { repoRoot, reason, generation });
        return false;
      }
      throw error;
    } finally {
      // 현재 세대의 조회만 loading 을 해제한다(더 최신 refresh 가 소유권을 가진 경우 건드리지 않음).
      if (generation === this.generation) {
        this.loading = false;
      }
      if (this.activeRequest?.signal === signal) this.activeRequest = undefined;
    }
  }
}

/**
 * 로컬 parent 메타데이터와 현재 pager PR을 합쳐 Git Graph stack 흐름을 보낸다.
 * - PR 조회가 실패했어도 pager의 마지막 성공 목록과 로컬 layer를 유지한다.
 * @param repoRoot 대상 저장소 루트
 * @param pullRequests graph pager가 현재 누적한 PR 목록
 * @param repositoryHint 마지막 성공 overview의 owner/name
 * @param post graph 웹뷰 메시지 전송 함수
 */
export async function sendGraphPullRequestStacks(
  repoRoot: string,
  pullRequests: PullRequestInfo[],
  repositoryHint: string,
  defaultBranchHint: string,
  signal: AbortSignal | undefined,
  post: PostGraphMessage,
  publication?: GraphPullRequestStackPublication
): Promise<void> {
  try {
    if (signal?.aborted) return;
    logInfo(repositoryHint && defaultBranchHint
      ? "graph pull request stack metadata reused"
      : "graph pull request stack local metadata", { repoRoot, repositoryHint, defaultBranchHint });
    const snapshot = await new PullRequestStackService(repoRoot)
      .getGraphSnapshot(pullRequests, repositoryHint, defaultBranchHint, signal);
    if (signal?.aborted) {
      logInfo("graph pull request stack stale skip", { repoRoot });
      return;
    }
    const sent = publication ? publication.publish(snapshot, post) : (post({ type: "pullRequestStackSnapshot", snapshot }), true);
    logInfo("graph pull request stack snapshot publication", {
      repoRoot,
      action: sent ? "sent" : "retained",
      repository: snapshot.repository,
      stacks: snapshot.stacks.length,
      layers: snapshot.layers.length,
      localLayers: snapshot.layers.filter((layer) => layer.local).length,
    });
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      logInfo("graph pull request stack cancelled", { repoRoot });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    publication?.publishError(message, post) ?? post({ type: "pullRequestStackError", message });
    logError("graph pull request stack snapshot failed", error, { repoRoot });
  }
}

/** gh CLI의 취소 오류와 DOM AbortError를 일반 오류 UI에서 제외한다. */
function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return error.name === "AbortError" || code === "ABORTED" || code === "ABORT_ERR";
}

/**
 * PR 상세 drawer 용 changed files 데이터를 읽어 웹뷰에 보낸다.
 * @param repoRoot 대상 저장소 루트
 * @param number   조회할 PR 번호
 * @param post     graph 웹뷰 메시지 전송 함수
 */
export async function sendGraphPullRequestDetail(
  repoRoot: string,
  number: number,
  post: PostGraphMessage
): Promise<void> {
  const service = new PullRequestService(repoRoot);
  try {
    const detail = await service.getDetail(number);
    post({ type: "pullRequestDetail", number, detail });
    logInfo("graph pull request detail sent", {
      repoRoot,
      number,
      files: detail.files.length,
      fileCommentCount: detail.fileCommentCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError("graph pull request detail failed", error, { repoRoot, number });
    post({ type: "pullRequestDetailError", number, message });
  }
}

/**
 * Graph의 PR 행에 연결된 외부 GitHub URL을 연다.
 * - Graph는 commit 관계 탐색을 유지하고, 기존 Pull Request는 기본 브라우저에서 확인한다.
 * @param pullRequests 마지막으로 조회한 PR 목록
 * @param number       열 PR 번호
 */
export async function openGraphPullRequest(
  repoRoot: string,
  pullRequests: PullRequestInfo[],
  number: number
): Promise<void> {
  const pullRequest = pullRequests.find((item) => item.number === number);
  if (!pullRequest) {
    vscode.window.showWarningMessage(vscode.l10n.t("Pull request #{0} is not loaded.", number));
    logWarn("graph pull request open skipped: not loaded", { repoRoot, number });
    return;
  }
  if (!pullRequest.url) {
    vscode.window.showWarningMessage(vscode.l10n.t("Unable to open Pull Request #{0} on GitHub.", number));
    logWarn("graph pull request open skipped: missing URL", { repoRoot, number, reason: "missing-url" });
    return;
  }
  const opened = await vscode.env.openExternal(vscode.Uri.parse(pullRequest.url));
  if (!opened) throw new Error(vscode.l10n.t("Unable to open Pull Request #{0} on GitHub.", number));
  logInfo("graph pull request opened in browser", { repoRoot, number, url: pullRequest.url });
}

/**
 * PR 상세 drawer 의 변경 파일 하나를 base↔head diff 로 연다.
 * - GitHub ref 이름(main 등)을 로컬 git ref 로 해석한 뒤, PR preview 의 diff 표현 모듈을 재사용한다
 *   (작업트리 파일이 있으면 editable, 없으면 ref↔ref 가상 diff 로 fallback).
 * @param repoRoot     대상 저장소 루트
 * @param pullRequests 마지막으로 조회한 PR 목록(base/head ref 조회용)
 * @param number       파일이 속한 PR 번호
 * @param file         열 파일 정보(경로 / 상태 / 이름변경 원본 경로)
 */
export async function openGraphPullRequestFileDiff(
  repoRoot: string,
  pullRequests: PullRequestInfo[],
  number: number,
  file: { path: string; oldPath?: string; status?: string }
): Promise<void> {
  if (!file.path) {
    return;
  }
  const pr = pullRequests.find((item) => item.number === number);
  if (!pr) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Pull request #{0} is not loaded.", number)
    );
    return;
  }
  const baseRef = await resolvePreviewTargetRef(repoRoot, pr.baseRefName);
  const headRef = await resolvePreviewHeadRef(
    repoRoot,
    pr.headRefName,
    pr.headHash
  );
  await openPullRequestPreviewDiff(repoRoot, {
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    baseRef,
    headRef,
  });
  logInfo("graph pull request file diff opened", {
    repoRoot,
    number,
    path: file.path,
    baseRef,
    headRef,
  });
}

/**
 * staged 변경 또는 Graph에 적재된 기존 PR 기준으로 preview 패널을 연다.
 * - 번호가 없으면 기존 toolbar 동작처럼 현재 repository의 staged 변경을 preview 한다.
 * - 번호가 있으면 stack snapshot의 축약 정보 대신 pager의 완전한 PR을 사용해 GitHub PR 문맥을 보존한다.
 * @param extensionUri  preview 웹뷰 resource를 찾을 확장 URI
 * @param repoRoot      대상 저장소 루트
 * @param pullRequests Graph pager가 현재 적재한 완전한 PR 목록
 * @param number        기존 PR 기준으로 열 경우의 PR 번호. 없으면 로컬 staged preview를 연다.
 */
export function openStagedPullRequestPreview(
  extensionUri: vscode.Uri,
  repoRoot: string,
  pullRequests: PullRequestInfo[] = [],
  number?: number
): void {
  if (number !== undefined) {
    const pullRequest = pullRequests.find((item) => item.number === number);
    if (!pullRequest) {
      vscode.window.showWarningMessage(vscode.l10n.t("Pull request #{0} is not loaded.", number));
      logWarn("graph pull request preview skipped: not loaded", { repoRoot, number });
      return;
    }
    PullRequestPreviewPanel.createOrShow(
      extensionUri,
      new PullRequestService(repoRoot),
      pullRequest.baseRefName,
      pullRequest
    );
    logInfo("graph pull request preview opened", { repoRoot, number, baseRefName: pullRequest.baseRefName });
    return;
  }
  PullRequestPreviewPanel.createOrShow(
    extensionUri,
    new PullRequestService(repoRoot),
    undefined,
    undefined
  );
}

/** PR 번호 기준으로 중복 없이 기존 목록 뒤에 새 페이지를 붙인다. */
function mergePullRequests(
  previous: PullRequestInfo[],
  next: PullRequestInfo[]
): PullRequestInfo[] {
  const byNumber = new Map<number, PullRequestInfo>();
  for (const pr of previous) {
    byNumber.set(pr.number, pr);
  }
  for (const pr of next) {
    const current = byNumber.get(pr.number);
    byNumber.set(pr.number, current ? mergePullRequest(current, pr) : pr);
  }
  return Array.from(byNumber.values());
}

/**
 * 같은 PR의 기존 목록 데이터와 새 페이지/검색 데이터를 손실 없이 합친다.
 * - repository 검색 응답은 commit 첫 100개만 가지므로, 이미 전체 pagination을 끝낸
 *   기존 commit 목록을 새 검색 결과가 덮어쓰지 않게 합집합을 유지한다.
 * @param current pager가 이미 보유한 PR 정보
 * @param incoming 새 목록 페이지 또는 repository 검색에서 받은 PR 정보
 * @returns 최신 메타데이터와 누적 commit 목록을 함께 가진 PR 정보
 */
function mergePullRequest(
  current: PullRequestInfo,
  incoming: PullRequestInfo
): PullRequestInfo {
  return {
    ...current,
    ...incoming,
    headHash: incoming.headHash || current.headHash,
    baseHash: incoming.baseHash || current.baseHash,
    mergeHash: incoming.mergeHash || current.mergeHash,
    commitHashes: Array.from(new Set([
      ...current.commitHashes,
      ...incoming.commitHashes,
    ])),
  };
}
