// 조회 전용 GitHub 실행의 시간 상한·진행 요청 공유·메모리 캐시·실제 동시 실행 수를 관리한다.
import { runGh } from "./ghCli";
import type { GhExecute, GhRunnerOptions } from "./ghRunner";
import { gitHubReadContext, snapshotGitHubEnvironment } from "./githubReadContext";
import { logInfo } from "../ui/outputLog";

interface Entry { value: string; at: number; expires: number; bytes: number; }
interface Pending { controller: AbortController; promise: Promise<string>; users: number; }
export interface GitHubReadOptions extends GhRunnerOptions {
  /** immutable OID 또는 mutable 데이터의 세대를 cache key에 포함한다. */
  version?: string;
  ttlMs?: number;
}

/** 조회 호출에 실제 동시 실행 4개, 완료 캐시 128개/16MiB 상한을 적용한다. */
export class GitHubReadCache {
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Pending>();
  private readonly queue: Array<() => void> = [];
  private readonly executions = new Map<AbortController, Promise<string>>();
  private active = 0;
  private bytes = 0;
  private disposed = false;

  /** 실제 CLI 또는 테스트 실행기, 큐 대기를 포함한 시간 상한을 받아 같은 정책을 적용한다. */
  constructor(private readonly execute: GhExecute = runGh, private readonly timeoutMs = 30_000) {}

