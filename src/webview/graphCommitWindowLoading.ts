// 검색·PR·reflog 점프가 사용할 bounded Graph window 조회를 패널 상태에서 분리한 모듈.
// - Git 조회와 branch ref 필터링만 담당하고, 선택/스크롤/게시 여부는 GraphPanel이 결정한다.
import { findLocalCommitCandidates } from "../git/gitLogWindow";
import { loadGraphHistoryWindow, readAvailableGraphRoots, type GraphHistoryScope } from "../git/graphHistoryScope";
import type { Commit } from "../graph/graphTypes";
import { filterCommitRefs } from "./graphBranchFilter";
import type { ResolvedGraphBranchFilter } from "./graphBranchFilter";
import { loadGraphReflogCommitWindow } from "./graphReflogCommitFocus";
import { logInfo, logWarn } from "../ui/outputLog";
import { GitError, isGitLifecycleError } from "../git/gitError";
import type { PullRequestInfo } from "../git/pullRequestInfo";
import { fetchPullRequestGraphObjects, pullRequestGraphHashes, resolvePullRequestGraphTarget } from "../git/pullRequestGraphTarget";

/** 일반 ref 범위에서 target 주변 commit과 전체 offset을 보존한 결과다. */
export interface GraphCommitWindowResult {
  hash: string;
  commits: Commit[];
  startIndex: number;
  totalCount: number;
  scope?: GraphHistoryScope;
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
 * @param pullRequest API·객체 보완에 사용할 선택 PR의 식별 정보
 * @param navigation previousScope는 앞서 표시한 PR roots, exactHash는 대표 head로 대체하지 않을 개별 OID다.
 * @returns target을 포함한 날짜 기반 전체 window와 이후 페이지 범위. 찾지 못하면 undefined
 */
export async function loadFilteredGraphCommitWindow(
  repoRoot: string,
  hashes: readonly string[],
  branchFilter: ResolvedGraphBranchFilter,
  pageSize: number,
  signal?: AbortSignal,
  pullRequest?: PullRequestInfo,
  navigation: { previousScope?: GraphHistoryScope; exactHash?: string } = {}
): Promise<GraphCommitWindowResult | undefined> {
  signal?.throwIfAborted();
  if (navigation.exactHash && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(navigation.exactHash)) return undefined;
  if (branchFilter.empty && branchFilter.mode !== "all") return undefined;
  let pr = pullRequest && await resolvePullRequestGraphTarget(repoRoot, pullRequest, signal);
  if (navigation.exactHash) hashes = [navigation.exactHash];
  else if (pr) hashes = pullRequestGraphHashes(pr);
  if (!hashes.length) return undefined;
  let scope: GraphHistoryScope = { allRefs: branchFilter.mode === "all" && !branchFilter.filtersRefs,
    refs: [...branchFilter.refs], roots: [] };
  if (branchFilter.mode === "all") {
    let local = await findLocalCommitCandidates(repoRoot, [...hashes, pr?.headHash || ""], signal);
    let target = hashes.find(hash => local.includes(hash));
    if ((!target || navigation.exactHash && pr?.headHash && !local.includes(pr.headHash)) && pr) {
      // PR 행은 새 head로 복구할 수 있지만 개별 commit 클릭은 요청한 OID를 끝까지 유지한다.
      if (pr === pullRequest) {
        const previousHead = pr.headHash;
        pr = await resolvePullRequestGraphTarget(repoRoot, pr, signal, true);
        const latestHashes = navigation.exactHash ? hashes : pullRequestGraphHashes(pr);
        if (pr.headHash !== previousHead || hashes.length !== latestHashes.length || hashes.some((hash, index) => hash !== latestHashes[index]))
          local = await findLocalCommitCandidates(repoRoot, [...latestHashes, pr.headHash || ""], signal);
        hashes = latestHashes;
        target = hashes.find(hash => local.includes(hash));
      }
      if (!target || navigation.exactHash && pr.headHash && !local.includes(pr.headHash)) {
        await fetchPullRequestGraphObjects(repoRoot, pr, signal, { preferHead: Boolean(navigation.exactHash) });
        local = await findLocalCommitCandidates(repoRoot, [...hashes, pr.headHash || ""], signal);
        target = hashes.find(hash => local.includes(hash));
      }
    }
    if (!target) return undefined;
    hashes = [target];
    scope.roots = [...new Set([...(navigation.previousScope?.roots || []), target,
      ...(pr?.headHash && local.includes(pr.headHash) ? [pr.headHash] : [])])];
    if (branchFilter.filtersRefs) {
      // PR 목록이 먼저 도착해도 All 화면을 PR 조상만으로 고정하지 않는다. 아직 UI catalog에
      // 없는 정상 로컬/원격/tag OID도 직접 검증하고 같은 범위로 이후 페이지를 읽는다.
      scope.refs = []; scope.roots = [...new Set([...await readAvailableGraphRoots(repoRoot, signal), ...scope.roots])];
    }
  }
  let window;
  try { window = await loadGraphHistoryWindow(repoRoot, scope, hashes, 80, pageSize, signal); }
  catch (error) {
    signal?.throwIfAborted();
    if (branchFilter.mode !== "all" || !(error instanceof GitError) || isGitLifecycleError(error)
      || typeof error.code !== "number" || error.killed || error.signal) throw error;
    // 별도 손상 ref 때문에 PR의 조상 전용 화면으로 바꾸지 않는다. 정상 refs와 PR을 함께 유지한다.
    logWarn("graph commit window history unavailable; recovering valid references", { repoRoot, code: error.code });
    scope = { allRefs: false, refs: [], roots: [...new Set([...await readAvailableGraphRoots(repoRoot, signal), ...scope.roots])] };
    window = await loadGraphHistoryWindow(repoRoot, scope, hashes, 80, pageSize, signal);
  }
  if (!window.hash || !window.commits.some(commit => commit.hash === window.hash)) return undefined;
  logInfo("graph commit window timeline ready", { repoRoot, hash: window.hash, allRefs: scope.allRefs,
    refCount: scope.refs.length, additionalRoots: scope.roots.length, startIndex: window.startIndex, totalCount: window.totalCount });
  return { hash: window.hash, commits: branchFilter.mode === "all" ? window.commits : filterCommitRefs(window.commits, branchFilter),
    startIndex: window.startIndex, totalCount: window.totalCount, scope };
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
