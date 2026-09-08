// 불변 index blob의 표시용 내용만 제한된 메모리로 읽고 OID별로 재사용한다.
import { runGitStream } from "./gitExec";

export const MAX_CONFLICT_TEXT_BYTES = 512 * 1024;
interface Preview { kind: "text" | "binary"; content: string; truncated?: boolean }
interface Cached { value: Preview; cost: number }
interface Pending { controller: AbortController; promise: Promise<Preview>; users: number }

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
    let entry = this.pending.get(key);
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController();
      entry = { controller, users: 0, promise: Promise.resolve({ kind: "text", content: "" }) };
      const owned = entry;
      entry.promise = readPreview(root, oid, controller.signal).then(value => {
        if (!controller.signal.aborted && this.pending.get(key) === owned) {
          const cost = value.content.length * 2 + key.length * 2 + 256;
          this.cache.set(key, { value, cost }); this.bytes += cost;
          while (this.bytes > 16 * 1024 * 1024 || this.cache.size > 128) {
            const oldest = this.cache.keys().next().value!;
            this.bytes -= this.cache.get(oldest)!.cost; this.cache.delete(oldest);
          }
        }
        return value;
      }).finally(() => { if (this.pending.get(key) === owned) this.pending.delete(key); });
      this.pending.set(key, entry);
    }
    return this.subscribe(entry, signal);
  }

  /** 공유 조회의 한 소비자만 취소한다. 반환 객체 복사로 다른 문서가 캐시를 변경할 수 없게 한다. */
  private subscribe(entry: Pending, signal?: AbortSignal): Promise<Preview> {
    entry.users++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (value?: Preview, error?: unknown) => {
        if (finished) return;
        finished = true; signal?.removeEventListener("abort", abort);
        if (--entry.users === 0) entry.controller.abort();
        if (error !== undefined) reject(error); else resolve({ ...value! });
      };
      const abort = () => finish(undefined, signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      entry.promise.then(value => finish(value), error => finish(undefined, error));
      if (signal?.aborted) abort();
    });
  }
}

/**
 * 전체 스트림의 UTF-8/NUL 유효성을 검사하되 표시할 512KiB만 보존한다.
 * - 미리보기 뒤에 invalid byte가 있어도 binary로 분류하고 UTF-8 조각 경계를 스트리밍 검증한다.
 * - replace ref에 영향을 받지 않는 실제 index 객체만 캐시에 넣는다.
 */
async function readPreview(root: string, oid: string, signal: AbortSignal): Promise<Preview> {
  const prefix: Buffer[] = [];
  let size = 0, kept = 0, binary = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  await runGitStream(["cat-file", "blob", oid], root, chunk => {
    size += chunk.length;
    if (!binary) {
      try { if (chunk.includes(0)) binary = true; else decoder.decode(chunk, { stream: true }); }
      catch { binary = true; }
    }
    if (binary) { prefix.length = 0; return; }
    const take = Math.min(chunk.length, MAX_CONFLICT_TEXT_BYTES - kept);
    if (take > 0) { prefix.push(Buffer.from(chunk.subarray(0, take))); kept += take; }
  }, { signal, env: { GIT_NO_REPLACE_OBJECTS: "1" } });
  if (!binary) { try { decoder.decode(); } catch { binary = true; } }
  return binary ? { kind: "binary", content: "" }
    : { kind: "text", content: Buffer.concat(prefix).toString("utf8"), truncated: size > MAX_CONFLICT_TEXT_BYTES || undefined };
}

export const conflictBlobReader = new ConflictBlobReader();
