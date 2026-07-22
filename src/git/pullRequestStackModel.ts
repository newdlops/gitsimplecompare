// GitHub Pull Request의 base/head 관계를 스택 구조로 변환하는 순수 모델 모듈.
// - gh CLI나 VS Code에 의존하지 않아 서비스, 웹뷰, 테스트가 같은 토폴로지 규칙을 공유한다.
// - 선형 스택뿐 아니라 하나의 PR 위에서 여러 PR이 갈라지는 트리 형태도 손실 없이 표현한다.

/** PR Stack Graph와 명령이 공통으로 사용하는 Pull Request 한 건 */
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
  /** OPEN, CLOSED, MERGED 중 GitHub Pull Request 상태 */
  state?: string;
  /** GitHub가 보고한 head branch tip commit OID */
  headHash?: string;
  /** GitHub가 보고한 base branch tip commit OID */
  baseHash?: string;
  /** merge/squash/rebase 뒤 base history에 남은 commit OID */
  mergeHash?: string;
}

/** 로컬 stack 메타데이터와 branch 상태를 합쳐 graph 모델에 넣는 한 branch */
export interface StackLocalBranch {
  /** 로컬 branch short name */
  name: string;
  /** 현재 로컬 branch tip commit OID */
  hash: string;
  /** origin/branch 형태의 upstream 이름 */
  upstream?: string;
  /** upstream tracking ref의 현재 commit OID */
  upstreamHash?: string;
  /** 마지막 commit 제목 */
  subject?: string;
  /** Git Simple Compare가 기록한 바로 아래 parent branch */
  parentBranch?: string;
  /** 마지막 restack 때 branch가 올라갔던 parent tip OID */
  parentHead?: string;
  /** branch가 checkout된 worktree 절대 경로 */
  worktreePath?: string;
}

/** Git Graph에 표시하고 stack 작업의 대상을 식별하는 통합 layer */
export interface PullRequestStackLayer {
  /** layer의 로컬/원격 branch 이름 */
  branch: string;
  /** 바로 아래 layer 또는 일반 target branch */
  parentBranch: string;
  /** graph row에 layer chip을 붙일 head commit OID */
  headHash?: string;
  /** graph에서 PR 흐름의 도착점으로 쓸 parent tip OID */
  parentHash?: string;
  /** 마지막 restack 당시 parent tip. 현재 parentHash와 다르면 재정렬 대상이다. */
  recordedParentHead?: string;
  /** root layer를 0으로 둔 stack 표시 깊이 */
  depth: number;
  /** 바로 위 child layer branch 이름 */
  childBranches: string[];
  /** 로컬 branch가 있어 자동 git 작업을 수행할 수 있는지 여부 */
  local: boolean;
  /** branch가 checkout된 worktree 절대 경로 */
  worktreePath?: string;
  /** 연결된 GitHub Pull Request. 아직 submit하지 않았으면 비어 있다. */
  pullRequest?: StackPullRequest;
  /** 로컬 tip과 upstream tip이 다른지 여부 */
  remoteDiverged: boolean;
  /** parent가 움직였거나 현재 parent가 branch 조상이 아니어서 restack이 필요한지 여부 */
  needsRestack: boolean;
}

/** Git Graph에서 하나의 연결된 PR 흐름으로 그릴 stack */
export interface PullRequestStackGraph {
  /** 렌더링과 action context에 사용할 안정적인 식별자 */
  id: string;
  /** 가장 아래 layer가 대상으로 삼는 일반 branch */
  rootBaseRefName: string;
  /** 부모가 먼저 나오는 깊이 우선 순서의 layer 목록 */
  layers: PullRequestStackLayer[];
}

