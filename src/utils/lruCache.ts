/** 개수·바이트 상한을 함께 유지하는 작은 완료 값 캐시. 진행 중 작업의 수명은 호출자가 소유한다. */
export class LruCache<K, V> {
  private readonly values = new Map<K, { value: V; bytes: number }>();
  private bytes = 0;
  private evictions = 0;

  /** @param maxEntries 항목 수 상한, maxBytes 가중치 합계 상한, weigh 키와 값의 보관 비용 계산 함수 */
  constructor(private readonly maxEntries: number, private readonly maxBytes: number,
    private readonly weigh: (key: K, value: V) => number) {}

  /** 완료 값을 읽고 최근 사용 순서를 갱신한다. 존재하지 않으면 undefined를 반환한다. */
  get(key: K): V | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    this.values.delete(key); this.values.set(key, entry);
    return entry.value;
  }

  /** 새 값을 보관하며 큰 단일 항목과 가장 오래 사용하지 않은 값은 상한에 맞춰 제거한다. */
  set(key: K, value: V): void {
    this.delete(key);
    const bytes = Math.max(0, this.weigh(key, value));
    if (!Number.isFinite(bytes) || bytes > this.maxBytes || this.maxEntries < 1) return;
    this.values.set(key, { value, bytes }); this.bytes += bytes;
    while (this.values.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.delete(this.values.keys().next().value!); this.evictions++;
    }
  }

  /** 특정 값과 가중치를 함께 제거한다. */
  delete(key: K): void {
    const entry = this.values.get(key);
    if (entry) { this.values.delete(key); this.bytes -= entry.bytes; }
  }

  /** 수명 종료 때 모든 값과 보관 비용을 비운다. */
  clear(): void { this.values.clear(); this.bytes = 0; }

  /** 검사·관찰성에서 항목 수·가중치·상한 제거 횟수를 읽을 수 있는 사본을 반환한다. */
  stats(): { entries: number; bytes: number; evictions: number } {
    return { entries: this.values.size, bytes: this.bytes, evictions: this.evictions };
  }
}
