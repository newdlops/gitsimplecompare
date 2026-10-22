// 검색·PR·reflog 점프가 사용할 bounded Graph window 조회를 패널 상태에서 분리한 모듈.
// - Git 조회와 branch ref 필터링만 담당하고, 선택/스크롤/게시 여부는 GraphPanel이 결정한다.
import { loadCommitWindowForCandidates, loadLocalCommitWindowForCandidates } from "../git/gitLogWindow";
import type { Commit } from "../graph/graphTypes";
import { filterCommitRefs } from "./graphBranchFilter";
import type { ResolvedGraphBranchFilter } from "./graphBranchFilter";
import { loadGraphReflogCommitWindow } from "./graphReflogCommitFocus";
import { logInfo } from "../ui/outputLog";
import type { PullRequestInfo } from "../git/pullRequestInfo";
import { fetchPullRequestGraphObjects, pullRequestGraphHashes, resolvePullRequestGraphTarget } from "../git/pullRequestGraphTarget";

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
 * all 모드의 내부 catalog 제한은 직접 선택한 PR 객체 조회를 막지 않으며, custom 선택 범위는 유지한다.
 * @param repoRoot Git 저장소 또는 linked worktree 루트
 * @param hashes PR head 등 동일 대상을 나타낼 수 있는 후보 hash 목록
 * @param branchFilter 현재 Graph의 ref·표시 필터
 * @param pageSize target 뒤쪽에 유지할 최대 기본 commit 수
 * @param signal 더 이상 표시하지 않을 점프 조회의 Git을 종료할 신호
 * @returns target을 포함한 filtered window, 찾지 못하면 undefined
 */
export async function loadFilteredGraphCommitWindow(
  repoRoot: string,
  hashes: readonly string[],
  branchFilter: ResolvedGraphBranchFilter,
  pageSize: number,
  signal?: AbortSignal,
  pullRequest?: PullRequestInfo
): Promise<GraphCommitWindowResult | undefined> {
  signal?.throwIfAborted();
  if (branchFilter.empty && branchFilter.mode !== "all") return undefined;
  let pr = pullRequest && await resolvePullRequestGraphTarget(repoRoot, pullRequest, signal);
  if (pr) hashes = pullRequestGraphHashes(pr);
  if (!hashes.length) return undefined;
  // 아직 검증된 ref가 없으면 암묵적인 전체 ref 조회를 건너뛰고 선택한 OID만 확인한다.
  let window = branchFilter.empty ? { commits: [], startIndex: 0, targetIndex: -1, totalCount: 0, hash: undefined }
    : await loadCommitWindowForCandidates(repoRoot, hashes,
      { before: 80, after: pageSize, refs: branchFilter.refs, signal });
  if (!window.hash && branchFilter.mode === "all") {
    if (branchFilter.filtersRefs) logInfo("graph commit window checking direct target outside catalog", {
      repoRoot, candidateCount: hashes.length, validatedRefCount: branchFilter.refs.length,
    });
    let local = await loadLocalCommitWindowForCandidates(repoRoot, hashes, pageSize, signal);
    if (!local && pr) {
      // 선택한 PR만 보완한다. 명시적 branch filter에서는 범위를 넓히거나 fetch하지 않는다.
      if (pr === pullRequest) {
        pr = await resolvePullRequestGraphTarget(repoRoot, pr, signal, true);
        const latestHashes = pullRequestGraphHashes(pr);
        // 같은 OID를 방금 확인했다면 Git을 반복하지 않는다. 갱신된 head만 새로 검증한다.
        if (hashes.length !== latestHashes.length || hashes.some((hash, index) => hash !== latestHashes[index]))
          local = await loadLocalCommitWindowForCandidates(repoRoot, latestHashes, pageSize, signal);
        hashes = latestHashes;
      }
      if (!local) {
        await fetchPullRequestGraphObjects(repoRoot, pr, signal);
        local = await loadLocalCommitWindowForCandidates(repoRoot, hashes, pageSize, signal);
      }
    }
    if (local) {
      window = local;
      logInfo("graph commit window loaded from local object", { repoRoot, candidateCount: hashes.length, commitCount: local.commits.length });
    }
  }
  if (!window.hash || !window.commits.some(commit => commit.hash === window.hash)) return undefined;
  return { hash: window.hash, commits: filterCommitRefs(window.commits, branchFilter),
    startIndex: window.startIndex, totalCount: window.totalCount };
}

/**
 * reflog hash 주변 복구용 window를 현재 branch filter와 무관하게 읽는다.
 * @param repoRoot 대상 저장소 루트
 * @param hash reflog 항목이 가리키는 commit hash
 * @param pageSize 복구 window 최대 commit 수
 * @param signal 숨김·저장소 교체 시 조회를 종료할 신호
 * @returns 실제 commit이 있으면 정규화한 hash와 commit 배열
 */
export async function loadReflogGraphWindow(
  repoRoot: string,
  hash: string,
  pageSize: number,
  signal?: AbortSignal
): Promise<GraphReflogWindowResult | undefined> {
  const targetHash = hash.trim();
  const window = await loadGraphReflogCommitWindow(repoRoot, targetHash, pageSize, signal);
  return window ? { hash: targetHash, commits: window.commits } : undefined;
}
