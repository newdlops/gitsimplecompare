// 여러 native conflict 문서의 외부 해결 갱신을 묶고 최신 session에만 결과를 게시한다.
// - 작업트리/attributes 읽기와 index 재검증은 Git 서비스가 수행하며 mutation fence는 변경하지 않는다.
import type { ConflictWorkingResult } from "../git/conflictContentService";
import type { TrustedConflictEditorSession as Session } from "./conflictEditorOverlayController";
import { PriorityReadQueue } from "../utils/priorityReadQueue";
import { logError, logInfo } from "../ui/outputLog";

interface Host {
  isCurrent(session: Session): boolean;
  isVisible(session: Session): boolean;
  publish(session: Session, result: ConflictWorkingResult, reason: string): void;
  markResolved(session: Session, reason: string): void;
  refreshUnresolved(session: Session, reason: string): void;
}
interface Target { session: Session; generation: number }
interface Request { targets: Target[]; reason: string }
interface RootRead { next?: Request; current?: Request; controller?: AbortController; promise: Promise<void> }
const BACKGROUND_BATCH_SIZE = 16;

/** 보이는 문서는 먼저, 숨겨진 문서는 16개씩 묶고 최대 두 묶음만 동시에 조회한다. */
export class ConflictResolvedRefreshCoordinator {
  private readonly roots = new Map<string, RootRead>();
  private readonly queue = new PriorityReadQueue(2);
  private disposed = false;

  constructor(private readonly host: Host) {}

  /**
   * 같은 저장소의 연속 갱신은 이전 읽기를 취소하고 최신 요청 하나만 남긴다.
   * @param root 현재 ConflictsController snapshot의 저장소
   * @param sessions 해당 snapshot에서 충돌이 사라진 열린 session들
   * @returns 이번 저장소의 최신 갱신까지 끝나면 완료된다. 문서별 오류는 OUTPUT에 기록한다.
   */
  refresh(root: string, sessions: readonly Session[], reason: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const targets = sessions.filter(session => session.service.repoRoot === root)
      .map(session => ({ session, generation: session.refreshGeneration }));
    const previous = this.roots.get(root);
    if (previous) {
      previous.next = targets.length ? { targets, reason } : undefined;
      previous.controller?.abort();
      return previous.promise;
    }
    if (!targets.length) return Promise.resolve();
    const state: RootRead = { next: { targets, reason }, promise: Promise.resolve() };
    state.promise = Promise.resolve().then(async () => {
      try {
        while (state.next && !this.disposed) {
          const request = state.next; state.next = undefined;
          state.current = request;
          const controller = new AbortController(); state.controller = controller;
          try { await this.read(root, request, controller.signal); }
          finally { controller.abort(); if (state.controller === controller) { state.controller = undefined; state.current = undefined; } }
        }
      } finally { if (this.roots.get(root) === state) this.roots.delete(root); }
    });
    this.roots.set(root, state);
    return state.promise;
  }

  /** 닫힘/merge 전환으로 불필요해진 문서를 제거하고 마지막 소비자가 사라지면 실행 중 IO도 중단한다. */
  cancel(session: Session): void {
    session.refreshGeneration++;
    const state = this.roots.get(session.service.repoRoot);
    if (!state) return;
    if (state.next) {
      state.next.targets = state.next.targets.filter(target => target.session !== session);
      if (!state.next.targets.length) state.next = undefined;
    }
    if (state.current) {
      state.current.targets = state.current.targets.filter(target => target.session !== session);
      if (!state.current.targets.some(target => this.canPublish(target))) state.controller?.abort();
    }
  }

  /** 종료 뒤 남은 읽기/예약을 취소한다. 실제 파일 쓰기나 index 변경은 수행하지 않는다. */
  dispose(): void {
    this.disposed = true;
    for (const state of this.roots.values()) { state.next = undefined; state.controller?.abort(); }
    this.roots.clear();
  }

  /** 현재 화면은 별도 작은 묶음으로 보내 큰 숨겨진 파일을 모두 기다리지 않게 한다. */
  private async read(root: string, request: Request, signal: AbortSignal): Promise<void> {
    const targets = request.targets.filter(target => this.canPublish(target));
    const visible = targets.filter(target => this.host.isVisible(target.session));
    const hidden = targets.filter(target => !this.host.isVisible(target.session));
    const batches: Target[][] = [];
    if (visible.length) batches.push(visible);
    for (let index = 0; index < hidden.length; index += BACKGROUND_BATCH_SIZE) batches.push(hidden.slice(index, index + BACKGROUND_BATCH_SIZE));
    const started = Date.now();
    await Promise.all(batches.map(batch => this.queue.run(
      () => this.readBatch(batch, request.reason, signal), signal,
      () => batch.some(target => this.host.isVisible(target.session)) ? 0 : 1
    ).catch(error => {
      if (!signal.aborted) logError("native conflict resolved batch refresh failed", error, { repoRoot: root, files: batch.length });
    })));
    logInfo("native conflict resolved refresh finished", { repoRoot: root, files: targets.length,
      batches: batches.length, cancelled: signal.aborted, elapsedMs: Date.now() - started });
  }

  /**
   * Result들을 읽은 다음 실제 index를 한 번 더 확인하고 current generation에만 게시한다.
   * - 일괄 해결 알림 뒤 새 충돌이 생긴 파일은 resolved로 표시하지 않고 원본을 다시 읽는다.
   * - 한 파일의 IO 실패/close/재열기/typing은 다른 문서의 게시를 막지 않는다.
   */
  private async readBatch(batch: Target[], reason: string, signal: AbortSignal): Promise<void> {
    const targets = batch.filter(target => this.canPublish(target));
    if (!targets.length) return;
    const service = targets[0].session.service;
    const results = await service.getWorkingResults(targets.map(target => target.session.rel), true, signal);
    signal.throwIfAborted();
    if (!targets.some(target => this.canPublish(target))) return;
    const conflicts = new Set(await service.listConflicts(signal));
    signal.throwIfAborted();
    for (const target of targets) {
      if (!this.canPublish(target)) continue;
      const session = target.session, result = results.get(session.rel);
      if (result?.status === "rejected") {
        logError("native conflict resolved file read failed", result.reason, { repoRoot: service.repoRoot, rel: session.rel });
      } else if (result?.status === "fulfilled") {
        if (conflicts.has(session.rel)) this.host.refreshUnresolved(session, "conflictsRefreshReconflicted");
        else { this.host.publish(session, result.value, reason); this.host.markResolved(session, reason); }
      }
    }
  }

  /** 낡은 generation이나 닫힘/재열기/일시 중단/action 중인 문서는 읽기 결과로 변경하지 않는다. */
  private canPublish({ session, generation }: Target): boolean {
    return !this.disposed && this.host.isCurrent(session) && session.refreshGeneration === generation
      && !session.resolved && !session.suspended && !session.busy;
  }
}
