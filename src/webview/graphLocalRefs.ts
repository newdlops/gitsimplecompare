// graph 로드 후 최신 로컬 branch/HEAD ref 를 이미 로드된 commit 목록에 다시 반영한다.
// - checkout 뒤 전체 graph 를 다시 읽지 않아도 되는지 판단하는 순수 보조 로직이다.
import type { Commit, LocalBranchStatus } from "../graph/graphTypes";

/**
 * 이미 로드된 커밋 목록에 최신 로컬 브랜치/HEAD 참조를 반영한다.
 * @param commits 로컬 ref 표시를 갱신할 현재 graph 커밋 목록
 * @param branches 최신 로컬 브랜치 상태
 * @param visibleRefs 현재 브랜치 필터에서 표시 가능한 ref 이름 집합
 * @returns 현재 브랜치 HEAD 가 로드된 범위 안에 있어 부분 갱신이 가능하면 true
 */
export function syncGraphLocalRefs(
  commits: Commit[],
  branches: LocalBranchStatus[],
  visibleRefs: Set<string>
): boolean {
  const localNames = new Set(branches.map((branch) => branch.name));
  const byHash = new Map<string, Commit>();
  for (const commit of commits) {
    // 동일 해시가 여러 행에 있어도 기존 find와 같이 첫 행에 ref를 붙인다.
    const hash = commit.hash;
    if (!byHash.has(hash)) byHash.set(hash, commit);
    commit.refs = commit.refs.filter(
      (ref) => ref !== "HEAD" && !localNames.has(ref)
    );
  }

  let currentLoaded = false;
  const currentBranch = branches.find((branch) => branch.current);
  for (const branch of branches) {
    if (!visibleRefs.has(branch.name)) {
      continue;
    }
    const commit = byHash.get(branch.hash);
    if (!commit) {
      continue;
    }
    if (branch.current) {
      commit.refs.unshift("HEAD");
      currentLoaded = true;
    }
    if (!commit.refs.includes(branch.name)) {
      commit.refs.push(branch.name);
    }
  }
  return (
    currentLoaded ||
    !currentBranch ||
    !visibleRefs.has(currentBranch.name)
  );
}
