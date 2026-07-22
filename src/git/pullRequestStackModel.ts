// GitHub Pull Request의 base/head 관계를 스택 구조로 변환하는 순수 모델 모듈.
// - gh CLI나 VS Code에 의존하지 않아 서비스, 웹뷰, 테스트가 같은 토폴로지 규칙을 공유한다.
// - 선형 스택뿐 아니라 하나의 PR 위에서 여러 PR이 갈라지는 트리 형태도 손실 없이 표현한다.

/** PR Stacks 화면과 명령이 공통으로 사용하는 열린 Pull Request 한 건 */
export interface StackPullRequest {
  /** GitHub Pull Request 번호 */
  number: number;
  /** Pull Request 제목 */
  title: string;
  /** github.com에서 Pull Request를 여는 URL */
  url: string;
  /** 변경이 들어 있는 head branch 이름 */
  headRefName: string;
  /** head branch가 base 저장소가 아닌 fork 저장소에 있는지 여부 */
  isCrossRepository?: boolean;
  /** fork PR일 때 head 저장소 owner login */
  headRepositoryOwner?: string;
  /** 변경이 합쳐질 base branch 이름 */
  baseRefName: string;
  /** Pull Request 작성자 login */
  author: string;
  /** Draft Pull Request 여부 */
  isDraft: boolean;
  /** APPROVED, CHANGES_REQUESTED 같은 GitHub review 판정 */
  reviewDecision?: string;
  /** CLEAN, BLOCKED, BEHIND 같은 GitHub merge 가능 상태 */
  mergeStateStatus?: string;
  /** GitHub가 보고한 마지막 갱신 시각 */
  updatedAt?: string;
}

/** 스택 안에서 부모/깊이 정보를 덧붙인 Pull Request 행 */
export interface PullRequestStackEntry extends StackPullRequest {
  /** 스택의 root PR을 0으로 둔 표시 깊이 */
  depth: number;
  /** base가 가리키는 다른 열린 PR 번호. 일반 브랜치가 base면 비어 있다. */
  parentNumber?: number;
  /** 이 PR을 base로 사용하는 바로 다음 PR 번호들 */
  childNumbers: number[];
}

/** 같은 base/head 연결 성분에 속하는 PR 묶음 */
export interface PullRequestStack {
  /** 렌더링 key로 사용할 안정적인 식별자 */
  id: string;
  /** 가장 아래 PR이 대상으로 삼는 일반 base branch */
  rootBaseRefName: string;
  /** 더 이상 child가 없는 스택 끝 branch 목록 */
  leafHeadRefNames: string[];
  /** 부모가 자식보다 먼저 나오는 깊이 우선 순서의 PR 목록 */
  pullRequests: PullRequestStackEntry[];
}

/** PR Stacks 섹션에 보낼 저장소 단위 스냅샷 */
export interface PullRequestStacksSnapshot {
  /** owner/name 형태의 GitHub 저장소 이름 */
  repository: string;
  /** GitHub 기본 branch 이름 */
  defaultBranch?: string;
  /** 조회한 열린 Pull Request 전체 */
  pullRequests: StackPullRequest[];
  /** base/head 관계로 구성한 스택 목록 */
  stacks: PullRequestStack[];
}

/** 내부 DFS가 사용할 parent/children 인덱스 */
interface StackIndexes {
  byNumber: Map<number, StackPullRequest>;
  parentByNumber: Map<number, number>;
  childrenByNumber: Map<number, number[]>;
}

/**
 * 열린 Pull Request를 `PR.baseRefName === parent.headRefName` 규칙으로 스택에 묶는다.
 * - 같은 head 이름이 중복되면 어느 PR이 부모인지 단정하지 않고 각각 root로 남긴다.
 * - 잘못된 외부 데이터에 cycle이 있어도 방문 집합으로 유한하게 끝내고 모든 PR을 한 번씩 표시한다.
 * @param pullRequests GitHub에서 읽은 열린 Pull Request 목록
 * @returns root base와 depth가 계산된 스택 목록
 */
