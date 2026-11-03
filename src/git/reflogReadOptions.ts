/** reflog 기본·객체 복구 조회가 공유하는 범위와 소비자 취소 신호다. */
export interface ReflogReadOptions { limit?: number; includeUnreachable?: boolean; signal?: AbortSignal }

/**
 * 기존 숫자 인자와 옵션 객체를 같은 조회 계획으로 바꾸고 유효하지 않은 숫자는 기본 범위로 낮춘다.
 * @param input 최대 개수 또는 상세 옵션 @returns 양의 정수 범위·객체 검사 여부·원래 취소 신호
 */
export function normalizeReflogReadOptions(input: number | ReflogReadOptions) {
  const rawLimit = typeof input === "number" ? input : input.limit ?? 80;
  return { limit: Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : 80,
    includeUnreachable: typeof input === "object" ? Boolean(input.includeUnreachable) : false,
    signal: typeof input === "object" ? input.signal : undefined };
}
