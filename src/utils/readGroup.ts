// 같은 요청의 병렬 읽기를 묶고 취소 시 모든 읽기의 실제 정리가 끝날 때까지 기다린다.

/**
 * Promise.all처럼 순서와 tuple 타입을 보존하되 취소된 요청은 남은 읽기까지 정리한다.
 * - 첫 AbortError만 받고 다음 작업을 시작하면 아직 종료 중인 자식 Git이 겹칠 수 있다.
 * - 정상 오류는 기존처럼 즉시 전파하며, mutation을 취소하거나 새 읽기를 시작하지 않는다.
 * @param reads 이미 시작한 읽기 Promise들 @param signal 요청 소유자의 취소 신호
 * @returns 모든 읽기의 값. 취소 시 전체 settlement 뒤 원래 오류를 그대로 던진다.
 */
export async function allReads<T extends readonly unknown[] | []>(
  reads: T, signal?: AbortSignal
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  try {
    const values = await Promise.all(reads);
    signal?.throwIfAborted();
    return values;
  }
  catch (error) {
    if (signal?.aborted) await Promise.allSettled(reads);
    throw error;
  }
}
