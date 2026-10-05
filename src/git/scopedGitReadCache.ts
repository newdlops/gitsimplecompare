// 파일별 결과와 진행 중 조회를 함께 재사용하며, 한 파일의 변경은 그 파일의 읽기만 취소한다.
import { SharedGitRead } from "./sharedGitRead";

/** scope는 저장소/파일처럼 무효화할 단위이며 key는 stage/ref/URI까지 구분하는 조회 identity다. */
export class ScopedGitReadCache<T> {
  private readonly entries = new Map<string, { scope: string; read: SharedGitRead<T> }>();
  private readonly closing = new Map<string, Set<Promise<void>>>();

  /** @param maxEntries 완료 결과의 LRU 개수 상한, clone 공유 소비자가 수정할 수 있는 결과 복사 함수 */
  constructor(private readonly maxEntries = 64, private readonly clone: (value: T) => T = value => value) {}

  /** 같은 key의 완료·진행 조회를 공유하고 소비자 신호는 해당 소비자에게만 적용한다. */
  async read(key: string, scope: string, loader: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let entry = this.entries.get(key);
    if (!entry) {
      // 무효화한 이전 파일 조회가 실제로 닫히기 전에는 대체 Git 프로세스를 시작하지 않는다.
      const predecessors = Promise.all([...(this.closing.get(scope) ?? [])]);
      entry = { scope, read: new SharedGitRead(async ownedSignal => {
        await predecessors; ownedSignal.throwIfAborted(); return loader(ownedSignal);
      }, this.clone) };
    }
    this.entries.delete(key); this.entries.set(key, entry);
    try { return await entry.read.read({ signal, maxCacheAgeMs: Number.POSITIVE_INFINITY }); }
    catch (error) {
      if (this.entries.get(key) === entry && !entry.read.hasConsumers()) {
        this.entries.delete(key); this.close(entry);
      }
      throw error;
    } finally { this.trim(); }
  }

  /** 지정 파일 scope만 무효화하고 생략하면 HEAD/index처럼 전체 기준 변경을 반영한다. */
  invalidate(scope?: string): void {
    for (const [key, entry] of this.entries) {
      if (scope !== undefined && entry.scope !== scope) continue;
      this.entries.delete(key); this.close(entry);
    }
  }

  /** 검사·OUTPUT에서 현재 보관된 조회 개수를 확인한다. */
  size(): number { return this.entries.size; }

  /** 진행 소비자가 없는 오래된 값을 제거하고 아직 필요한 파일 읽기는 보호한다. */
  private trim(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) break;
      if (entry.read.hasConsumers()) continue;
      this.entries.delete(key); this.close(entry);
    }
  }

  /** 종료 중 실행을 파일별로 추적하고 실제 close 뒤 barrier와 소유 참조를 해제한다. */
  private close(entry: { scope: string; read: SharedGitRead<T> }): void {
    const owned = entry.read.dispose();
    const pending = this.closing.get(entry.scope) ?? new Set<Promise<void>>();
    this.closing.set(entry.scope, pending); pending.add(owned);
    void owned.finally(() => {
      pending.delete(owned);
      if (!pending.size && this.closing.get(entry.scope) === pending) this.closing.delete(entry.scope);
    });
  }
}
