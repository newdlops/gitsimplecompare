const owned = new Set<string>();
/** 생성한 private index만 쓰기 가능한 상태 캐시로 등록하며 자신의 수명 종료 때 해제한다. */
export function registerStatusIndex(file: string): () => void { owned.add(file); return () => { owned.delete(file); }; }
/** 사용자 index나 임의 GIT_INDEX_FILE은 optional-lock 쓰기를 허용하지 않는다. */
export function isOwnedStatusIndex(file: string | undefined): boolean { return file !== undefined && owned.has(file); }
