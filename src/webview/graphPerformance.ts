// Graph extension-host 단계와 webview 실제 paint 응답을 같은 trace로 기록하는 관찰성 모듈.
// - 화면 상태나 Git 로직을 소유하지 않고 시간 필드와 OUTPUT 이벤트만 표준화한다.
import { logError, logInfo } from "../ui/outputLog";
import type { GraphRenderPerformance } from "./graphProtocol";
import type { loadGraphLocalBranchData } from "./graphBranchLoading";

/** 한 Graph reload/pagination 안의 단계들을 묶는 extension-host trace다. */
export interface GraphPerformanceTrace {
  id: string;
  repoRoot: string;
  cause: string;
  generation: number;
  startedAt: number;
}

let nextTraceId = 0;

/**
 * 새 Graph 성능 trace를 열고 시작 상태를 OUTPUT에 기록한다.
 * @param repoRoot 대상 저장소 루트
 * @param cause ready/refresh/filter/pagination 같은 시작 원인
 * @param generation Graph load generation
 * @returns 후속 phase와 webview render metadata에 전달할 trace
 */
export function beginGraphPerformanceTrace(
  repoRoot: string,
  cause: string,
  generation: number
): GraphPerformanceTrace {
  const trace = {
    id: `${Date.now().toString(36)}-${(++nextTraceId).toString(36)}`,
    repoRoot,
    cause,
    generation,
    startedAt: Date.now(),
  };
  logInfo("graph performance start", traceFields(trace));
  return trace;
}

/**
 * extension-host 안의 Git/layout 단계를 공통 필드로 기록한다.
 * @param trace beginGraphPerformanceTrace가 만든 현재 흐름
 * @param phase localBranches/worktrees/status/gitLog/layout 같은 단계명
 * @param elapsedMs 해당 단계 자체의 소요 시간
 * @param fields count/cache source 등 단계별 추가 수치
 */
export function logGraphPerformancePhase(
  trace: GraphPerformanceTrace | undefined,
  phase: string,
  elapsedMs: number,
  fields: Record<string, unknown> = {}
): void {
  if (!trace) return;
  logInfo("graph performance phase", {
    ...traceFields(trace), phase, elapsedMs, totalElapsedMs: Date.now() - trace.startedAt, ...fields,
  });
}

/**
 * 첫 로드의 branch/worktree 조회와 게시 정보를 한 경계에서 기록한다.
 * @param trace 현재 Graph 흐름, data 같은 세대의 로컬 snapshot, reusedWorktrees fingerprint 재사용 여부
 * @param repoRoot 저장소 경계, filterMode 게시한 필터 모드. ref/커밋 원문은 추가로 기록하지 않는다.
 */
export function logGraphBranchSnapshot(
  trace: GraphPerformanceTrace | undefined, data: Awaited<ReturnType<typeof loadGraphLocalBranchData>>,
  reusedWorktrees: boolean, repoRoot: string, filterMode: string
): void {
  const { branches, worktrees, timings } = data;
  logGraphPerformancePhase(trace, "localBranches", timings.localBranchesMs, { count: branches.length });
  logGraphPerformancePhase(trace, "worktrees", timings.worktreesMs, { count: worktrees.length, reused: reusedWorktrees });
  logGraphPerformancePhase(trace, "branchSnapshot", timings.totalMs);
  logInfo("graph branch status sent", {
    repoRoot, branches: branches.length, worktrees: worktrees.length,
    current: branches.find(branch => branch.current)?.name, filterMode,
  });
}

/** extension에서 graph 메시지를 보내기 직전 webview가 되돌려줄 render metadata를 만든다. */
export function createGraphRenderPerformance(
  trace: GraphPerformanceTrace | undefined,
  kind: GraphRenderPerformance["kind"]
): GraphRenderPerformance | undefined {
  return trace ? {
    traceId: trace.id,
    cause: trace.cause,
    kind,
    extensionStartedAt: trace.startedAt,
    sentAt: Date.now(),
  } : undefined;
}

/** VS Code postMessage promise가 메시지를 수락했는지와 extension-side 대기 시간을 기록한다. */
export function logGraphPostMessageResult(
  repoRoot: string,
  performance: GraphRenderPerformance,
  accepted: boolean,
  elapsedMs: number
): void {
  logInfo("graph performance postMessage", {
    repoRoot, traceId: performance.traceId, cause: performance.cause,
    kind: performance.kind, accepted, elapsedMs,
  });
}

/** postMessage promise 자체가 실패한 경우 render trace와 함께 오류를 기록한다. */
export function logGraphPostMessageError(
  repoRoot: string,
  performance: GraphRenderPerformance,
  error: unknown,
  elapsedMs: number
): void {
  logError("graph performance postMessage failed", error, {
    repoRoot, traceId: performance.traceId, cause: performance.cause,
    kind: performance.kind, elapsedMs,
  });
}

/** webview가 DOM render 뒤 두 번째 frame에서 보낸 시각을 단계별 지연으로 분해해 기록한다. */
export function logGraphWebviewPaint(
  repoRoot: string,
  message: {
    performance: GraphRenderPerformance;
    receivedAt: number;
    renderedAt: number;
    paintedAt: number;
  }
): void {
  const { performance, receivedAt, renderedAt, paintedAt } = message;
  logInfo("graph performance webview paint", {
    repoRoot,
    traceId: performance.traceId,
    cause: performance.cause,
    kind: performance.kind,
    transportMs: Math.max(0, receivedAt - performance.sentAt),
    renderMs: Math.max(0, renderedAt - receivedAt),
    frameMs: Math.max(0, paintedAt - renderedAt),
    totalMs: Math.max(0, paintedAt - performance.extensionStartedAt),
  });
}

/** 모든 performance 이벤트가 공유하는 repository/trace/cause/generation 필드를 만든다. */
function traceFields(trace: GraphPerformanceTrace): Record<string, unknown> {
  return {
    repoRoot: trace.repoRoot,
    traceId: trace.id,
    cause: trace.cause,
    generation: trace.generation,
  };
}
