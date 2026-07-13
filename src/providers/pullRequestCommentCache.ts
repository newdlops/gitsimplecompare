// GitHub PR review comment 원격 조회와 저장소별 캐시 생명주기를 관리한다.
// - 에디터 표시/포커스 판단은 controller 에 남기고, TTL·singleflight·인증 보조 흐름만 담당한다.
import * as vscode from "vscode";
import {
  ActivePullRequestReviewComments,
  PullRequestReviewCommentService,
} from "../git/pullRequestReviewComments";
import type { PullRequestSuggestedChangesetStatus } from "../git/pullRequestSuggestedChangesets";
import { readStoredGitHubWebCookie } from "../ui/githubWebCookieSecret";
import { logInfo } from "../ui/outputLog";
import {
  countAttachedSuggestedChangesets,
  countBodySuggestedChangeHints,
  gitHubWebSessionFlowReason,
  hasCodeFence,
} from "./pullRequestCommentDiagnostics";

const CACHE_TTL_MS = 2 * 60 * 1000;
const GITHUB_WEB_SESSION_COMMAND = "gitSimpleCompare.setGitHubWebCookie";

/** TTL 캐시에 저장할 조회 시각과 활성 PR 코멘트 데이터. */
interface PullRequestCommentCacheEntry {
  at: number;
  data?: ActivePullRequestReviewComments;
}

/** 조회를 시작할 때 캡처해 완료 결과가 아직 캐시에 들어갈 수 있는지 판정하는 세대 묶음. */
interface CacheGenerationSnapshot {
  global: number;
  repository: number;
}

/**
 * 저장소/브랜치별 PR review comment 조회를 TTL 캐시와 singleflight 로 감싼다.
 * - 같은 키의 동시 호출은 하나의 원격 Promise 를 공유해 gh/GitHub 요청 중복을 막는다.
 * - 무효화 뒤 늦게 끝난 요청은 호출자에게는 결과를 반환하지만 최신 캐시를 덮어쓰지 않는다.
 */
export class PullRequestCommentCache {
  private readonly cache = new Map<string, PullRequestCommentCacheEntry>();
  private readonly inFlightLoads = new Map<
    string,
    Promise<ActivePullRequestReviewComments | undefined>
  >();
  private readonly repoGenerations = new Map<string, number>();
  private readonly webSessionFlowKeys = new Set<string>();
  private globalGeneration = 0;

  /**
   * @param secrets GitHub 웹 suggested changeset 조회용 Cookie 헤더를 읽을 SecretStorage
   */
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /**
   * 현재 checkout 브랜치의 PR review comment 를 캐시와 함께 읽는다.
   * - 브랜치 이름은 가벼운 로컬 Git 조회로 매번 확인해 checkout 뒤 다른 브랜치 캐시가 섞이지 않게 한다.
   * - 유효한 TTL 항목이 없을 때만 singleflight 원격 조회를 시작한다.
   * @param repoRoot 조회할 Git 저장소 루트
   * @returns 활성 PR 코멘트 데이터. detached HEAD 또는 연결된 PR 이 없으면 undefined
   */
  async load(
    repoRoot: string
  ): Promise<ActivePullRequestReviewComments | undefined> {
    const branchService = new PullRequestReviewCommentService(repoRoot);
    const branch = await branchService.getCurrentBranch();
    if (!branch) {
      return undefined;
    }
    const key = cacheKey(repoRoot, branch);
    const cached = this.freshEntry(key);
    if (cached) {
      return cached.data;
    }
    const pending = this.inFlightLoads.get(key);
    if (pending) {
      return pending;
    }
    const generation = this.generation(repoRoot);
    const load = this.loadUncached(repoRoot, branch, key, generation);
    this.inFlightLoads.set(key, load);
    try {
      return await load;
    } finally {
      // 무효화 뒤 시작된 새 요청을 이전 요청의 finally 가 지우지 않도록 같은 Promise 만 제거한다.
      if (this.inFlightLoads.get(key) === load) {
        this.inFlightLoads.delete(key);
      }
    }
  }

  /**
   * 모든 저장소의 TTL 캐시와 진행 중 요청 연결을 무효화한다.
   * - 실행 중인 네트워크 요청은 강제로 취소하지 않지만 세대를 올려 완료 결과가 캐시에 재진입하지 못하게 한다.
   * - GitHub 웹 쿠키 변경이면 이전 인증 오류 안내 dedupe 도 비워 새 인증 상태를 다시 평가한다.
   * @param reason 인증 변경/사용자 명령처럼 전체 무효화를 일으킨 원인
   */
  invalidate(reason: string): void {
    this.cache.clear();
    this.globalGeneration++;
    this.inFlightLoads.clear();
    if (/githubWebCookie/i.test(reason)) {
      this.webSessionFlowKeys.clear();
    }
    logInfo("pr editor comments cache invalidated", { reason });
  }

