// 브랜치 상태와 첫 이력을 같은 세대에서 병렬 준비하되 채택 전에는 표시·containment를 변경하지 않는다.
import type { GitLogService } from "../git/gitLogService";
import type { Commit, LocalBranchStatus } from "../graph/graphTypes";
import type { GraphRefreshContext } from "./graphRefreshCoordinator";
import type { GraphPageData } from "./graphPageLoading";
import { logInfo } from "../ui/outputLog";
import { logGraphPerformancePhase, type GraphPerformanceTrace } from "./graphPerformance";

export type GraphFirstPageService = Pick<GitLogService, "repoRoot"> & Partial<Pick<GitLogService,
  "readUnindexedCommitPage" | "indexGraphCommitPage" | "usesNativeBranchSnapshot">>;
interface PreparedPage {
  service: GraphFirstPageService; head: string; branch: string; limit: number; controller: AbortController;
  result: Promise<{ data: GraphPageData } | { error: unknown }>;
}
interface PageRead { skip: number; readLimit: number; refs: string[]; readVirtualCommits: boolean; signal?: AbortSignal; trace?: GraphPerformanceTrace; }

/** 첫 페이지 한 건의 선행 조회·취소·검증·채택 수명만 소유한다. 다음 세대에 데이터를 캐시하지 않는다. */
export class GraphFirstPageRead {
  private active?: PreparedPage;

  /**
   * 기본 all-ref reload의 첫 이력을 브랜치 상태와 겹친 뒤, 쓰지 않은 자식도 실제 close까지 회수한다.
   * @param service 현재 저장소 서비스 @param context 새 fingerprint 세대 @param enabled 기본 필터·정상 ref 여부
   * @param limit 기존 첫 페이지와 같은 행 수 @param reload 브랜치·원격 준비와 최종 페이지 게시 작업
   * @returns reload 원본 결과/오류. batch tracking·불확실한 이력·detached 상태는 기존 직렬 경로다.
   */
  async during<T>(service: GraphFirstPageService, context: GraphRefreshContext, enabled: boolean, limit: number,
    reload: () => Promise<T>): Promise<T> {
    const [head, symbolic] = context.fingerprint.split("\n", 2);
    if (!enabled || context.historyUncertain || context.remoteTips === undefined ||
      service.usesNativeBranchSnapshot?.() !== true || !service.readUnindexedCommitPage || !service.indexGraphCommitPage ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head) || !symbolic?.startsWith("refs/heads/")) return reload();
    this.cancel("superseded");
    const controller = new AbortController(), started = Date.now();
    const prepared: PreparedPage = { service, head, branch: symbolic.slice("refs/heads/".length), limit, controller,
      result: service.readUnindexedCommitPage(limit, 0, [], controller.signal)
        .then(page => ({ data: { page, gitLogMs: Date.now() - started } }), error => ({ error })) };
    this.active = prepared;
    logInfo("graph first page prepared", { repoRoot: service.repoRoot, limit, generation: context.generation });
    try { return await reload(); }
    finally {
      if (this.active === prepared) this.cancel("unused");
      await prepared.result;
    }
  }

  /**
   * 같은 서비스·범위의 선행 결과만 한 번 소비한다. 새 HEAD/local ref와 다르면 기존 Git 조회에 맡긴다.
   * @param service 현재 페이지의 서비스 @param options 확정한 읽기 범위와 취소 신호 @param branches 방금 읽은 전체 로컬 상태
   * @returns 채택하고 색인한 페이지. 범위·HEAD·ref가 달라지면 undefined, 같은 조회의 오류는 원래 값으로 전파한다.
   */
  async consume(service: GraphFirstPageService, options: PageRead, branches: readonly LocalBranchStatus[]): Promise<GraphPageData | undefined> {
    const prepared = this.active;
    if (!prepared) return undefined;
    const matches = prepared.service === service && options.skip === 0 && options.readLimit === prepared.limit &&
      !options.refs.length && !options.readVirtualCommits;
    if (!matches || !matchesCheckout(prepared, branches)) {
      this.cancel("scopeOrCheckoutChanged"); await prepared.result; return undefined;
    }
    const result = await prepared.result;
    options.signal?.throwIfAborted();
    if (this.active !== prepared || prepared.controller.signal.aborted) return undefined;
    this.active = undefined;
    if ("error" in result) throw result.error;
    if (!matchesLoadedRefs(result.data.page, prepared.head, branches)) {
      logInfo("graph first page discarded", { repoRoot: service.repoRoot, reason: "localReferencesChanged" });
      return undefined;
    }
    service.indexGraphCommitPage!(result.data.page, 0, []);
    logGraphPerformancePhase(options.trace, "gitLog", result.data.gitLogMs, {
      skip: 0, limit: prepared.limit, fetchedCount: result.data.page.length, refCount: 0, prepared: true });
    logInfo("graph first page adopted", { repoRoot: service.repoRoot, commits: result.data.page.length });
    return result.data;
  }

  /** 숨김·저장소 교체·다른 jump 요청은 소유 controller만 취소한다. during의 finally가 실제 close를 기다린다. */
  cancel(reason: string): void {
    const prepared = this.active;
    if (!prepared) return;
    this.active = undefined; prepared.controller.abort();
    logInfo("graph first page cancelled", { repoRoot: prepared.service.repoRoot, reason });
  }
}

/** 같은 OID의 다른 브랜치나 detached 상태를 채택하지 않도록 native HEAD flag·이름·OID를 함께 확인한다. */
function matchesCheckout(prepared: PreparedPage, branches: readonly LocalBranchStatus[]): boolean {
  const current = branches.filter(branch => branch.current);
  return current.length === 1 && current[0].name === prepared.branch && current[0].hash === prepared.head;
}

/** 첫 범위에 포함된 HEAD 및 로컬 배지가 새 로컬 snapshot과 같아야 화면·containment에 반영한다. */
function matchesLoadedRefs(page: readonly Commit[], head: string, branches: readonly LocalBranchStatus[]): boolean {
  const tips = new Map(branches.map(branch => [branch.name, branch.hash])), byHash = new Map(page.map(commit => [commit.hash, commit]));
  for (const commit of page) for (const ref of commit.refs) {
    if ((ref === "HEAD" && commit.hash !== head) || (tips.has(ref) && tips.get(ref) !== commit.hash)) return false;
  }
  return branches.every(branch => !byHash.has(branch.hash) || byHash.get(branch.hash)!.refs.includes(branch.name));
}
