import type { FileHandle } from "node:fs/promises";

/** 파일 크기 검사 뒤 증가한 파일도 실제 읽기 바이트 상한으로 중단할 때 쓰는 오류다. */
export class FileReadLimitError extends Error {
  /** @param limit 허용한 최대 바이트 @param size 실제 확인한 최소 크기 */
  constructor(public readonly limit: number, public readonly size: number) { super("File read exceeded its byte limit."); }
}

/**
 * 열린 파일을 최대 maxBytes + 1바이트만 읽어 크기 증가·짧은 read·취소를 처리한다.
 * @param handle 호출자가 열고 finally에서 닫을 파일 @param maxBytes 허용한 전체 크기 @param signal 소비자 취소
 * @param expectedBytes 이미 조회한 크기. 불필요한 큰 선할당을 피하며 실제 크기·상한 검증을 대체하지 않는다.
 * @returns 파일 원본 바이트. 512KiB 청크와 재사용 버퍼로 읽고, 상한을 넘으면 잘린 내용 대신 오류를 반환한다.
 */
export async function readBoundedHandle(handle: FileHandle, maxBytes: number, signal?: AbortSignal, expectedBytes?: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) throw new RangeError("Invalid file read byte limit.");
  signal?.throwIfAborted();
  const hint = expectedBytes !== undefined && Number.isSafeInteger(expectedBytes) && expectedBytes >= 0
    ? expectedBytes : Math.min(maxBytes, 512 * 1024);
  let buffer = Buffer.allocUnsafe(Math.min(maxBytes, hint, 8 * 1024 * 1024)), total = 0;
  const probe = Buffer.allocUnsafe(1);
  while (true) {
    signal?.throwIfAborted();
    if (total === buffer.length) {
      // 크기 예상치에 도달해도 추가 대형 버퍼를 먼저 만들지 않는다. 한 바이트로 EOF·증가·상한 초과를 구분한다.
      const { bytesRead } = await handle.read(probe, 0, 1, null);
      signal?.throwIfAborted();
      if (!bytesRead) return buffer.subarray(0, total);
      if (total === maxBytes) throw new FileReadLimitError(maxBytes, total + 1);
      const grown = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(total + 1, buffer.length * 2, 512 * 1024)));
      buffer.copy(grown, 0, 0, total); grown[total++] = probe[0]; buffer = grown; continue;
    }
    const { bytesRead } = await handle.read(buffer, total, Math.min(512 * 1024, buffer.length - total), null);
    signal?.throwIfAborted();
    if (!bytesRead) return buffer.subarray(0, total);
    total += bytesRead;
  }
}
