// graph 웹뷰의 브랜치 표시 필터를 계산하는 순수 헬퍼.
// - GitGraphPanel 은 상태 보관/메시지 라우팅만 맡고, 필터 정책은 이 파일에 둔다.
import type { Commit, LocalBranchStatus } from "../graph/graphTypes";

/** 그래프 브랜치 필터의 동작 모드 */
export type GraphBranchFilterMode = "all" | "custom";

/** git 에 존재하는 표시 가능한 브랜치 ref 한 건 */
export interface GraphBranchRef {
  name: string;
  kind: "local" | "remote";
}

/** 웹뷰가 보낸 브랜치 필터 상태 */
export interface GraphBranchFilterState {
  mode: GraphBranchFilterMode;
  selected: string[];
  compact: boolean;
}

/** 웹뷰 체크박스 목록에 표시할 브랜치 한 건 */
export interface GraphBranchFilterOption extends GraphBranchRef {
  checked: boolean;
  current: boolean;
}

/** 확장에서 웹뷰로 보내는 브랜치 필터 스냅샷 */
export interface GraphBranchFilterSnapshot {
  mode: GraphBranchFilterMode;
  selected: string[];
  compact: boolean;
  branches: GraphBranchFilterOption[];
}

/** 현재 필터 상태를 git log 호출과 ref 표시 필터링에 쓸 수 있게 해석한 값 */
export interface ResolvedGraphBranchFilter {
  mode: GraphBranchFilterMode;
  refs: string[];
  filtersRefs: boolean;
  empty: boolean;
  visibleRefs: Set<string>;
}

/**
 * 웹뷰에서 온 브랜치 필터 메시지를 안전한 상태 객체로 정규화한다.
 * @param mode 사용자가 선택한 필터 모드
 * @param selected custom 모드에서 체크된 브랜치 이름 목록
 * @returns 중복과 빈 값을 제거한 필터 상태
 */
export function normalizeBranchFilterState(
  mode: GraphBranchFilterMode,
  selected: readonly string[] = [],
  compact = true
): GraphBranchFilterState {
  return {
    mode,
    selected: unique(selected.map((item) => item.trim()).filter(Boolean)),
    compact,
  };
}

/**
 * 현재 필터 상태를 git log ref 목록으로 변환한다.
 * @param state 사용자가 선택한 필터 상태
 * @param branchRefs 현재 저장소의 전체 로컬/원격 브랜치 목록
 * @returns git log 에 넘길 refs 와 ref 표시 필터링 정보
 */
export function resolveBranchFilter(
  state: GraphBranchFilterState,
  branchRefs: readonly GraphBranchRef[]
): ResolvedGraphBranchFilter {
  const known = new Set(branchRefs.map((branch) => branch.name));
  if (state.mode === "all") {
    return {
      mode: state.mode,
      refs: [],
      filtersRefs: false,
      empty: false,
      visibleRefs: known,
    };
  }
  const selected = state.selected.filter((name) => known.has(name));
  return {
    mode: state.mode,
    refs: selected,
    filtersRefs: true,
    empty: selected.length === 0,
    visibleRefs: new Set(selected),
  };
}

/**
 * 웹뷰 체크박스 UI 가 즉시 그릴 수 있는 브랜치 필터 스냅샷을 만든다.
 * @param branchRefs 현재 저장소의 전체 로컬/원격 브랜치 목록
 * @param localBranches 로컬 브랜치 상태 목록
 * @param state 현재 필터 상태
 * @returns 체크 여부가 들어간 표시용 데이터
 */
export function buildBranchFilterSnapshot(
  branchRefs: readonly GraphBranchRef[],
  localBranches: readonly LocalBranchStatus[],
  state: GraphBranchFilterState
): GraphBranchFilterSnapshot {
  const resolved = resolveBranchFilter(state, branchRefs);
  const current = new Set(
    localBranches.filter((branch) => branch.current).map((branch) => branch.name)
  );
  const branches = [...branchRefs]
    .sort(compareBranchRefs(current))
    .map((branch) => ({
      ...branch,
      current: current.has(branch.name),
      checked: !resolved.filtersRefs || resolved.visibleRefs.has(branch.name),
    }));
  return {
    mode: state.mode,
    selected: resolved.filtersRefs
      ? branches.filter((branch) => branch.checked).map((branch) => branch.name)
      : branches.map((branch) => branch.name),
    compact: state.compact,
    branches,
  };
}

/**
 * 필터가 all 이 아닐 때 커밋 decoration 의 브랜치 ref 를 활성 브랜치만 남긴다.
 * - git log 범위는 이미 refs 로 제한하지만, 공유 커밋에 붙은 다른 브랜치 chip 까지
 *   보이면 사용자가 필터가 적용되지 않았다고 느끼므로 표시용 ref 도 함께 줄인다.
 * @param commits git log 에서 읽은 커밋 목록
 * @param filter 해석된 브랜치 필터
 * @returns 표시용 ref 가 정리된 커밋 목록
 */
export function filterCommitRefs(
  commits: readonly Commit[],
  filter: ResolvedGraphBranchFilter
): Commit[] {
  if (!filter.filtersRefs) {
    return [...commits];
  }
  return commits.map((commit) => ({
    ...commit,
    refs: commit.refs.filter((ref) => keepRef(ref, filter.visibleRefs)),
    localOnlyBranches: commit.localOnlyBranches?.filter((branch) =>
      filter.visibleRefs.has(branch)
    ),
  }));
}

/**
 * 현재 브랜치가 필터에서 보이는지 확인해 ongoing/staged 가상 노드 표시 여부를 결정한다.
 * @param filter 해석된 브랜치 필터
 * @param localBranches 로컬 브랜치 상태 목록
 * @returns 작업트리 가상 노드를 표시해도 되는 경우 true
 */
export function shouldShowVirtualCommits(
  filter: ResolvedGraphBranchFilter,
  localBranches: readonly LocalBranchStatus[]
): boolean {
  if (!filter.filtersRefs) {
    return true;
  }
  const current = localBranches.find((branch) => branch.current)?.name;
  return Boolean(current && filter.visibleRefs.has(current));
}

/**
 * 브랜치 ref 정렬 함수를 만든다.
 * @param current 현재 checkout 된 브랜치 이름 집합
 * @returns current → local → remote → 이름순 비교 함수
 */
function compareBranchRefs(current: Set<string>) {
  return (a: GraphBranchRef, b: GraphBranchRef): number => {
    if (current.has(a.name) !== current.has(b.name)) {
      return current.has(a.name) ? -1 : 1;
    }
    if (a.kind !== b.kind) {
      return a.kind === "local" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  };
}

/**
 * 표시용 ref 를 필터 결과에 남길지 결정한다.
 * @param ref 커밋 decoration ref 문자열
 * @param visibleRefs 사용자가 활성화한 브랜치 이름 집합
 * @returns ref 를 표시해야 하면 true
 */
function keepRef(ref: string, visibleRefs: Set<string>): boolean {
  return (
    ref === "HEAD" ||
    ref.startsWith("tag:") ||
    ref.startsWith("virtual:") ||
    visibleRefs.has(ref)
  );
}

/**
 * 입력 배열의 순서를 유지하면서 중복 값을 제거한다.
 * @param values 중복 제거 대상 문자열 목록
 * @returns 첫 등장 순서만 남긴 문자열 목록
 */
function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}
