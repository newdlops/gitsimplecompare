const owned = new Set<string>();
/** 사용자 hook·shared index를 사용하지 않는 고정 명령이다. index-info의 NUL 경로 입력만 받는다. */
export const PRIVATE_STATUS_INDEX_UPDATE_ARGS = ["-c", "core.fsmonitor=false", "-c", "core.splitIndex=false",
  "-c", "core.untrackedCache=true", "update-index", "-z", "--index-info"] as const;
/** 생성한 private index만 쓰기 가능한 상태 캐시로 등록하며 자신의 수명 종료 때 해제한다. */
export function registerStatusIndex(file: string): () => void { owned.add(file); return () => { owned.delete(file); }; }
/** 사용자 index나 임의 GIT_INDEX_FILE은 optional-lock 쓰기를 허용하지 않는다. */
export function isOwnedStatusIndex(file: string | undefined): boolean { return file !== undefined && owned.has(file); }

/**
 * 준비가 끝난 최종 명령과 환경이 전용 index에만 쓸 수 있는지 검사한다.
 * @param args preparation 이후 실제 argv @param file 최종 환경의 GIT_INDEX_FILE
 * @returns 소유 사본과 고정한 명령이 정확히 일치할 때만 true. 경로/실행 인자는 로그에 노출하지 않는다.
 */
export function isOwnedStatusIndexUpdate(args: readonly string[], file: string | undefined): boolean {
  return isOwnedStatusIndex(file) && args.length === PRIVATE_STATUS_INDEX_UPDATE_ARGS.length
    && args.every((arg, index) => arg === PRIVATE_STATUS_INDEX_UPDATE_ARGS[index]);
}
