// Git에서 확인한 local-only membership을 표시용 commit 데이터에만 적용하는 순수 변환.
import type { Commit } from "../graph/graphTypes";

/**
 * 커밋 목록에 local-only 표시를 붙이고, 표시가 이전과 달라진 커밋 수를 센다.
 * - 실제 변경 수만 반환해 같은 표시 때문에 Graph 전체를 다시 게시하지 않게 한다.
 * @param commits 표시를 붙일 커밋 목록(제자리 수정)
 * @param byHash 커밋 hash → 검증한 local-only 브랜치 이름
 * @returns 표시가 추가·제거·변경된 커밋 수. 각 배열은 복사해 cache와 표시 데이터를 격리한다.
 */
export function applyLocalOnlyMarkers(commits: Commit[], byHash: ReadonlyMap<string, readonly string[]>): number {
  let changed = 0;
  for (const commit of commits) {
    const next = byHash.get(commit.hash);
    const previous = commit.localOnlyBranches ?? [];
    const nextNames = next ?? [];
    if (previous.length !== nextNames.length || previous.some((name, index) => name !== nextNames[index])) changed++;
    if (nextNames.length) commit.localOnlyBranches = [...nextNames];
    else delete commit.localOnlyBranches;
  }
  return changed;
}
