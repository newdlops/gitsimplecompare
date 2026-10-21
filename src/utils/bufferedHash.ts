// 작은 의미 조각을 정해진 크기 안에서 합쳐 crypto 경계 호출과 임시 Buffer view를 줄인다.
import type { Hash } from "node:crypto";

/** 입력 순서·바이트는 유지하면서 고정 크기 사본만 보관하는 동기 해시 writer다. */
export class BufferedHash {
  private readonly buffer: Buffer;
  private used = 0;
  private finalized = false;

  /** @param hash prefix 등을 이미 넣은 독립 Hash @param capacity 한 번에 모을 최대 바이트 수 */
  constructor(private readonly hash: Hash, capacity = 64 * 1024) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Invalid buffered hash capacity.");
    this.buffer = Buffer.allocUnsafe(capacity);
  }

  /**
   * 조각을 동기로 복사하므로 caller가 같은 metadata buffer를 다음 항목에서 재사용할 수 있다.
   * @param source 원본 Buffer @param start 포함할 시작 @param end 포함하지 않을 끝
   * @returns 없음. 범위 오류는 해시 상태를 바꾸기 전에 거부하며 큰 입력도 capacity 안에서 나눈다.
   */
  append(source: Buffer, start = 0, end = source.length): void {
    if (this.finalized) throw new Error("Buffered hash has already been finalized.");
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.length)
      throw new RangeError("Invalid buffered hash input range.");
    if (end - start <= this.buffer.length - this.used) {
      source.copy(this.buffer, this.used, start, end); this.used += end - start;
      if (this.used === this.buffer.length) this.flush();
      return;
    }
    for (let cursor = start; cursor < end;) {
      const size = Math.min(end - cursor, this.buffer.length - this.used);
      source.copy(this.buffer, this.used, cursor, cursor + size); cursor += size; this.used += size;
      if (this.used === this.buffer.length) this.flush();
    }
  }

  /** 남은 실제 입력 바이트만 한 번 반영하고 기존 Hash와 같은 hex digest를 반환한다. */
  digestHex(): string {
    if (this.finalized) throw new Error("Buffered hash has already been finalized.");
    this.flush(); this.finalized = true; return this.hash.digest("hex");
  }

  /** 채운 범위만 반영해 allocUnsafe의 미초기화 바이트가 digest에 섞이지 않게 한다. */
  private flush(): void { if (this.used) { this.hash.update(this.buffer.subarray(0, this.used)); this.used = 0; } }
}