export function buildPullRequestStacks(
  pullRequests: readonly StackPullRequest[]
): PullRequestStack[] {
  const normalized = normalizePullRequests(pullRequests);
  const indexes = buildIndexes(normalized);
  const visited = new Set<number>();
  const stacks: PullRequestStack[] = [];
  const roots = normalized.filter((pr) => !indexes.parentByNumber.has(pr.number));

  for (const root of roots) {
    const stack = buildStack(root, indexes, visited);
    if (stack.pullRequests.length) {
      stacks.push(stack);
    }
  }
  // cycle 또는 모호한 관계 때문에 root 탐색에서 방문하지 못한 항목도 별도 스택으로 보존한다.
  for (const pr of normalized) {
    if (!visited.has(pr.number)) {
      stacks.push(buildStack(pr, indexes, visited));
    }
  }
  return stacks.sort(compareStacks);
}

/**
 * PR의 base를 바꿀 때 cycle을 만들 수 있는 branch 이름을 계산한다.
 * - 자기 head와 모든 하위 PR head를 base로 고르면 base/head 연결이 순환하므로 후보에서 제외해야 한다.
 * @param pullRequests 현재 열린 Pull Request 목록
 * @param number base를 바꿀 Pull Request 번호
 * @returns 선택할 수 없는 head branch 이름 집합
 */
export function invalidPullRequestBaseBranches(
  pullRequests: readonly StackPullRequest[],
  number: number
): Set<string> {
  const normalized = normalizePullRequests(pullRequests);
  const indexes = buildIndexes(normalized);
  const invalid = new Set<string>();
  const pending = [number];
  const visited = new Set<number>();
  while (pending.length) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const pr = indexes.byNumber.get(current);
    if (pr?.headRefName) {
      invalid.add(pr.headRefName);
    }
    pending.push(...(indexes.childrenByNumber.get(current) || []));
  }
  return invalid;
}

/**
 * 특정 PR의 base 변경 QuickPick에 넣을 안전한 branch 후보를 만든다.
 * - base 저장소에 있는 다른 스택 PR의 head, 현재 PR들이 사용하는 root base, 기본 branch 순서로 모은다.
 * - fork PR의 head는 base 저장소 branch가 아니므로 재연결 후보에서 제외한다.
 * @param snapshot 현재 저장소의 PR stack 스냅샷
 * @param number base를 바꿀 Pull Request 번호
 * @returns 중복과 cycle 후보가 제거된 branch 이름 배열
 */
export function pullRequestBaseCandidates(
  snapshot: PullRequestStacksSnapshot,
  number: number
): string[] {
  const invalid = invalidPullRequestBaseBranches(snapshot.pullRequests, number);
  const result: string[] = [];
  const append = (branch?: string): void => {
    const value = branch?.trim();
    if (value && !invalid.has(value) && !result.includes(value)) {
      result.push(value);
    }
  };
  for (const pr of snapshot.pullRequests) {
    if (!pr.isCrossRepository) {
      append(pr.headRefName);
    }
  }
  for (const pr of snapshot.pullRequests) {
    append(pr.baseRefName);
  }
  append(snapshot.defaultBranch);
  return result;
}

/**
 * API 응답에서 UI 관계 계산에 사용할 수 있는 PR만 복사하고 결정적인 순서로 정렬한다.
 * @param pullRequests 정규화 전 PR 목록
 * @returns 번호/head가 유효하고 번호가 오름차순인 새 배열
 */
function normalizePullRequests(
  pullRequests: readonly StackPullRequest[]
): StackPullRequest[] {
  const byNumber = new Map<number, StackPullRequest>();
  for (const pr of pullRequests) {
    if (!Number.isFinite(pr.number) || pr.number <= 0 || !pr.headRefName.trim()) {
      continue;
    }
    byNumber.set(pr.number, {
      ...pr,
      headRefName: pr.headRefName.trim(),
      baseRefName: pr.baseRefName.trim(),
    });
  }
  return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
}