  /**
   * 같은 저장소·환경·인자·세대의 조회를 공유하고 성공한 작은 응답만 잠시 보관한다.
   * @param options ttlMs=0은 완료 캐시를 무효화하고 진행 요청만 공유한다. 취소는 소비자별이다.
   * @returns UTF-8 응답. 마지막 소비자가 취소하면 소유 CLI의 종료도 요청한다.
   */
  read(args: readonly string[], root: string, options: GitHubReadOptions): Promise<string> {
    if (this.disposed || options.signal?.aborted) return Promise.reject(cancelled());
    const env = snapshotGitHubEnvironment(options.env);
    const key = JSON.stringify([root, gitHubReadContext(root, env, args), options.version || "", args]);
    const ttl = options.ttlMs ?? 0;
    this.sweep();
    const cached = this.cache.get(key);
    if (cached && ttl > 0 && Date.now() - cached.at < ttl) {
      this.cache.delete(key); this.cache.set(key, cached);
      logInfo("GitHub read cache hit", { repoRoot: root, operation: options.operation });
      return Promise.resolve(cached.value);
    }
    this.remove(key);
    let entry = this.pending.get(key);
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController();
      entry = { controller, users: 0, promise: Promise.resolve("") };
      const owned = entry;
      entry.promise = this.run(args, root, { ...options, env, signal: controller.signal }).then(value => {
        if (!this.disposed && !controller.signal.aborted && this.pending.get(key) === owned && ttl > 0) {
          const bytes = Buffer.byteLength(value);
          if (bytes <= 4 * 1024 * 1024) {
            this.remove(key);
            this.cache.set(key, { value, bytes, at: Date.now(), expires: Date.now() + ttl });
            this.bytes += bytes; this.sweep();
          }
        }
        return value;
      }).finally(() => { if (this.pending.get(key) === owned) this.pending.delete(key); });
      this.pending.set(key, entry);
    } else logInfo("GitHub read coalesced", { repoRoot: root, operation: options.operation });
    return this.subscribe(entry, options.signal);
  }

  /** 모든 소비자·대기 요청을 취소하고 실제 실행 종료 뒤 캐시 수명을 마친다. */
  async dispose(): Promise<void> {
    this.disposed = true; this.cache.clear(); this.bytes = 0;
    for (const entry of this.pending.values()) entry.controller.abort();
    for (const controller of this.executions.keys()) controller.abort();
    await Promise.allSettled([...this.executions.values()]);
    this.pending.clear();
  }

  /** 한 소비자만 취소하며 다른 활성 소비자가 공유 중인 CLI는 유지한다. */
  private subscribe(entry: Pending, signal?: AbortSignal): Promise<string> {
    entry.users++;
    return new Promise((resolve, reject) => {
      let finished = false;
      /** 자신의 리스너·참조를 정확히 한 번 해제하고 마지막 소비자만 CLI 종료를 요청한다. */
      const done = (error?: unknown, value?: string) => {
        if (finished) return;
        finished = true; signal?.removeEventListener("abort", abort);
        if (--entry.users === 0) entry.controller.abort();
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => done(cancelled());
      signal?.addEventListener("abort", abort, { once: true });
      entry.promise.then(value => done(undefined, value), error => done(error));
      if (signal?.aborted) abort();
    });
  }

  /** 슬롯을 얻을 때까지 기다리되 취소·시간 초과된 요청은 큐에서 즉시 제거한다. */
  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(cancelled());
    if (this.active < 4) { this.active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const start = () => { signal.removeEventListener("abort", abort); this.active++; resolve(); };
      const abort = () => { const at = this.queue.indexOf(start); if (at >= 0) this.queue.splice(at, 1); reject(cancelled()); };
      this.queue.push(start); signal.addEventListener("abort", abort, { once: true });
    });
  }

  /**
   * 호출자에게는 취소·시간 초과를 즉시 전달하지만 실행 슬롯은 실제 close까지 보유한다.
   * @param options 실행 환경과 부모 취소 신호. 실행기는 종료를 확인한 뒤 settle해야 한다.
   * @returns 성공 출력 또는 큐 대기를 포함한 제한 시간/취소 오류
   */
  private async run(args: readonly string[], root: string, options: GhRunnerOptions): Promise<string> {
    const controller = new AbortController();
    const started = Date.now();
    let acquired = false;
    let rejectInterrupted!: (error: Error) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
    const abort = () => { rejectInterrupted(cancelled()); controller.abort(); };
    const onStopped = () => rejectInterrupted(cancelled());
    options.signal?.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener("abort", onStopped, { once: true });
    const timer = setTimeout(() => {
      rejectInterrupted(new Error("GitHub query timed out. Refresh to try again.")); controller.abort();
    }, this.timeoutMs);
    const execution = Promise.resolve().then(async () => {
      await this.acquire(controller.signal); acquired = true;
      controller.signal.throwIfAborted();
      return this.execute(args, root, { ...options, managedRead: true, signal: controller.signal });
    }).finally(() => {
      this.executions.delete(controller);
      if (acquired) { this.active--; this.queue.shift()?.(); }
      logInfo("GitHub read execution closed", { repoRoot: root, operation: options.operation, elapsedMs: Date.now() - started });
    });
    this.executions.set(controller, execution);
    if (options.signal?.aborted || this.disposed) abort();
    try { return await Promise.race([interrupted, execution]); }
    finally {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onStopped);
      logInfo("GitHub read finished", { repoRoot: root, operation: options.operation, elapsedMs: Date.now() - started });
    }
  }

  /** 항목과 메모리 사용량을 함께 제거해 덮어쓰기·만료 후에도 상한 계산을 유지한다. */
  private remove(key: string): void {
    const entry = this.cache.get(key);
    if (entry) { this.cache.delete(key); this.bytes -= entry.bytes; }
  }

  /** 만료 및 LRU 상한 초과 항목을 제거해 큰 patch가 무한히 누적되지 않게 한다. */
  private sweep(): void {
    for (const [key, entry] of this.cache) if (entry.expires <= Date.now()) this.remove(key);
    while (this.cache.size > 128 || this.bytes > 16 * 1024 * 1024) this.remove(this.cache.keys().next().value!);
  }
}

/** 일반 조회 실패와 정상 취소를 구분하는 표준 오류를 만든다. */
function cancelled(): Error { return new DOMException("GitHub query cancelled.", "AbortError"); }
let shared = new GitHubReadCache();
let interactive = new GitHubReadCache();

/** production 백그라운드 조회가 실행 한계와 캐시를 공유하게 하는 진입점이다. */
export const readGitHub = (args: readonly string[], root: string, options: GitHubReadOptions): Promise<string> => shared.read(args, root, options);

/** 직접 연 상세·파일·댓글 조회는 목록과 별도 슬롯을 사용하며 완료 캐시를 쓰지 않는다. */
export const readGitHubInteractive = (args: readonly string[], root: string, options: GitHubReadOptions): Promise<string> =>
  interactive.read(args, root, { ...options, ttlMs: 0 });

/** 새 활성화가 새 조회 수명을 소유하게 하고 이전 disposer가 새 실행을 취소하지 못하게 한다. */
export function beginGitHubReadLifetime(): () => Promise<void> {
  const previous = Promise.all([shared.dispose(), interactive.dispose()]);
  shared = new GitHubReadCache(); interactive = new GitHubReadCache();
  const owned = [shared, interactive];
  return async () => { await Promise.all([previous, ...owned.map(cache => cache.dispose())]); };
}
