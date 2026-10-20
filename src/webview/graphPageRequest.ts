// 한 페이지의 요청 계획·게시 순서를 패널 생애주기와 분리한다. Git 접근은 주입한 읽기 경계에 위임한다.
import type { Commit } from "../graph/graphTypes";
import type { ResolvedGraphBranchFilter } from "./graphBranchFilter";
import { filterCommitRefs } from "./graphBranchFilter";
import { graphPageRange, graphPageSkipReason, integrateGraphPage, type GraphPageData, type GraphPageProgress } from "./graphPageLoading";
import type { GraphLoadDirection } from "./graphProtocol";
import type { GraphPerformanceTrace } from "./graphPerformance";
import { offerCommitGraphIfSlow } from "../ui/commitGraphOffer";
import { logInfo } from "../ui/outputLog";

/** 요청 시작 당시의 범위와 같은 세대에서 게시할 때 필요한 효과 경계다. */
export interface GraphPageRequest {
  repoRoot: string;
  reset: boolean;
  direction: GraphLoadDirection;
  pageSize: number;
  loading: boolean;
  reconcile: boolean;
  progress: GraphPageProgress;
  filter: ResolvedGraphBranchFilter;
  trace?: GraphPerformanceTrace;
  current(): boolean;
  read(skip: number, limit: number): Promise<GraphPageData | undefined>;
  state(): void;
  empty(): void;
  begin(progress: GraphPageProgress): void;
  accept(progress: GraphPageProgress): void;
  failed(): void;
  stale(): void;
}

/**
 * 기존 페이지 범위를 계산하고 Native 결과를 같은 세대에 한 번만 적용한다.
 * @param request 시작 snapshot, 소유 읽기와 게시 효과. caller만 실제 panel 상태를 변경한다.
 * @returns 게시 또는 생략 후 완료. 조회 오류는 cleanup 뒤 원래 값으로 전파한다.
 */
export async function executeGraphPageRequest(request: GraphPageRequest): Promise<void> {
  const { reset, direction, pageSize, repoRoot, filter } = request, started = Date.now();
  const reason = graphPageSkipReason({ reset, direction, loading: request.loading,
    exhausted: request.progress.exhausted, rangeStartIndex: request.progress.rangeStartIndex });
  if (reason) {
    logInfo("graph page load skipped", { repoRoot, direction, reason }); request.state(); return;
  }
  if (filter.empty) { request.empty(); return; }
  const progress = reset ? { ...request.progress, rangeStartIndex: 0, rangeTotalCount: undefined, exhausted: false } : request.progress;
  const reconcile = !reset && request.reconcile;
  const { skip, readLimit } = reconcile ? { skip: 0, readLimit: progress.commits.length + pageSize + 1 }
    : graphPageRange(direction, progress.rangeStartIndex, progress.commits.length, pageSize);
  if (readLimit <= 0) { request.state(); return; }
  request.begin(progress);
  logInfo("graph page load started", { repoRoot, direction, skip, limit: readLimit, filterMode: filter.mode, refCount: filter.refs.length });
  let published = false;
  try {
    const data = await request.read(skip, readLimit);
    if (!data) return;
    if (!request.current()) {
      request.stale(); logInfo("graph page load ignored", { reason: "staleGeneration", skip, limit: pageSize }); return;
    }
    if (reset) void offerCommitGraphIfSlow(repoRoot, data.gitLogMs);
    const page = direction === "older" ? data.page.slice(0, reconcile ? readLimit - 1 : pageSize) : data.page;
    const commits: Commit[] = filterCommitRefs(page, filter);
    const next = integrateGraphPage(progress, commits, skip, direction, data.page.length > (reconcile ? readLimit - 1 : pageSize), reconcile);
    request.accept(next); published = true;
    logInfo("graph page load finished", { direction, fetchedCount: commits.length, loadedCount: next.commits.length,
      rangeStartIndex: next.rangeStartIndex, hasMore: !next.exhausted, hasMoreBefore: next.rangeStartIndex > 0, elapsed: Date.now() - started });
  } finally { if (!published && request.current()) request.failed(); }
}
