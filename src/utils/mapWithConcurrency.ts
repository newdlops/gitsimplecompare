/**
 * 입력 순서와 전체 결과를 보존하면서 파일 읽기 등 비동기 작업 수를 제한한다.
 * @param items 처리할 전체 입력, concurrency 동시 실행 상한, mapper 항목 변환 함수
 * @param signal 소비자가 더 이상 결과를 사용하지 않을 때 새 작업을 시작하지 않을 신호
 * @returns 입력과 같은 순서의 결과. 실패하더라도 시작한 worker가 정리된 뒤 예외를 전달한다.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[], concurrency: number,
  mapper: (item: T, index: number) => Promise<R>, signal?: AbortSignal
): Promise<R[]> {
  signal?.throwIfAborted();
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  /** 한 worker가 다음 항목을 가져오며 취소·실패 뒤에는 아직 시작하지 않은 I/O를 건너뛴다. */
  const worker = async () => {
    while (!failed && cursor < items.length) {
      try {
        signal?.throwIfAborted();
        const index = cursor++;
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!failed) { failed = true; failure = error; }
      }
    }
  };
  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  signal?.throwIfAborted();
  if (failed) throw failure;
  return results;
}