/**
 * PR 번호, 단일 head 부모, 자식 목록 인덱스를 한 번에 만든다.
 * @param pullRequests 정규화된 PR 목록
 * @returns stack DFS에서 재사용할 조회 인덱스
 */
function buildIndexes(pullRequests: StackPullRequest[]): StackIndexes {
  const byNumber = new Map(pullRequests.map((pr) => [pr.number, pr]));
  const byHead = new Map<string, StackPullRequest[]>();
  for (const pr of pullRequests) {
    // fork의 head branch는 base 저장소에 없으므로 다른 PR의 base가 가리킬 수 없다.
    if (pr.isCrossRepository) {
      continue;
    }
    const sameHead = byHead.get(pr.headRefName) || [];
    sameHead.push(pr);
    byHead.set(pr.headRefName, sameHead);
  }
  const parentByNumber = new Map<number, number>();
  const childrenByNumber = new Map<number, number[]>();
  for (const pr of pullRequests) {
    const parents = byHead.get(pr.baseRefName) || [];
    if (parents.length !== 1 || parents[0].number === pr.number) {
      continue;
    }
    const parent = parents[0];
    parentByNumber.set(pr.number, parent.number);
    const children = childrenByNumber.get(parent.number) || [];
    children.push(pr.number);
    children.sort((a, b) => a - b);
    childrenByNumber.set(parent.number, children);
  }
  return { byNumber, parentByNumber, childrenByNumber };
}

/**
 * root 후보에서 깊이 우선으로 한 스택을 구성한다.
 * @param root 스택의 첫 PR 후보
 * @param indexes 전체 PR 관계 인덱스
 * @param visited 전체 호출이 공유하는 방문 집합
 * @returns 표시 순서와 leaf branch가 계산된 스택
 */
function buildStack(
  root: StackPullRequest,
  indexes: StackIndexes,
  visited: Set<number>
): PullRequestStack {
  const entries: PullRequestStackEntry[] = [];
  const visit = (number: number, depth: number): void => {
    if (visited.has(number)) {
      return;
    }
    const pr = indexes.byNumber.get(number);
    if (!pr) {
      return;
    }
    visited.add(number);
    const childNumbers = (indexes.childrenByNumber.get(number) || [])
      .filter((child) => !visited.has(child));
    entries.push({
      ...pr,
      depth,
      parentNumber: indexes.parentByNumber.get(number),
      childNumbers,
    });
    for (const child of childNumbers) {
      visit(child, depth + 1);
    }
  };
  visit(root.number, 0);
  const memberNumbers = new Set(entries.map((entry) => entry.number));
  const leaves = entries
    .filter((entry) => !entry.childNumbers.some((number) => memberNumbers.has(number)))
    .map((entry) => entry.headRefName);
  return {
    id: `pr-stack-${root.number}`,
    rootBaseRefName: root.baseRefName,
    leafHeadRefNames: Array.from(new Set(leaves)),
    pullRequests: entries,
  };
}

/**
 * 최근 갱신된 스택을 먼저, 시각이 같으면 root PR 번호순으로 정렬한다.
 * @param left 왼쪽 스택
 * @param right 오른쪽 스택
 * @returns Array.sort 비교값
 */
function compareStacks(left: PullRequestStack, right: PullRequestStack): number {
  const leftUpdated = Math.max(
    ...left.pullRequests.map((pr) => Date.parse(pr.updatedAt || "") || 0)
  );
  const rightUpdated = Math.max(
    ...right.pullRequests.map((pr) => Date.parse(pr.updatedAt || "") || 0)
  );
  return rightUpdated - leftUpdated
    || (left.pullRequests[0]?.number || 0) - (right.pullRequests[0]?.number || 0);
}
