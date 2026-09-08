// 취소 가능한 조회 작업의 동시 실행을 제한하고 현재 화면의 작업부터 시작한다.
interface Entry { priority: () => number; start: () => void }

/** 낮은 priority 값을 먼저 실행한다. 실행 중 작업을 재시작하거나 쓰기 작업을 취소하지 않는다. */
export class PriorityReadQueue {
  private readonly queue: Entry[] = [];
  private active = 0;
  private scheduled = false;
  private readonly signals = new WeakMap<AbortSignal, { callbacks: Set<() => void>; abort: () => void }>();

  /** 실행 중 조회 개수의 양의 정수 상한을 고정한다. */
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Read concurrency must be positive.");
  }

  /**
   * 대기 중에는 취소 시 즉시 제거하고, 실행 중에는 task가 취소를 정리한 뒤 슬롯을 반환한다.
   * @param priority 시작 시점에 평가해 사용자가 다른 편집기로 이동한 경우도 반영한다.
   */
  run<T>(task: () => Promise<T>, signal: AbortSignal, priority: () => number = () => 0): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      let unwatch = () => {};
      const entry: Entry = { priority, start: () => {
        unwatch();
        this.active++;
        Promise.resolve().then(() => { signal.throwIfAborted(); return task(); })
          .then(resolve, reject).finally(() => { this.active--; this.schedule(); });
      } };
      const abort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        unwatch(); reject(signal.reason);
      };
      this.queue.push(entry);
      unwatch = this.watch(signal, abort);
      this.schedule();
    });
  }

  /** 같은 PR 페이지의 수십 개 대기 작업도 신호 리스너 하나로 취소하고 마지막 작업에서 정리한다. */
  private watch(signal: AbortSignal, callback: () => void): () => void {
    let group = this.signals.get(signal);
    if (!group) {
      const callbacks = new Set<() => void>();
      group = { callbacks, abort: () => { for (const cancel of [...callbacks]) cancel(); } };
      this.signals.set(signal, group);
      signal.addEventListener("abort", group.abort, { once: true });
    }
    const owned = group;
    owned.callbacks.add(callback);
    return () => {
      owned.callbacks.delete(callback);
      if (!owned.callbacks.size) { signal.removeEventListener("abort", owned.abort); this.signals.delete(signal); }
    };
  }

  /** 같은 이벤트의 요청을 모은 뒤 우선순위가 같은 작업은 등록 순서대로 실행한다. */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.queue.sort((a, b) => a.priority() - b.priority());
      while (this.active < this.limit && this.queue.length) this.queue.shift()!.start();
    });
  }
}
