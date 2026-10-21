// 객체·ref·FETCH_HEAD·maintenance 쓰기를 막은 내부 협상 명령의 조립과 조회 분류를 함께 소유한다.
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const FLAGS = ["--negotiate-only", "--no-write-fetch-head", "--no-auto-maintenance", "--no-write-commit-graph",
  "--no-tags", "--no-prune", "--no-prune-tags", "--recurse-submodules=no"] as const;

/** @param head 승인한 원본 commit OID @param url 실제 push URL @returns refspec 없는 단일 서버의 읽기 전용 협상 명령 */
export function fetchNegotiationCommand(head: string, url: string): string[] {
  if (!OID.test(head) || !url) throw new Error("A fixed commit and push server are required for negotiation.");
  return ["fetch", ...FLAGS, `--negotiation-tip=${head}`, "--", url];
}

/**
 * 내부의 고정된 안전 형태만 조회로 분류한다. 일반 fetch, 추가 옵션/refspec, URL 뒤 옵션은 허용하지 않는다.
 * @param rest fetch 하위 명령 뒤 인자 @returns 모든 쓰기 방지 옵션과 단일 OID/URL이 정확하면 true
 */
export function isReadOnlyFetchNegotiation(rest: readonly string[]): boolean {
  return rest.length === FLAGS.length + 3 && FLAGS.every((flag, index) => rest[index] === flag) &&
    rest[FLAGS.length]?.startsWith("--negotiation-tip=") && OID.test(rest[FLAGS.length].slice("--negotiation-tip=".length)) &&
    rest[FLAGS.length + 1] === "--" && !!rest[FLAGS.length + 2];
}
