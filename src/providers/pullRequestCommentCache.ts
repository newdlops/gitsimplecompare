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
const MAX_HISTORICAL_CACHE_ENTRIES = 7;
const MAX_HISTORICAL_CACHE_WEIGHT = 4_194_304;
const GITHUB_WEB_SESSION_COMMAND = "gitSimpleCompare.setGitHubWebCookie";

/** TTL 캐시에 저장할 조회 시각과 활성 PR 코멘트 데이터. */
interface PullRequestCommentCacheEntry {
  at: number;
  weight: number;
  data?: ActivePullRequestReviewComments;
}

/** 완료 캐시 정책의 시간과 한계를 테스트에서만 결정적으로 바꾸는 내부 주입값. */
interface PullRequestCommentCacheOptions {
  now?: () => number;
  ttlMs?: number;
  maxHistoricalEntries?: number;
  maxHistoricalWeight?: number;
}

/** 여러 캐시 항목을 한 번에 해제할 때 민감한 데이터 없이 남길 집계값. */
interface CacheReleaseSummary {
  removed: number;
  weight: number;
}

/** 조회를 시작할 때 캡처해 완료 결과가 아직 캐시에 들어갈 수 있는지 판정하는 세대 묶음. */
interface CacheGenerationSnapshot {
  global: number;
  repository: number;
}

/** 같은 저장소/브랜치 원격 조회를 공유할 때 취소까지 함께 관리하는 묶음. */
interface PullRequestCommentInFlight {
  controller: AbortController;
  promise: Promise<ActivePullRequestReviewComments | undefined>;
}

/**
 * 저장소/브랜치별 PR review comment 조회를 TTL 캐시와 singleflight 로 감싼다.
 * - 같은 키의 동시 호출은 하나의 원격 Promise 를 공유해 gh/GitHub 요청 중복을 막는다.
 * - 무효화 뒤 늦게 끝난 요청은 호출자에게는 결과를 반환하지만 최신 캐시를 덮어쓰지 않는다.
 */
export class PullRequestCommentCache {
  private readonly cache = new Map<string, PullRequestCommentCacheEntry>();
  private readonly inFlightLoads = new Map<string, PullRequestCommentInFlight>();
  private readonly repoGenerations = new Map<string, number>();
  private readonly webSessionFlowKeys = new Set<string>();
  private activeKey: string | undefined;
  private globalGeneration = 0;

