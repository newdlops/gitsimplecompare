// 조회 전용 GitHub 실행의 시간 상한·진행 요청 공유·메모리 캐시·전체 동시 실행 수를 관리한다.
import { runGh } from "./ghCli";
import type { GhExecute, GhRunnerOptions } from "./ghRunner";
import { logInfo } from "../ui/outputLog";

interface Entry { value: string; expires: number; bytes: number; }
interface Pending { controller: AbortController; promise: Promise<string>; users: number; }
export interface GitHubReadOptions extends GhRunnerOptions {
  /** immutable OID 또는 mutable 데이터의 세대를 cache key에 포함한다. */
  version?: string;
  ttlMs?: number;
}

/** 조회 호출 전체에 동시 실행 4개, 완료 캐시 128개/16MiB 상한을 적용한다. */
export class GitHubReadCache {
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Pending>();
  private readonly queue: Array<() => void> = [];
  private active = 0;
  private bytes = 0;

  /** 실제 CLI 또는 테스트 실행기, 요청 시간 상한을 받아 모든 read에 같은 정책을 적용한다. */
  constructor(private readonly execute: GhExecute = runGh, private readonly timeoutMs = 30_000) {}

  /**
   * 같은 저장소·인자·세대의 조회를 공유하고 성공한 작은 응답만 잠시 보관한다.
   * @param options ttlMs=0은 완료 캐시 없이 진행 요청만 공유한다. 취소는 소비자별로 처리한다.
   * @returns UTF-8 응답. 마지막 소비자가 취소하면 대기/실행 중인 CLI도 중단한다.
   */
  read(args: readonly string[], root: string, options: GitHubReadOptions): Promise<string> {
    if (options.signal?.aborted) return Promise.reject(cancelled());
    const key = JSON.stringify([root, options.version || "", args]);
    this.sweep();
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key); this.cache.set(key, cached);
      logInfo("GitHub read cache hit", { repoRoot: root, operation: options.operation });
      return Promise.resolve(cached.value);
    }
    let entry = this.pending.get(key);
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController();
      entry = { controller, users: 0, promise: Promise.resolve("") };
      const owned = entry;
      entry.promise = this.run(args, root, { ...options, signal: controller.signal }).then(value => {
        if (!controller.signal.aborted && this.pending.get(key) === owned && (options.ttlMs ?? 0) > 0) {
          const bytes = Buffer.byteLength(value);
          if (bytes <= 4 * 1024 * 1024) {
            this.cache.set(key, { value, bytes, expires: Date.now() + options.ttlMs! });
            this.bytes += bytes; this.sweep();
          }
        }
        return value;
      }).finally(() => { if (this.pending.get(key) === owned) this.pending.delete(key); });
      this.pending.set(key, entry);
    } else logInfo("GitHub read coalesced", { repoRoot: root, operation: options.operation });
    return this.subscribe(entry, options.signal);
  }

  /** 한 소비자의 취소만 거절하고 다른 활성 소비자가 공유 중인 CLI는 유지한다. */
  private subscribe(entry: Pending, signal?: AbortSignal): Promise<string> {
    entry.users++;
    return new Promise((resolve, reject) => {
      let finished = false;
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

  /** 실행 슬롯을 얻을 때까지 기다리되 취소된 요청은 큐에서 즉시 제거한다. */
  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.active < 4) { this.active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const start = () => { signal?.removeEventListener("abort", abort); this.active++; resolve(); };
      const abort = () => { const at = this.queue.indexOf(start); if (at >= 0) this.queue.splice(at, 1); reject(cancelled()); };
      this.queue.push(start); signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /** 대기/CLI를 취소 가능하게 연결하고 무응답 조회에 시간 상한을 적용한다. */
  private async run(args: readonly string[], root: string, options: GhRunnerOptions): Promise<string> {
    await this.acquire(options.signal);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const started = Date.now();
    try {
      options.signal?.throwIfAborted();
      const interrupted = new Promise<never>((_resolve, reject) => {
        abort = () => { reject(cancelled()); controller.abort(); };
        options.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => { reject(new Error("GitHub query timed out. Refresh to try again.")); controller.abort(); }, this.timeoutMs);
      });
      return await Promise.race([interrupted, this.execute(args, root, { ...options, signal: controller.signal })]);
    } finally {
      clearTimeout(timer); if (abort) options.signal?.removeEventListener("abort", abort);
      this.active--; this.queue.shift()?.();
      logInfo("GitHub read finished", { repoRoot: root, operation: options.operation, elapsedMs: Date.now() - started });
    }
  }

  /** 만료 및 LRU 상한 초과 항목을 제거해 큰 patch가 무한히 누적되지 않게 한다. */
  private sweep(): void {
    for (const [key, entry] of this.cache) if (entry.expires <= Date.now()) { this.cache.delete(key); this.bytes -= entry.bytes; }
    while (this.cache.size > 128 || this.bytes > 16 * 1024 * 1024) {
      const [key, entry] = this.cache.entries().next().value!; this.cache.delete(key); this.bytes -= entry.bytes;
    }
  }
}

/** 사용자에게 일반 조회 오류 대신 취소로 구분해 전달할 오류를 만든다. */
function cancelled(): Error { return new DOMException("GitHub query cancelled.", "AbortError"); }
const shared = new GitHubReadCache();
/** production 조회가 전체 프로세스 한계와 cache를 공유하게 하는 진입점이다. */
export const readGitHub = (args: readonly string[], root: string, options: GitHubReadOptions): Promise<string> => shared.read(args, root, options);
