// Graph 브랜치 카탈로그의 local-first hydration 순서를 조정하는 모듈.
import { GraphBranchCatalog } from "../git/graphBranchCatalog";
import type { GraphRemoteBranchTip } from "../git/graphBranchCatalog";
import type { Commit, LocalBranchStatus, WorktreeBranchStatus } from "../graph/graphTypes";
import { logError, logInfo } from "../ui/outputLog";
import { buildBranchFilterSnapshot, resolveBranchFilter } from "./graphBranchFilter";
import type { GraphBranchFilterSnapshot, GraphBranchFilterState, GraphBranchRef, ResolvedGraphBranchFilter } from "./graphBranchFilter";

/** local-first 브랜치 hydration이 패널에 제공하는 현재 상태다. */
export type GraphRemoteCatalogStatus = "pending" | "ready" | "error";

/** 원격 hydration 완료 시 패널이 현재 세대만 재조정하도록 받는 콜백이다. */
export interface GraphBranchLoadingCallbacks {
  onRemoteReady: (branches: GraphRemoteBranchTip[], generation: number) => Promise<void>;
  onRemoteFailed: (error: unknown, generation: number) => void;
}

/** repository/generation 취소를 소유해 늦은 remote 결과가 UI를 덮어쓰지 않게 한다. */
export class GraphBranchLoadingCoordinator {
  private controller: AbortController | undefined;
  private generation = 0;
  private repoRoot = "";

  constructor(private readonly catalog = new GraphBranchCatalog()) {}

  /** 새 local-first reload의 세대를 열고 이전 remote read를 취소한다. */
  begin(repoRoot: string): number {
    this.cancel("supersede");
    this.repoRoot = repoRoot;
    this.generation++;
    logInfo("graph remote branches defer", { repoRoot, generation: this.generation });
    return this.generation;
  }

  /** 첫 graph post 뒤 원격 ref를 비차단으로 시작한다. */
  deferRemote(repoRoot: string, generation: number, callbacks: GraphBranchLoadingCallbacks, canStart: () => boolean): void {
    queueMicrotask(() => {
      if (generation !== this.generation || repoRoot !== this.repoRoot || !canStart()) {
        logInfo("graph remote branches defer", { repoRoot, generation, reason: "inactiveOrStale" });
        return;
      }
      const controller = new AbortController();
      this.controller = controller;
      const started = Date.now();
      logInfo("graph remote branches start", { repoRoot, generation });
      void this.catalog.getRemoteTips(repoRoot, controller.signal).then(async (branches) => {
        if (generation !== this.generation || repoRoot !== this.repoRoot) return;
        logInfo("graph remote branches complete", { repoRoot, generation, count: branches.length, elapsed: Date.now() - started });
        await callbacks.onRemoteReady(branches, generation);
      }).catch((error) => {
        if (controller.signal.aborted || generation !== this.generation || repoRoot !== this.repoRoot) return;
        logError("graph remote branches fail", error, { repoRoot, generation, elapsed: Date.now() - started });
        callbacks.onRemoteFailed(error, generation);
      });
    });
  }

  /** 숨김/처분/새 reload의 이전 read를 중단하고 세대를 무효화한다. */
  cancel(reason: string): void {
    const controller = this.controller;
    this.controller = undefined;
    this.generation++;
    if (!controller) {
      logInfo("graph remote branches cancel", { repoRoot: this.repoRoot, generation: this.generation, reason, queued: true });
      return;
    }
    controller.abort();
    logInfo("graph remote branches cancel", { repoRoot: this.repoRoot, generation: this.generation, reason });
  }

  /** ref epoch를 올려 fetch/checkout 뒤 이전 common-dir 성공 결과가 재사용되지 못하게 한다. */
  invalidateCatalog(repoRoot: string): void { this.catalog.invalidate(repoRoot); }
}

/** local branch/worktree/ref 조회를 병렬 실행해 첫 Graph 렌더에 필요한 snapshot 재료를 만든다. */
export async function loadGraphLocalBranchData(
  repoRoot: string,
  getLocalBranches: () => Promise<LocalBranchStatus[]>,
  getWorktrees: () => Promise<WorktreeBranchStatus[]>
): Promise<{ branches: LocalBranchStatus[]; refs: GraphBranchRef[]; worktrees: WorktreeBranchStatus[] }> {
  const [branches, worktrees] = await Promise.all([
    getLocalBranches(), getWorktrees().catch((error) => {
      logError("graph worktree status failed", error, { repoRoot });
      return [];
    }),
  ]);
  return { branches, refs: branches.map((branch) => ({ name: branch.name, kind: "local" as const })), worktrees };
}