  /**
   * @param secrets GitHub 웹 suggested changeset 조회용 Cookie 헤더를 읽을 SecretStorage
   * @param options 완료 캐시 한계 검증에만 쓰는 시간/한계 주입값. 운영에서는 고정 정책을 사용한다.
   */
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly options: PullRequestCommentCacheOptions = {}
  ) {}

  /**
   * 현재 checkout 브랜치의 PR review comment 를 캐시와 함께 읽는다.
   * - 브랜치 이름은 가벼운 로컬 Git 조회로 매번 확인해 checkout 뒤 다른 브랜치 캐시가 섞이지 않게 한다.
   * - 유효한 TTL 항목이 없을 때만 singleflight 원격 조회를 시작한다.
   * @param repoRoot 조회할 Git 저장소 루트
   * @returns 활성 PR 코멘트 데이터. detached HEAD 또는 연결된 PR 이 없으면 undefined
   */
  async load(
    repoRoot: string,
    signal?: AbortSignal
  ): Promise<ActivePullRequestReviewComments | undefined> {
    this.sweepExpiredEntries();
    const branchService = new PullRequestReviewCommentService(repoRoot);
    const branch = await branchService.getCurrentBranch();
    if (!branch) {
      return undefined;
    }
    const key = cacheKey(repoRoot, branch);
    const cached = this.freshEntry(key);
    if (cached) {
      logInfo("pr editor comments cache hit", { repoRoot, branch });
      return cached.data;
    }
    const pending = this.inFlightLoads.get(key);
    if (pending) {
      logInfo("pr editor comments cache coalesced", { repoRoot, branch });
      return pending.promise;
    }
    const generation = this.generation(repoRoot);
    const controller = new AbortController();
    const removeAbortListener = forwardAbort(signal, controller);
    const load = this.loadUncached(repoRoot, branch, key, generation, controller.signal)
      .finally(removeAbortListener);
    const pendingLoad = { controller, promise: load };
    this.inFlightLoads.set(key, pendingLoad);
    logInfo("pr editor comments load started", { repoRoot, branch });
    try {
      return await load;
    } finally {
      // 무효화 뒤 시작된 새 요청을 이전 요청의 finally 가 지우지 않도록 같은 Promise 만 제거한다.
      if (this.inFlightLoads.get(key) === pendingLoad) {
        this.inFlightLoads.delete(key);
      }
    }
  }

  /**
   * 모든 저장소의 TTL 캐시와 진행 중 요청 연결을 무효화한다.
   * - 실행 중인 네트워크 요청도 취소하고 세대를 올려 늦은 결과가 캐시에 재진입하지 못하게 한다.
   * - GitHub 웹 쿠키 변경이면 이전 인증 오류 안내 dedupe 도 비워 새 인증 상태를 다시 평가한다.
   * @param reason 인증 변경/사용자 명령처럼 전체 무효화를 일으킨 원인
   */
  invalidate(reason: string): void {
    this.cancel(reason);
    this.releaseEntries(Array.from(this.cache.keys()), "invalidate");
    this.activeKey = undefined;
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
    const keys = this.repositoryKeys(this.cache, repoRoot);
    this.releaseEntries(keys, "invalidateRepository");
    if (this.activeKey && keys.includes(this.activeKey)) {
      this.activeKey = undefined;
    }
    for (const key of this.repositoryKeys(this.inFlightLoads, repoRoot)) {
      this.inFlightLoads.get(key)?.controller.abort();
      this.inFlightLoads.delete(key);
    }
  }

  /** 진행 중인 gh/HTTPS 조회를 취소해 오래된 editor 결과가 캐시·세션 안내로 이어지지 않게 한다. */
  cancel(reason: string): void {
    for (const pending of this.inFlightLoads.values()) {
      pending.controller.abort();
    }
    this.inFlightLoads.clear();
    logInfo("pr editor comments load cancelled", { reason });
  }

  /**
   * controller 폐기 뒤 완료되는 원격 요청이 캐시를 다시 만들지 못하도록 전체 세대와 참조를 정리한다.
   * - gh/HTTPS 작업에는 AbortSignal을 전달해 자연 완료를 기다리지 않고 즉시 중단한다.
   */
  dispose(): void {
    this.cancel("dispose");
    this.globalGeneration++;
    this.releaseEntries(Array.from(this.cache.keys()), "dispose");
    this.activeKey = undefined;
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
    generation: CacheGenerationSnapshot,
    signal: AbortSignal
  ): Promise<ActivePullRequestReviewComments | undefined> {
    const [webAccessToken, webCookie] = await Promise.all([
      readGitHubAuthenticationToken(),
      readStoredGitHubWebCookie(this.secrets),
    ]);
    const service = new PullRequestReviewCommentService(repoRoot, {
      suggestedChangeset: webAccessToken || webCookie
        ? { webAccessToken, webCookie }
        : undefined,
      signal,
    });
    const data = await service.getActiveBranchReviewComments(branch);
    throwIfAborted(signal);
    if (this.isCurrent(repoRoot, generation)) {
      this.storeCompletedEntry(key, data);
    }
    if (!signal.aborted && this.isCurrent(repoRoot, generation)) {
      this.openGitHubWebSessionFlowIfNeeded(
        repoRoot,
        branch,
        data?.suggestedChangesetStatus,
        webCookie
      );
    }
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
   * 캐시 키의 이미 sweep 된 유효 항목을 반환하고 Map 끝으로 옮겨 LRU와 활성 결과를 갱신한다.
   * - data가 undefined인 "활성 PR 없음"도 유효한 음수 캐시이므로 entry 존재 여부로 hit를 구분한다.
   * @param key 저장소와 브랜치를 결합한 캐시 키
   * @returns 재사용 가능한 캐시 항목, 없으면 undefined
   */
  private freshEntry(key: string): PullRequestCommentCacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.activeKey = key;
    this.pruneHistoricalEntries();
    return entry;
  }

  /**
   * 원격 조회에 성공한 전체 데이터를 보존한 채 완료 캐시에 저장하고 활성/과거 보존 한계를 적용한다.
   * @param key 저장소와 브랜치를 결합한 캐시 키
   * @param data 축약하거나 변형하면 안 되는 활성 PR 코멘트 전체 데이터
   */
  private storeCompletedEntry(key: string, data: ActivePullRequestReviewComments | undefined): void {
    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), weight: cacheEntryWeight(key, data), data });
    this.activeKey = key;
    this.pruneHistoricalEntries();
  }

  /**
   * 모든 완료 항목을 먼저 검사해 TTL 이 지난 결과를 한 줄 로그로 묶어 제거한다.
   * - load 시작마다 전체 sweep 하므로 오래 접근하지 않은 브랜치 결과도 메모리에 남지 않는다.
   * @returns 제거한 항목 수와 UTF-16 문자열 payload 합계
   */
  private sweepExpiredEntries(): CacheReleaseSummary {
    const now = this.now();
    const expired = Array.from(this.cache.entries())
      .filter(([, entry]) => now - entry.at >= this.ttlMs())
      .map(([key]) => key);
    const summary = this.releaseEntries(expired, "expiry");
    if (this.activeKey && expired.includes(this.activeKey)) {
      this.activeKey = undefined;
    }
    return summary;
  }

  /**
   * 활성 1건을 제외한 과거 결과를 LRU 순서로 7건과 4 Mi UTF-16 code unit 이하로 줄인다.
   * - 활성 결과가 단독 한계를 넘더라도 유지하지만, 다른 키가 활성화되면 과거 항목으로 즉시 퇴거한다.
   * @returns 제거한 과거 결과 수와 UTF-16 문자열 payload 합계
   */
  private pruneHistoricalEntries(): CacheReleaseSummary {
    const historical = Array.from(this.cache.entries())
      .filter(([key]) => key !== this.activeKey);
    const maxWeight = this.maxHistoricalWeight();
    let totalWeight = historical.reduce((total, [, entry]) => total + entry.weight, 0);
    const evicted: string[] = [];
    while (
      historical.length - evicted.length > this.maxHistoricalEntries() ||
      totalWeight > maxWeight
    ) {
      const [key, entry] = historical[evicted.length];
      evicted.push(key);
      totalWeight -= entry.weight;
    }
    const reason = evicted.some((key) => (this.cache.get(key)?.weight ?? 0) > maxWeight)
      ? "oversizeRelease"
      : "eviction";
    return this.releaseEntries(evicted, reason);
  }

  /**
   * 지정한 완료 캐시 키를 제거하고 제거 건수·payload·잔여 건수만 OUTPUT 에 집계 기록한다.
   * @param keys 제거할 캐시 키 목록
   * @param reason expiry/eviction/dispose 등 메모리 해제 원인
   * @returns 실제 제거된 항목 수와 UTF-16 문자열 payload 합계
   */
  private releaseEntries(keys: readonly string[], reason: string): CacheReleaseSummary {
    const summary: CacheReleaseSummary = { removed: 0, weight: 0 };
    for (const key of keys) {
      const entry = this.cache.get(key);
      if (!entry) continue;
      this.cache.delete(key);
      summary.removed++;
      summary.weight += entry.weight;
    }
    if (summary.removed) {
      logInfo("pr editor comments cache entries released", {
        reason,
        removed: summary.removed,
        payload: summary.weight,
        remaining: this.cache.size,
      });
    }
    return summary;
  }

  /**
   * repoRoot prefix 를 공유하는 캐시/진행 중 요청 키를 복사해 안전하게 순회할 목록으로 만든다.
   * @param entries 저장소/브랜치 복합 키를 가진 Map
   * @param repoRoot 찾을 Git 저장소 루트
   * @returns 해당 저장소에 속하는 복합 캐시 키 목록
   */
  private repositoryKeys<T>(entries: Map<string, T>, repoRoot: string): string[] {
    return Array.from(entries.keys()).filter((key) => key.startsWith(`${repoRoot}\0`));
  }

  /**
   * 완료 캐시에 사용할 현재 시각을 주입 clock 또는 실제 시계에서 읽는다.
   * @returns TTL 비교에 사용할 Unix epoch 밀리초
   */
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * 운영 TTL 2분을 유지하면서 테스트에서만 만료 경계를 고정할 수 있게 반환한다.
   * @returns 완료 결과가 유효한 밀리초 기간
   */
  private ttlMs(): number {
    return this.options.ttlMs ?? CACHE_TTL_MS;
  }

  /**
   * 운영 과거 항목 상한 7건을 유지하면서 테스트에서만 작은 LRU 경계를 사용할 수 있게 반환한다.
   * @returns 활성 결과를 제외하고 보존할 최대 완료 항목 수
   */
  private maxHistoricalEntries(): number {
    return this.options.maxHistoricalEntries ?? MAX_HISTORICAL_CACHE_ENTRIES;
  }

  /**
   * 운영 payload 상한 4 Mi UTF-16 code units를 유지하면서 테스트에서만 작은 경계를 사용할 수 있게 반환한다.
   * @returns 과거 완료 결과 문자열 payload 의 최대 UTF-16 code unit 수
   */
  private maxHistoricalWeight(): number {
    return this.options.maxHistoricalWeight ?? MAX_HISTORICAL_CACHE_WEIGHT;
  }
}