  /**
   * 한 저장소의 TTL 캐시와 진행 중 요청 연결만 무효화한다.
   * - 활성 파일 저장처럼 다른 저장소의 PR 데이터에는 영향이 없는 이벤트에서 사용한다.
   * - 저장소 세대를 올려 이미 실행 중이던 이전 결과가 다음 포커스 refresh 캐시를 덮지 않게 한다.
   * @param repoRoot 무효화할 Git 저장소 루트
   */
  invalidateRepository(repoRoot: string): void {
    this.repoGenerations.set(repoRoot, this.repositoryGeneration(repoRoot) + 1);
    this.deleteRepositoryEntries(this.cache, repoRoot);
    this.deleteRepositoryEntries(this.inFlightLoads, repoRoot);
  }

  /**
   * controller 폐기 뒤 완료되는 원격 요청이 캐시를 다시 만들지 못하도록 전체 세대와 참조를 정리한다.
   * - 네트워크 Promise 자체는 Node API 취소 신호를 지원하지 않으므로 자연 완료시키고 결과만 버린다.
   */
  dispose(): void {
    this.globalGeneration++;
    this.cache.clear();
    this.inFlightLoads.clear();
    this.repoGenerations.clear();
    this.webSessionFlowKeys.clear();
  }

  /**
   * 캐시가 없는 저장소/브랜치의 PR 코멘트를 실제로 조회한다.
   * - OAuth token/Cookie 는 suggested changeset HTML 보조 조회에만 전달하며 로그에는 기록하지 않는다.
   * - 시작 세대가 여전히 최신일 때만 결과를 TTL 캐시에 넣어 저장/인증 변경과의 경합을 차단한다.
   * @param repoRoot 조회할 Git 저장소 루트
   * @param branch 현재 checkout 브랜치 이름
   * @param key 저장소와 브랜치를 결합한 캐시 키
   * @param generation 조회 시작 시점의 전체/저장소 세대
   * @returns 활성 PR 코멘트 데이터. 연결된 PR 이 없으면 undefined
   */
  private async loadUncached(
    repoRoot: string,
    branch: string,
    key: string,
    generation: CacheGenerationSnapshot
  ): Promise<ActivePullRequestReviewComments | undefined> {
    const [webAccessToken, webCookie] = await Promise.all([
      readGitHubAuthenticationToken(),
      readStoredGitHubWebCookie(this.secrets),
    ]);
    const service = new PullRequestReviewCommentService(repoRoot, {
      suggestedChangeset: webAccessToken || webCookie
        ? { webAccessToken, webCookie }
        : undefined,
    });
    const data = await service.getActiveBranchReviewComments(branch);
    if (this.isCurrent(repoRoot, generation)) {
      this.cache.set(key, { at: Date.now(), data });
    }
    this.openGitHubWebSessionFlowIfNeeded(
      repoRoot,
      branch,
      data?.suggestedChangesetStatus,
      webCookie
    );
    logLoadedComments(repoRoot, branch, data);
    return data;
  }