/** 현재 상태를 웹뷰가 즉시 그릴 수 있는 branch-filter 메시지 payload로 만든다. */
export function createGraphBranchFilterSnapshot(
  refs: readonly GraphBranchRef[], branches: readonly LocalBranchStatus[], state: GraphBranchFilterState,
  remoteStatus: GraphRemoteCatalogStatus, remoteError?: string
): GraphBranchFilterSnapshot {
  return buildBranchFilterSnapshot(refs, branches, state, remoteStatus, remoteError);
}

/** local/remote ref를 이름 기준으로 합쳐 중복 없는 카탈로그를 만든다. */
export function mergeGraphBranchRefs(local: readonly GraphBranchRef[], remote: readonly GraphBranchRef[]): GraphBranchRef[] {
  const result = new Map<string, GraphBranchRef>();
  for (const branch of [...local, ...remote]) result.set(branch.name, branch);
  return [...result.values()];
}

/** hydration 전후 git-log ref 범위가 변경되어 재조정이 필요한지 판정한다. */
export function graphBranchFilterNeedsReconcile(
  previous: ResolvedGraphBranchFilter, next: ResolvedGraphBranchFilter
): boolean {
  return previous.filtersRefs !== next.filtersRefs || previous.refs.length !== next.refs.length || previous.refs.some((ref, index) => ref !== next.refs[index]);
}

/** panel state를 현재 remote hydration 상태까지 반영한 log filter로 해석한다. */
export function resolveGraphBranchFilter(
  state: GraphBranchFilterState, refs: readonly GraphBranchRef[], remoteStatus: GraphRemoteCatalogStatus
): ResolvedGraphBranchFilter {
  return resolveBranchFilter(state, refs, remoteStatus);
}

/** checkout 뒤 기존 Graph 페이지를 재사용할 수 있는지 판정하고 virtual commit 갱신을 수행한다. */
export async function refreshGraphCheckout(
  repoRoot: string, commits: Commit[], branches: LocalBranchStatus[], visibleRefs: Set<string>,
  syncLocalRefs: (commits: Commit[], branches: LocalBranchStatus[], visibleRefs: Set<string>) => boolean,
  getVirtualCommits: () => Promise<Commit[]>
): Promise<{ reused: boolean; virtualCommits: Commit[] }> {
  if (!syncLocalRefs(commits, branches, visibleRefs)) return { reused: false, virtualCommits: [] };
  const virtualCommits = await getVirtualCommits();
  logInfo("graph checkout refresh finished", { repoRoot, loadedCount: commits.length });
  return { reused: true, virtualCommits };
}

/**
 * 비동기 page 결과가 시작 당시 service와 현재 panel 세대에 모두 속하는지 순수하게 판정한다.
 * @param initiatingService page를 시작한 service identity
 * @param currentService panel이 현재 가리키는 service identity
 * @param generation page 시작 generation
 * @param currentGeneration panel의 현재 generation
 * @param disposed panel dispose 여부
 * @returns 결과를 UI/cache에 적용해도 안전하면 true
 */
export function isCurrentGraphLoad<T>(initiatingService: T, currentService: T, generation: number, currentGeneration: number, disposed: boolean): boolean {
  return !disposed && initiatingService === currentService && generation === currentGeneration;
}

/** 지연된 Graph page 결과를 현재 service/generation에만 적용하는 lifecycle 의존성이다. */
export interface DeferredGraphPageLifecycle<T> {
  initiatingService: T;
  currentService: () => T;
  generation: number;
  currentGeneration: () => number;
  disposed: () => boolean;
  page: () => Promise<void>;
  cancelInitiating: (service: T) => void;
  postPage: () => void;
  postLoadState: () => void;
}

/**
 * 지연 page의 성공/실패 뒤 stale service에 post 또는 finally loading-state가 새지 않게 결정한다.
 * - panel의 service identity/generation/dispose guard와 같은 순서를 단위 테스트에서 결정적으로 재현한다.
 * @param lifecycle 시작 service, 비동기 page, 현재 상태 조회와 효과 callback을 묶은 의존성
 * @returns page 성공/실패를 처리한 Promise. page 오류는 caller가 기존 오류 정책으로 처리할 수 있게 다시 던진다.
 */
export async function settleDeferredGraphPage<T>(lifecycle: DeferredGraphPageLifecycle<T>): Promise<void> {
  const isCurrent = () => isCurrentGraphLoad(lifecycle.initiatingService, lifecycle.currentService(), lifecycle.generation, lifecycle.currentGeneration(), lifecycle.disposed());
  try {
    await lifecycle.page();
    if (!isCurrent()) { lifecycle.cancelInitiating(lifecycle.initiatingService); return; }
    lifecycle.postPage();
  } finally {
    if (isCurrent()) lifecycle.postLoadState();
  }
}
