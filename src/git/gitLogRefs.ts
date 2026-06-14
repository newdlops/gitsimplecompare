// git log/graph 에서 쓰는 ref 파싱 유틸.
// - GitLogService 의 커밋 조회 책임과 ref 문자열 정규화 책임을 분리해 파일 크기를 관리한다.
import type { CommitBranchInfo } from "../graph/graphTypes";

/** 커밋 해시를 포함한 branch ref 캐시 내부 레코드 */
export interface CommitBranchRef extends CommitBranchInfo {
  hash: string;
}

/**
 * objectname 을 포함한 for-each-ref 출력 한 줄들을 브랜치 캐시 레코드로 변환한다.
 * - 입력 포맷은 hash, HEAD 표시, short ref, full ref 순서여야 한다.
 * @param raw FS 로 구분된 for-each-ref 원문
 * @param separator git format 에 사용한 필드 구분자
 */
export function parseBranchRefRecords(
  raw: string,
  separator: string
): CommitBranchRef[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap<CommitBranchRef>((line) => {
      const [hash, head, name, full] = line.split(separator);
      if (!hash || !name || name.endsWith("/HEAD")) {
        return [];
      }
      return [{
        hash,
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

/**
 * %D(decoration) 문자열을 참조 이름 배열로 파싱한다.
 * - "HEAD -> main, origin/main, tag: v1" → ["HEAD", "main", "origin/main", "tag:v1"]
 * @param decoration git 의 decoration 문자열
 */
export function parseRefs(decoration: string): string[] {
  if (!decoration.trim()) {
    return [];
  }
  return decoration.split(",").flatMap((raw) => {
    const part = raw.trim();
    if (part.startsWith("HEAD -> ")) {
      return ["HEAD", part.slice("HEAD -> ".length)];
    }
    if (part === "HEAD") {
      return ["HEAD"];
    }
    if (part.startsWith("tag: ")) {
      return [`tag:${part.slice("tag: ".length)}`];
    }
    if (part === "refs/stash" || part.startsWith("stash@{")) {
      return [];
    }
    return part ? [part] : [];
  });
}
