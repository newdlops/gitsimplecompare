// PR 이동의 객체 전송을 일반 브랜치 fetch와 구분해 취소·시간 상한·소유 프로세스 정리를 적용한다.
export const PULL_REQUEST_GRAPH_FETCH_OPTIONS = ["--no-tags", "--no-write-fetch-head", "--no-recurse-submodules",
  "--no-auto-maintenance", "--no-write-commit-graph", "--no-prune", "--refmap=", "--"] as const;

/**
 * ref·FETCH_HEAD·index를 바꾸지 않는 고정 명령만 조회 수명 정책으로 허용한다.
 * @param args fetch 하위 명령 뒤 최종 인자(전역 옵션 제외)
 * @returns 옵션이 정확히 일치하고 destination 없는 PR ref/OID 한 개일 때만 true
 */
export function isPullRequestGraphObjectFetch(args: readonly string[]): boolean {
  const offset = PULL_REQUEST_GRAPH_FETCH_OPTIONS.length;
  return args.length === offset + 2 && PULL_REQUEST_GRAPH_FETCH_OPTIONS.every((option, index) => args[index] === option)
    && !!args[offset] && !args[offset].startsWith("-")
    && /^(?:refs\/pull\/[1-9]\d*\/head|[a-f0-9]{40}|[a-f0-9]{64})$/i.test(args[offset + 1]);
}
