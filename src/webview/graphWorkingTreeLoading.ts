// 첫 Graph 이력을 막지 않고 작업트리 가상 커밋을 읽는 패널별 수명 관리자.
// - 페이지 조회와 독립된 소비자여서 스크롤이 status를 취소하지 않으며 저장소/세대 전환은 즉시 무효화한다.
import * as vscode from "vscode";
import type { Commit } from "../graph/graphTypes";
import type { GitLogService } from "../git/gitLogService";
import { logError, logInfo } from "../ui/outputLog";
import { graphErrorSummary } from "./graphHealth";
import { logGraphPerformancePhase, type GraphPerformanceTrace } from "./graphPerformance";
import type { GraphWorkingTreeState } from "./graphProtocol";

/** 패널의 현재 저장소/세대를 읽고 완료된 결과와 상태만 게시하는 UI 경계다. */
export interface GraphWorkingTreeLoadingDeps {
  service(): Pick<GitLogService, "repoRoot" | "getVirtualCommits">;
  generation(): number;
  isAlive(): boolean;
  update(commits: Commit[], trace?: GraphPerformanceTrace): void;
  changed(): void;
}

/** 진행 status의 controller와 숨김 뒤 재개 의도를 페이지 수명과 별도로 소유한다. */
export class GraphWorkingTreeLoading {
  private active?: { controller: AbortController; service: ReturnType<GraphWorkingTreeLoadingDeps["service"]>; generation: number };
  private resumePending = false;
  private currentState?: GraphWorkingTreeState;

  /** @param deps 현재 패널만 갱신할 수 있도록 주입하는 저장소/세대/게시 경계 */
  constructor(private readonly deps: GraphWorkingTreeLoadingDeps) {}

  /** @returns 아직 알 수 없는 작업트리 상태를 clean으로 오인하지 않게 하는 로딩/실패 안내 */
  get state(): GraphWorkingTreeState | undefined { return this.currentState; }

  /**
   * 첫 페이지와 동시에 status를 시작하되 완료까지 페이지 Promise를 붙잡지 않는다.
   * @param trace 첫 Graph와 같은 성능 흐름. 취소/실패는 내부에서 처리해 미처리 rejection을 남기지 않는다.
   */
  start(trace?: GraphPerformanceTrace): void {
    this.cancel("superseded");
    const active = { controller: new AbortController(), service: this.deps.service(), generation: this.deps.generation() };
    this.active = active;
    this.currentState = { loading: true, message: vscode.l10n.t("Reading working tree...") };
    const started = Date.now();
    logInfo("graph working tree read started", { repoRoot: active.service.repoRoot, generation: active.generation });
    // 즉시 throw도 비동기 실패와 같은 경로로 처리해 첫 이력 조회를 방해하지 않는다.
    void Promise.resolve().then(() => active.service.getVirtualCommits(active.controller.signal)).then(commits => {
      if (!this.isCurrent(active)) return;
      this.active = undefined;
      this.currentState = undefined;
      logGraphPerformancePhase(trace, "status", Date.now() - started, { virtualCommits: commits.length, background: true });
      this.deps.update(commits, trace);
    }).catch(error => {
      if (!this.isCurrent(active)) return;
      this.active = undefined;
      this.currentState = { loading: false, message: vscode.l10n.t("Working tree status unavailable."),
        detail: vscode.l10n.t("Commit history is available. Check Git Simple Compare Output, then refresh. Reason: {0}", graphErrorSummary(error)) };
      logError("graph working tree read failed", error, { repoRoot: active.service.repoRoot, generation: active.generation, elapsedMs: Date.now() - started });
      this.deps.changed();
    });
  }

  /**
   * 숨김/포커스 해제로 status 소비자만 해제하고, 완료되지 않은 조회를 복귀 때 다시 읽게 한다.
   * @param reason OUTPUT에 기록할 수명 전환 원인. 이미 완료한 상태는 재조회하지 않는다.
   */
  pause(reason: string): void {
    const pending = !!this.active || this.resumePending;
    if (!pending) return;
    this.cancel(reason);
    this.resumePending = pending;
    if (pending) this.currentState = { loading: false, message: vscode.l10n.t("Working tree status paused.") };
  }

  /** 숨김 때 멈춘 status만 현재 세대로 재시작하고, 이미 읽은 Graph 페이지는 보존한다. */
  resume(trace?: GraphPerformanceTrace): void {
    if (!this.resumePending) return;
    this.start(trace);
    this.deps.changed();
  }

  /**
   * 저장소/필터/점프/폐기 때 이전 결과와 재개 의도를 모두 버린다.
   * @param reason 취소 원인. 공유 status의 다른 소비자는 이 controller로 취소되지 않는다.
   */
  cancel(reason: string): void {
    const active = this.active;
    this.active = undefined;
    this.resumePending = false;
    this.currentState = undefined;
    if (!active) return;
    active.controller.abort();
    logInfo("graph working tree read cancelled", { repoRoot: active.service.repoRoot, generation: active.generation, reason });
  }

  /** controller·서비스 객체·세대·패널 수명을 함께 대조해 늦은 상태가 새 화면을 덮지 못하게 한다. */
  private isCurrent(active: NonNullable<GraphWorkingTreeLoading["active"]>): boolean {
    return this.active === active && !active.controller.signal.aborted && this.deps.isAlive() &&
      this.deps.service() === active.service && this.deps.generation() === active.generation;
  }
}