/** Git Graph로 보내는 로컬 branch + GitHub PR 통합 stack 스냅샷 */
export interface PullRequestStackGraphSnapshot {
  /** owner/name 형태 GitHub 저장소 이름. GitHub를 읽지 못하면 빈 문자열이다. */
  repository: string;
  /** 저장소 기본 branch 이름 */
  defaultBranch?: string;
  /** 연결 관계가 계산된 stack 목록 */
  stacks: PullRequestStackGraph[];
  /** graph action 후보와 PR 상세 연결에 사용할 전체 layer 평탄화 목록 */
  layers: PullRequestStackLayer[];
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

/** GitHub PR 관계만으로 계산하는 저장소 단위 스냅샷 */
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
 * 로컬 parent 메타데이터와 GitHub PR base/head 관계를 하나의 graph stack 모델로 합친다.
 * - 열린 PR 관계를 우선하되 아직 submit하지 않은 로컬 branch는 저장된 parent를 사용한다.
 * - 오래된 merged PR은 열린/로컬 child의 parent일 때만 남겨 Advance 동작의 문맥을 보존한다.
 * - 잘못된 메타데이터 cycle은 방문 집합으로 끊어 모든 layer를 한 번만 표시한다.
 * @param localBranches 로컬 branch와 stack parent 메타데이터
 * @param pullRequests graph가 이미 읽은 GitHub Pull Request 목록
 * @param repository owner/name 형태 저장소 이름
 * @param defaultBranch 저장소 기본 branch 이름
 * @returns Git Graph 장식과 stack action이 공유할 통합 스냅샷
 */
export function buildPullRequestStackGraph(
  localBranches: readonly StackLocalBranch[],
  pullRequests: readonly StackPullRequest[],
  repository = "",
  defaultBranch?: string
): PullRequestStackGraphSnapshot {
  const locals = new Map(localBranches.map((branch) => [branch.name, branch]));
  const relevant = relevantGraphPullRequests(pullRequests, localBranches);
  const pullRequestByHead = preferredPullRequestByHead(relevant);
  const branchNames = new Set<string>();
  for (const branch of localBranches) {
    if (branch.parentBranch || pullRequestByHead.has(branch.name)) {
      branchNames.add(branch.name);
    }
  }
  for (const pr of relevant) {
    branchNames.add(pr.headRefName);
  }

  const layerByBranch = new Map<string, PullRequestStackLayer>();
  for (const branch of [...branchNames].sort((a, b) => a.localeCompare(b))) {
    const local = locals.get(branch);
    const pr = pullRequestByHead.get(branch);
    const parentBranch = pr?.baseRefName || local?.parentBranch || defaultBranch || "";
    if (!parentBranch || parentBranch === branch) {
      continue;
    }
    const headHash = local?.hash || pr?.headHash;
    const parentHash = resolveGraphParentHash(parentBranch, locals, pullRequestByHead, pr);
    layerByBranch.set(branch, {
      branch,
      parentBranch,
      headHash,
      parentHash,
      recordedParentHead: local?.parentHead,
      depth: 0,
      childBranches: [],
      local: Boolean(local),
      worktreePath: local?.worktreePath,
      pullRequest: pr,
      remoteDiverged: Boolean(local?.upstreamHash && local.upstreamHash !== local.hash),
      needsRestack: Boolean(
        local && parentHash && local.parentHead && local.parentHead !== parentHash
      ),
    });
  }

  for (const layer of layerByBranch.values()) {
    const parent = layerByBranch.get(layer.parentBranch);
    if (parent && parent.branch !== layer.branch) {
      parent.childBranches.push(layer.branch);
      parent.childBranches.sort((a, b) => a.localeCompare(b));
    }
  }
  const roots = [...layerByBranch.values()].filter(
    (layer) => !layerByBranch.has(layer.parentBranch)
  );
  const visited = new Set<string>();
  const stacks: PullRequestStackGraph[] = [];
  for (const root of [...roots, ...layerByBranch.values()]) {
    if (visited.has(root.branch)) {
      continue;
    }
    const layers: PullRequestStackLayer[] = [];
    visitGraphLayer(root, 0, layerByBranch, visited, layers);
    if (layers.length) {
      stacks.push({
        id: `stack-${root.branch}`,
        rootBaseRefName: root.parentBranch,
        layers,
      });
    }
  }
  stacks.sort((left, right) => left.layers[0].branch.localeCompare(right.layers[0].branch));
  return {
    repository,
    defaultBranch,
    stacks,
    layers: stacks.flatMap((stack) => stack.layers),
  };
}

/**
 * graph에 남길 PR 범위를 열린 PR과 그 parent가 되는 merged PR로 줄인다.
 * @param pullRequests graph pager가 읽은 전체 상태 PR
 * @param localBranches 로컬 stack parent 관계
 * @returns stack 흐름과 Advance에 필요한 PR 목록
 */
function relevantGraphPullRequests(
  pullRequests: readonly StackPullRequest[],
  localBranches: readonly StackLocalBranch[]
): StackPullRequest[] {
  const referencedHeads = new Set(
    localBranches.map((branch) => branch.parentBranch).filter((value): value is string => Boolean(value))
  );
  for (const pr of pullRequests) {
    if ((pr.state || "OPEN").toUpperCase() === "OPEN") {
      referencedHeads.add(pr.baseRefName);
    }
  }
  return pullRequests.filter((pr) =>
    Boolean(pr.headRefName) && (
      (pr.state || "OPEN").toUpperCase() === "OPEN" ||
      referencedHeads.has(pr.headRefName)
    )
  );
}

/**
 * 같은 head 이름의 PR이 여러 개면 열린 PR, 이후 큰 번호 순으로 대표 PR을 고른다.
 * @param pullRequests head별 후보 PR 목록
 * @returns branch 이름으로 조회하는 대표 PR map
 */
function preferredPullRequestByHead(
  pullRequests: readonly StackPullRequest[]
): Map<string, StackPullRequest> {
  const result = new Map<string, StackPullRequest>();
  for (const pr of [...pullRequests].sort((left, right) => {
    const leftOpen = (left.state || "OPEN").toUpperCase() === "OPEN";
    const rightOpen = (right.state || "OPEN").toUpperCase() === "OPEN";
    return Number(rightOpen) - Number(leftOpen) || right.number - left.number;
  })) {
    if (!result.has(pr.headRefName)) {
      result.set(pr.headRefName, pr);
    }
  }
  return result;
}

/**
 * parent branch가 가리키는 현재 commit을 로컬 branch, parent PR, 현재 PR base OID 순으로 찾는다.
 * @param parentBranch parent branch short name
 * @param locals 로컬 branch map
 * @param pullRequests head branch별 대표 PR map
 * @param childPr 현재 child layer PR
 * @returns graph flow 도착점 commit OID
 */
function resolveGraphParentHash(
  parentBranch: string,
  locals: Map<string, StackLocalBranch>,
  pullRequests: Map<string, StackPullRequest>,
  childPr?: StackPullRequest
): string | undefined {
  return locals.get(parentBranch)?.hash
    || pullRequests.get(parentBranch)?.headHash
    || (childPr?.baseRefName === parentBranch ? childPr.baseHash : undefined);
}

/**
 * 통합 layer 트리를 부모 우선 DFS 순서로 평탄화하면서 depth를 채운다.
 * @param layer 현재 방문 layer
 * @param depth root 기준 표시 깊이
 * @param byBranch 전체 layer map
 * @param visited cycle/중복 방지 집합
 * @param output 결과를 누적할 배열
 */
function visitGraphLayer(
  layer: PullRequestStackLayer,
  depth: number,
  byBranch: Map<string, PullRequestStackLayer>,
  visited: Set<string>,
  output: PullRequestStackLayer[]
): void {
  if (visited.has(layer.branch)) {
    return;
  }
  visited.add(layer.branch);
  layer.depth = depth;
  output.push(layer);
  for (const child of layer.childBranches) {
    const next = byBranch.get(child);
    if (next) {
      visitGraphLayer(next, depth + 1, byBranch, visited, output);
    }
  }
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
