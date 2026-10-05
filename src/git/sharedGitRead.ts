/** 같은 세대의 진행 중 조회를 공유하되 소비자별 취소가 서로를 중단시키지 않는 순수 수명 도우미다. */
interface PendingRead<T> { generation: number; controller: AbortController; promise: Promise<T>; users: Set<symbol>; finished: boolean; started: boolean }
export interface SharedReadOptions {
  signal?: AbortSignal; force?: boolean; maxCacheAgeMs?: number;
  /** 실제 파일 변경을 관찰한 소비자 요청은 이미 시작한 forced 조회 뒤에도 최신 세대를 예약한다. */
  changed?: boolean;
}

/** 세대/force/TTL과 마지막 소비자 해제를 하나의 실제 조회 수명에 연결한다. */
export class SharedGitRead<T> {
  private generation = 0;
  private forcedGeneration?: number;
  private pending?: PendingRead<T>;
  private ready?: { at: number; value: T; generation: number };
  private readonly lifetime = new AbortController();

  /** loader는 취소 후 실제 프로세스 close까지 기다려야 한다. clone은 소비자 사이의 변경을 격리한다. */
  constructor(private readonly loader: (signal: AbortSignal) => Promise<T>, private readonly clone: (value: T) => T,
    private readonly cancelUnused: () => boolean = () => true) {}

  /** 진행 중 force 요청은 한 최신 세대로 합치고 이미 필요 없는 결과가 캐시에 들어가는 것을 막는다. */
  read(options: SharedReadOptions = {}): Promise<T> {
    if (this.lifetime.signal.aborted || options.signal?.aborted) return Promise.reject(cancelled());
    if (options.changed) {
      this.ready = undefined;
      // 아직 시작하지 않은 최신 pass는 이후 파일 상태를 읽으므로 변경 알림을 함께 합친다.
      if (!this.pending || (this.pending.started && this.pending.generation === this.generation)) this.invalidate();
      if (options.force) this.forcedGeneration = this.generation;
    } else if (options.force && this.forcedGeneration !== this.generation) {
      this.generation++; this.ready = undefined; this.forcedGeneration = this.generation;
    }
    return this.latest(options);
  }

  /** 파일/index/HEAD 변경 때 결과를 폐기한다. 기존 실행은 공유 소비자가 해제할 때까지 유지한다. */
  invalidate(): void { this.generation++; this.ready = undefined; this.forcedGeneration = undefined; }

  /** 캐시 정리에서 아직 필요한 실행을 보호할 소비자 존재 여부다. */
  hasConsumers(): boolean { return !!this.pending?.users.size; }

  /** 모든 소비자와 실제 조회를 취소하고 종료가 확인된 뒤 소유 캐시를 해제할 수 있게 한다. */
  async dispose(): Promise<void> {
    this.lifetime.abort(); this.pending?.controller.abort(); this.ready = undefined;
    await this.pending?.promise.catch(() => undefined);
  }

  /** 오래된 세대가 실행 중이면 close를 기다려 새 세대 하나만 실행한다. */
  private async latest(options: SharedReadOptions): Promise<T> {
    for (;;) {
      if (this.lifetime.signal.aborted || options.signal?.aborted) throw cancelled();
      const ready = this.ready;
      if (ready && ready.generation === this.generation && Date.now() - ready.at < (options.maxCacheAgeMs ?? 1000)) return this.clone(ready.value);
      const pending = this.pending ?? this.start();
      if (pending.controller.signal.aborted) { await this.waitForClose(pending.promise, options.signal); continue; }
      try {
        const value = await this.consume(pending, options.signal);
        if (pending.generation === this.generation) return this.clone(value);
      } catch (error) {
        if (pending.controller.signal.aborted && !options.signal?.aborted && !this.lifetime.signal.aborted) continue;
        throw error;
      }
    }
  }

  /** 이전 종료 대기를 취소해도 소유 프로세스 기록과 실제 close 대기는 계속 유지한다. */
  private waitForClose(promise: Promise<T>, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      /** 새 소비자의 대기 리스너만 제거하며 이전 실행의 소유권은 변경하지 않는다. */
      const finish = (error?: Error) => {
        signal?.removeEventListener("abort", abort); this.lifetime.signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      const abort = () => finish(cancelled());
      signal?.addEventListener("abort", abort, { once: true }); this.lifetime.signal.addEventListener("abort", abort, { once: true });
      if (signal?.aborted || this.lifetime.signal.aborted) abort();
      promise.then(() => finish(), () => finish());
    });
  }

  /** pending 등록을 먼저 마친 뒤 loader를 시작해 동시 호출의 중복 spawn을 막는다. */
  private start(): PendingRead<T> {
    const pending: PendingRead<T> = { generation: this.generation, controller: new AbortController(), users: new Set(), finished: false, started: false, promise: undefined! };
    this.pending = pending;
    pending.promise = Promise.resolve().then(() => { pending.started = true; return this.loader(pending.controller.signal); }).then(value => {
      if (pending.generation === this.generation && !pending.controller.signal.aborted && !this.lifetime.signal.aborted) {
        this.ready = { at: Date.now(), value: this.clone(value), generation: pending.generation };
      }
      return value;
    }).finally(() => {
      pending.finished = true;
      if (this.pending === pending) this.pending = undefined;
      if (pending.generation === this.forcedGeneration) this.forcedGeneration = undefined;
    });
    void pending.promise.catch(() => undefined);
    return pending;
  }

  /** 각 소비자에게 독립적인 abort listener를 두고 마지막 해제 때만 공유 Git을 취소한다. */
  private consume(pending: PendingRead<T>, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const user = Symbol(); pending.users.add(user); let settled = false;
      /** resolve/reject 양쪽에서 자신의 listener와 소비자 참조를 정확히 한 번 해제한다. */
      const finish = (callback: () => void) => {
        if (settled) return; settled = true;
        signal?.removeEventListener("abort", abort); this.lifetime.signal.removeEventListener("abort", abort);
        pending.users.delete(user);
        if (!pending.finished && !pending.users.size && this.cancelUnused()) pending.controller.abort();
        callback();
      };
      const abort = () => finish(() => reject(cancelled()));
      signal?.addEventListener("abort", abort, { once: true }); this.lifetime.signal.addEventListener("abort", abort, { once: true });
      if (signal?.aborted || this.lifetime.signal.aborted) abort();
      pending.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
  }
}

/** UI가 정상적인 소비자 해제와 실행 실패를 구분할 수 있는 표준 취소 오류다. */
function cancelled(): Error { return new DOMException("Git read cancelled.", "AbortError"); }
