// 불변 index blob의 표시용 내용만 제한된 메모리로 읽고 OID별로 재사용한다.
import { readConflictBlobBatch } from "./conflictBlobBatch";
import { allReads } from "../utils/readGroup";

export const MAX_CONFLICT_TEXT_BYTES = 512 * 1024;
export interface ConflictBlobPreview { kind: "text" | "binary"; content: string; truncated?: boolean }
type Preview = ConflictBlobPreview;
interface Cached { value: Preview; cost: number }
interface ReadGroup { controller: AbortController; users: number; completion: Promise<unknown> }
interface Pending { group: ReadGroup; promise: Promise<Preview> }

/** 전체 저장소 합계 16MiB/128개 LRU와 소비자별 취소를 가진 blob 미리보기 저장소다. */
export class ConflictBlobReader {
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<string, Pending>();
  private bytes = 0;

  /**
   * 실제 index OID로만 조회한다. attributes/mode/작업 상태/Result는 캐시하지 않는다.
   * @param signal 한 소비자의 취소 신호. 마지막 소비자가 취소하면 Git도 중단한다.
   * @returns 새로 분류한, 또는 같은 OID의 완료된 표시용 미리보기
   */
  read(root: string, oid: string, signal?: AbortSignal): Promise<Preview> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const key = JSON.stringify([root, oid]);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key); this.cache.set(key, cached);
      return Promise.resolve({ ...cached.value });
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) return Promise.reject(new Error("Invalid conflict blob OID."));
    let entry = this.pending.get(key);
    if (!entry || entry.group.controller.signal.aborted) {
      this.startBatch(root, [oid]);
      entry = this.pending.get(key)!;
    }
    return this.subscribe(entry, signal);
  }

  /**
   * 같은 문서의 새 stage blob을 하나의 cat-file 스트림으로 읽는다.
   * - 완료된 OID와 다른 편집기가 읽는 OID는 재사용하고, 새 OID만 16개 단위로 묶는다.
   * @param oids 실제 index에서 읽은 불변 blob OID. 중복은 한 번만 요청한다.
   * @returns 각 OID의 독립적인 표시 값. 캐시된 원본과 작업트리/attributes는 변경하지 않는다.
   */
  async readMany(root: string, oids: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, Preview>> {
    signal?.throwIfAborted();
    const unique = [...new Set(oids)];
    if (unique.some(oid => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid))) throw new Error("Invalid conflict blob OID.");
    const missing = unique.filter(oid => {
      const key = JSON.stringify([root, oid]);
      return !this.cache.has(key) && (!this.pending.has(key) || this.pending.get(key)!.group.controller.signal.aborted);
    });
    for (let start = 0; start < missing.length; start += 16) this.startBatch(root, missing.slice(start, start + 16));
    const values = await allReads(unique.map(async oid => [oid, await this.read(root, oid, signal)] as const), signal);
    return new Map(values);
  }

  /** 같은 배치의 구독 수를 공유해 한 stage의 완료나 취소가 다른 소비자를 중단하지 않게 한다. */
  private startBatch(root: string, oids: string[]): void {
    const group: ReadGroup = { controller: new AbortController(), users: 0, completion: Promise.resolve() };
    const batch = readConflictBlobBatch(root, oids, MAX_CONFLICT_TEXT_BYTES, group.controller.signal);
    group.completion = batch;
    for (const oid of oids) {
      const key = JSON.stringify([root, oid]);
      const entry: Pending = { group, promise: Promise.resolve({ kind: "text", content: "" }) };
      entry.promise = batch.then(values => {
        const value = values.get(oid)!;
        if (!group.controller.signal.aborted && this.pending.get(key) === entry) this.remember(key, value);
        return value;
      }).finally(() => { if (this.pending.get(key) === entry) this.pending.delete(key); });
      this.pending.set(key, entry);
    }
  }

  /** 메모리/객체 수 상한 안에서 완료된 immutable 표시 값만 LRU에 보관한다. */
  private remember(key: string, value: Preview): void {
    const cost = value.content.length * 2 + key.length * 2 + 256;
    this.cache.set(key, { value, cost }); this.bytes += cost;
    while (this.bytes > 16 * 1024 * 1024 || this.cache.size > 128) {
      const oldest = this.cache.keys().next().value!;
      this.bytes -= this.cache.get(oldest)!.cost; this.cache.delete(oldest);
    }
  }

  /**
   * 공유 조회의 한 소비자만 취소하고 반환 객체 복사로 캐시를 보호한다.
   * - 마지막 소비자는 실제 Git close까지 기다려 다음 조회가 종료 중인 프로세스와 겹치지 않는다.
   * - 다른 소비자가 남아 있으면 그 조회는 유지하고 취소한 소비자만 즉시 반환한다.
   */
  private subscribe(entry: Pending, signal?: AbortSignal): Promise<Preview> {
    entry.group.users++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (value?: Preview, error?: unknown) => {
        if (finished) return;
        finished = true; signal?.removeEventListener("abort", abort);
        const last = --entry.group.users === 0;
        if (last) entry.group.controller.abort();
        if (error !== undefined && last) {
          void entry.group.completion.then(() => reject(error), () => reject(error));
        } else if (error !== undefined) reject(error);
        else resolve({ ...value! });
      };
      const abort = () => finish(undefined, signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      entry.promise.then(value => finish(value), error => finish(undefined, error));
      if (signal?.aborted) abort();
    });
  }
}

export const conflictBlobReader = new ConflictBlobReader();
