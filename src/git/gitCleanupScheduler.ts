/** timer를 주입해 설정 해제·dispose가 실제 작업 시작을 막는지 검사할 수 있는 경계다. */
export interface GitCleanupTimer {
  schedule(callback: () => void, delay: number): unknown;
  clear(timer: unknown): void;
}
const systemTimer: GitCleanupTimer = {
  schedule: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return timer; },
  clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** 옵션을 켰을 때만 직렬로 1분마다 정리하고 끄면 대기·진행 중 판정을 취소한다. */
export class GitCleanupScheduler {
  private timer?: unknown;
  private controller?: AbortController;
  private generation = 0;
  private enabled = false;
  private disposed = false;

  /** callback은 AbortSignal을 확인한 뒤 종료 명령을 시작해야 한다. */
  constructor(private readonly run: (signal: AbortSignal) => Promise<void>, private readonly timers: GitCleanupTimer = systemTimer, private readonly intervalMs = 60_000) {}

  /** 값을 변경할 때 이전 세대의 callback과 아직 실행되지 않은 정리를 모두 해제한다. */
  configure(enabled: boolean): void {
    if (this.enabled === (enabled && !this.disposed)) return;
    this.generation++; this.enabled = enabled && !this.disposed;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined; this.controller?.abort();
    if (this.enabled && !this.controller) this.schedule(this.generation);
  }

  /** extension dispose 이후에는 어떤 설정 이벤트도 정리를 다시 시작하지 못한다. */
  dispose(): void { this.disposed = true; this.configure(false); }

  /** 실행이 끝난 뒤 다음 검사를 예약해 느린 검사라도 프로세스가 중첩되지 않게 한다. */
  private schedule(generation: number): void {
    this.timer = this.timers.schedule(() => {
      if (!this.enabled || this.disposed || generation !== this.generation) return;
      this.timer = undefined;
      const controller = new AbortController(); this.controller = controller;
      void this.run(controller.signal).catch(() => undefined).finally(() => {
        if (this.controller === controller) this.controller = undefined;
        if (this.enabled && !this.disposed) this.schedule(this.generation);
      });
    }, this.intervalMs);
  }
}