/**
 * 캐시 키와 PR 결과의 모든 중첩 문자열을 UTF-16 code unit 단위로 합산한다.
 * - 본문·HTML·diff·suggested changeset 을 복사하거나 자르지 않고, 보존 정책 판단에만 길이를 사용한다.
 * @param key 저장소/브랜치 복합 캐시 키
 * @param data 보존할 전체 PR 결과
 * @returns 키와 모든 중첩 문자열 payload 의 UTF-16 code unit 합계
 */
function cacheEntryWeight(key: string, data: ActivePullRequestReviewComments | undefined): number {
  return key.length + nestedStringWeight(data, new WeakSet<object>());
}

/**
 * 임의의 API 결과 객체를 순회해 문자열 필드의 UTF-16 길이를 결정적으로 합산한다.
 * - 순환 참조와 공유 객체는 한 번만 방문해 비정상 응답이 캐시 정책을 무한 순회하지 못하게 한다.
 * @param value 합산할 API 결과 일부
 * @param visited 이미 순회한 객체 집합
 * @returns value 아래 문자열 필드의 UTF-16 code unit 합계
 */
function nestedStringWeight(value: unknown, visited: WeakSet<object>): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (!value || typeof value !== "object" || visited.has(value)) {
    return 0;
  }
  visited.add(value);
  return Object.keys(value)
    .sort()
    .reduce((total, key) => total + nestedStringWeight(
      (value as Record<string, unknown>)[key],
      visited
    ), 0);
}

/** 호출자 신호를 singleflight 요청 소유자에 전달하고 등록 해제 함수를 반환한다. */
function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

/** 취소된 요청이 음수 캐시나 GitHub 웹 세션 안내로 처리되지 않게 한다. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("PR review comment request was cancelled.", "AbortError");
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
