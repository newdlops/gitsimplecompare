// 검색·PR·reflog 점프가 사용할 bounded Graph window 조회를 패널 상태에서 분리한 모듈.
// - Git 조회와 branch ref 필터링만 담당하고, 선택/스크롤/게시 여부는 GraphPanel이 결정한다.
import { loadCommitWindowAroundWithRange } from "../git/gitLogWindow";
import type { Commit } from "../graph/graphTypes";
import { filterCommitRefs } from "./graphBranchFilter";
import type { ResolvedGraphBranchFilter } from "./graphBranchFilter";
import { loadGraphReflogCommitWindow } from "./graphReflogCommitFocus";

/** 일반 ref 범위에서 target 주변 commit과 전체 offset을 보존한 결과다. */
export interface GraphCommitWindowResult {
  hash: string;
  commits: Commit[];
  startIndex: number;
  totalCount: number;
}

/** reflog 복구 점프가 현재 ref 범위와 무관하게 표시할 결과다. */
export interface GraphReflogWindowResult {
  hash: string;
  commits: Commit[];
}

/**
 * 후보 hash를 순서대로 확인해 현재 branch filter 안에서 찾은 첫 commit window를 반환한다.
 * @param repoRoot Git 저장소 또는 linked worktree 루트
 * @param hashes PR head 등 동일 대상을 나타낼 수 있는 후보 hash 목록
 * @param branchFilter 현재 Graph의 ref·표시 필터
 * @param pageSize target 뒤쪽에 유지할 최대 기본 commit 수
 * @returns target을 포함한 filtered window, 찾지 못하면 undefined
 */
export async function loadFilteredGraphCommitWindow(
  repoRoot: string,
  hashes: readonly string[],
  branchFilter: ResolvedGraphBranchFilter,
  pageSize: number
): Promise<GraphCommitWindowResult | undefined> {
  for (const hash of hashes) {
    const targetHash = hash.trim();
    const window = await loadCommitWindowAroundWithRange(
      repoRoot,
      targetHash,
      { before: 80, after: pageSize, refs: branchFilter.refs }
    ).catch(() => ({ commits: [], startIndex: 0, targetIndex: -1, totalCount: 0 }));
    if (!window.commits.some((commit) => commit.hash === targetHash)) continue;
    return {
      hash: targetHash,
      commits: filterCommitRefs(window.commits, branchFilter),
      startIndex: window.startIndex,
      totalCount: window.totalCount,
    };
  }
  return undefined;
}

/**
 * reflog hash 주변 복구용 window를 현재 branch filter와 무관하게 읽는다.
 * @param repoRoot 대상 저장소 루트
 * @param hash reflog 항목이 가리키는 commit hash
 * @param pageSize 복구 window 최대 commit 수
 * @returns 실제 commit이 있으면 정규화한 hash와 commit 배열
 */
export async function loadReflogGraphWindow(
  repoRoot: string,
  hash: string,
  pageSize: number
): Promise<GraphReflogWindowResult | undefined> {
  const targetHash = hash.trim();
  const window = await loadGraphReflogCommitWindow(repoRoot, targetHash, pageSize);
  return window ? { hash: targetHash, commits: window.commits } : undefined;
}
