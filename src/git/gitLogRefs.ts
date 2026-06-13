// git log/graph 에서 쓰는 ref 파싱 유틸.
// - GitLogService 의 커밋 조회 책임과 ref 문자열 정규화 책임을 분리해 파일 크기를 관리한다.
import type { CommitBranchInfo } from "../graph/graphTypes";

/**
 * for-each-ref 출력 한 줄들을 커밋 상세용 브랜치 목록으로 변환한다.
 * - origin/HEAD 같은 remote symbolic ref 는 실제 checkout 대상이 아니라 제외한다.
 * @param raw FS 로 구분된 for-each-ref 원문
 * @param separator git format 에 사용한 필드 구분자
 */
export function parseBranchRefs(
  raw: string,
  separator: string
): CommitBranchInfo[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap<CommitBranchInfo>((line) => {
      const [head, name, full] = line.split(separator);
      if (!name || name.endsWith("/HEAD")) {
        return [];
      }
      return [{
        name,
        kind: full?.startsWith("refs/remotes/") ? "remote" : "local",
        current: head === "*",
      }];
    })
    .sort(compareBranchInfo);
}

/**
 * 브랜치 목록을 현재 브랜치 → 로컬 → 원격 → 이름순으로 정렬한다.
 * @param a 비교할 첫 번째 브랜치
 * @param b 비교할 두 번째 브랜치
 */
function compareBranchInfo(
  a: CommitBranchInfo,
  b: CommitBranchInfo
): number {
  if (a.current !== b.current) {
    return a.current ? -1 : 1;
  }
  if (a.kind !== b.kind) {
    return a.kind === "local" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

/**
 * `%(upstream:track)` 값을 ahead/behind/gone 상태로 파싱한다.
 * - 예: "[ahead 2, behind 1]", "[gone]", "".
 * @param track git for-each-ref 의 upstream track 문자열
 */
export function parseTrack(track: string): {
  ahead: number;
  behind: number;
  gone: boolean;
} {
  return {
    ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
    gone: track.includes("gone"),
  };
}