  /**
   * GitHub 웹 suggested changeset 보조 조회가 인증 문제로 실패하면 세션 설정 패널을 한 번 연다.
   * - 같은 저장소/브랜치/실패 원인은 dedupe 해 반복 refresh 가 같은 안내 창을 계속 만들지 않게 한다.
   * @param repoRoot 조회 저장소 루트
   * @param branch 현재 브랜치
   * @param status suggested changeset 보조 조회 상태
   * @param webCookie SecretStorage 에 저장된 GitHub 웹 Cookie 헤더
   */
  private openGitHubWebSessionFlowIfNeeded(
    repoRoot: string,
    branch: string,
    status: PullRequestSuggestedChangesetStatus | undefined,
    webCookie: string | undefined
  ): void {
    const reason = gitHubWebSessionFlowReason(status, webCookie);
    if (!reason) {
      return;
    }
    const key = `${repoRoot}\0${branch}\0${reason}`;
    if (this.webSessionFlowKeys.has(key)) {
      return;
    }
    this.webSessionFlowKeys.add(key);
    logInfo("github web session flow requested", {
      repoRoot,
      branch,
      reason,
      suggestedChangesetReason: status?.reason,
    });
    void vscode.commands.executeCommand(GITHUB_WEB_SESSION_COMMAND).then(
      undefined,
      (error) => logInfo("github web session flow failed", {
        repoRoot,
        branch,
        reason,
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }

  /** 현재 전체/저장소 무효화 세대를 조회 시작용 값 객체로 복사한다. */
  private generation(repoRoot: string): CacheGenerationSnapshot {
    return {
      global: this.globalGeneration,
      repository: this.repositoryGeneration(repoRoot),
    };
  }

  /** 조회 시작 세대가 현재도 유효해 완료 결과를 TTL 캐시에 넣어도 되는지 확인한다. */
  private isCurrent(repoRoot: string, generation: CacheGenerationSnapshot): boolean {
    return (
      generation.global === this.globalGeneration &&
      generation.repository === this.repositoryGeneration(repoRoot)
    );
  }

  /** 저장소별 무효화 세대를 반환하며 아직 무효화되지 않은 저장소는 0으로 본다. */
  private repositoryGeneration(repoRoot: string): number {
    return this.repoGenerations.get(repoRoot) ?? 0;
  }

  /**
   * 캐시 키의 항목이 TTL 안에 있으면 그대로 반환하고, 만료됐으면 즉시 제거한다.
   * - data가 undefined인 "활성 PR 없음"도 유효한 음수 캐시이므로 entry 존재 여부로 hit를 구분한다.
   * - 만료 항목을 읽는 순간 제거해 오래 사용한 창에서 브랜치별 빈 결과가 계속 쌓이지 않게 한다.
   * @param key 저장소와 브랜치를 결합한 캐시 키
   * @returns 재사용 가능한 캐시 항목, 없거나 만료됐으면 undefined
   */
  private freshEntry(key: string): PullRequestCommentCacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry || Date.now() - entry.at >= CACHE_TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * repoRoot prefix 를 공유하는 캐시/진행 중 요청 항목을 Map 에서 제거한다.
   * @param entries 저장소/브랜치 복합 키를 가진 Map
   * @param repoRoot 제거할 저장소 루트
   */
  private deleteRepositoryEntries<T>(entries: Map<string, T>, repoRoot: string): void {
    for (const key of Array.from(entries.keys())) {
      if (key.startsWith(`${repoRoot}\0`)) {
        entries.delete(key);
      }
    }
  }
}

/** 저장소/브랜치 조합을 NUL 구분 캐시 키로 만든다. */
function cacheKey(repoRoot: string, branch: string): string {
  return `${repoRoot}\0${branch}`;
}

/**
 * 완료된 PR comment 조회의 크기와 suggested changeset 진단 정보를 OUTPUT 에 남긴다.
 * @param repoRoot 조회 저장소 루트
 * @param branch 조회 브랜치
 * @param data 활성 PR 데이터 또는 PR 없음
 */
function logLoadedComments(
  repoRoot: string,
  branch: string,
  data: ActivePullRequestReviewComments | undefined
): void {
  logInfo("pr editor comments loaded", {
    repoRoot,
    branch,
    pr: data?.number,
    comments: data?.comments.length ?? 0,
    suggestedChangesets: countAttachedSuggestedChangesets(data?.comments || []),
    bodySuggestedChangeHints: countBodySuggestedChangeHints(data?.comments || []),
    webSuggestedChangesets: data?.suggestedChangesetStatus?.changesets ?? 0,
    webSuggestedComments: data?.suggestedChangesetStatus?.comments ?? 0,
    codeSnippets: data?.comments.filter(hasCodeFence).length ?? 0,
    suggestedChangesetSource: data?.suggestedChangesetStatus?.source,
    suggestedChangesetReason: data?.suggestedChangesetStatus?.reason,
  });
}

/**
 * VS Code 가 이미 가진 GitHub authentication session 의 token 을 조용히 읽는다.
 * - createIfNone 를 쓰지 않아 새 로그인/권한 팝업은 띄우지 않는다.
 * - token 값은 GitHub 웹 HTML 조회에만 전달하고 로그에는 남기지 않는다.
 * @returns 사용 가능한 GitHub OAuth token 또는 undefined
 */
async function readGitHubAuthenticationToken(): Promise<string | undefined> {
  try {
    const session = await vscode.authentication.getSession("github", ["repo"], {
      silent: true,
    });
    return session?.accessToken;
  } catch {
    return undefined;
  }
}
