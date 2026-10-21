// 로컬 브랜치가 upstream/remote보다 앞선 커밋 범위를 한 번의 DAG 조회로 계산하는 모듈.
// - 브랜치마다 rev-list 프로세스를 만들지 않고 모든 관련 tip을 한 topo-order 그래프로 읽는다.
// - 먼저 원격 tip 전체를 제외한 작은 범위만 읽고(빠른 경로), upstream 브랜치의 ahead 수와
//   맞지 않을 때만 전체 이력을 읽는 정확한 경로로 되돌아간다.
// - snapshot cache와 취소 신호를 함께 소유해 Graph 세대가 바뀐 뒤 stale Git 작업이 남지 않게 한다.
import type { LocalBranchStatus } from "../graph/graphTypes";
import { logError, logInfo } from "../ui/outputLog";
import { resolveGitExecutable, runGit, runGitWithInput } from "./gitExec";
import { LocalOnlySnapshotReuse, localOnlyHistoryKey } from "./localOnlySnapshotReuse";

/** local-only 기준점으로 사용할 원격 추적 브랜치 tip이다. */
export interface LocalOnlyRemoteTip {
  name: string;
  hash: string;
}

/**
 * 단위 테스트가 rev-list 호출과 취소 신호를 검증할 수 있는 실행 함수다.
 * - input 이 있으면 revision 목록을 stdin(`--stdin`)으로 넘긴다(수천 개 tip 도 명령줄 한도와 무관).
 */
export type LocalOnlyBranchRunner = (
  args: string[],
  repoRoot: string,
  options?: { signal?: AbortSignal; input?: string }
) => Promise<string>;

/** production runner: stdin 입력이 있으면 runGitWithInput, 없으면 runGit 으로 실행한다. */
const defaultRunner: LocalOnlyBranchRunner = (args, repoRoot, options) =>
  options?.input === undefined
    ? runGit(args, repoRoot, { signal: options?.signal })
    : runGitWithInput(args, repoRoot, options.input, { signal: options.signal });

interface ReachabilityBits {
  include: bigint;
  exclude: bigint;
}

interface LocalOnlyPlan {
  name: string;
  hash: string;
  baselineHashes: string[];
  /** upstream 이 있는 브랜치의 ahead 수. 빠른 경로 결과가 정확한지 확인하는 데 쓴다. */
  expectedCount?: number;
}

/**
 * 모든 후보 브랜치의 local-only 커밋을 rev-list DAG에서 계산한다.
 * - upstream이 있으면 upstream..local, 없거나 gone이면 local --not --remotes 의미를 재현한다.
 * - upstream tip을 확인할 수 없는 브랜치는 잘못된 표시를 피하려고 이번 snapshot에서 제외한다.
 * - 빠른 경로: 원격 tip 전체를 `^` 로 제외해 원격에 없는 커밋만 읽는다. 대부분의 저장소에서 결과가
 *   수십~수천 줄이라 전체 이력(수십만 줄) 파싱을 피한다. upstream 브랜치의 결과 수가 ahead 와 다르면
 *   (다른 원격 브랜치에만 있는 커밋을 품은 경우) 전체 이력을 읽는 정확한 경로로 다시 계산한다.
 * @param repoRoot Git 명령을 실행할 저장소 또는 worktree 루트
 * @param branches Graph가 이미 읽은 로컬 브랜치 상태 snapshot
 * @param remoteTips Graph remote catalog가 이미 읽은 원격 tip snapshot
 * @param signal Graph 수명주기 변경 시 rev-list 프로세스를 종료할 신호
 * @param runner 실제 Git 명령을 실행하는 함수
 * @returns 커밋 hash별 local-only 브랜치 이름 배열
 */
export async function loadLocalOnlyBranchMap(
  repoRoot: string,
  branches: readonly LocalBranchStatus[],
  remoteTips: readonly LocalOnlyRemoteTip[],
  signal?: AbortSignal,
  runner: LocalOnlyBranchRunner = defaultRunner
): Promise<Map<string, string[]>> {
  signal?.throwIfAborted();
  const plans = buildPlans(branches, remoteTips);
  if (plans.length === 0) return new Map();
  const remoteHashes = [...new Set(remoteTips.map((tip) => tip.hash).filter(Boolean))];
  if (remoteHashes.length === 0) {
    return loadWithBaselines(repoRoot, plans, signal, runner);
  }
  const fast = await loadExcludingRemotes(repoRoot, plans, remoteHashes, signal, runner);
  if (fast.mismatched.length === 0) return fast.result;
  logInfo("graph local-only fast path mismatch", {
    repoRoot, plans: plans.length, mismatched: fast.mismatched.length,
  });
  // 어긋난 upstream 브랜치만 다시 계산한다. 적으면 같은 기준점끼리 좁은 범위를 공유한다.
  const mismatchedNames = new Set(fast.mismatched.map((plan) => plan.name));
  const groups = groupPlansByBaseline(fast.mismatched);
  // 큰 목록의 기존 한 번짜리 전체 조회를 여러 프로세스로 늘리지 않는다. 단일 기준점이면 같은 한 번으로 범위만 좁힌다.
  const exact = fast.mismatched.length <= TARGETED_PLAN_LIMIT || groups.length === 1
    ? await loadTargetedPlans(repoRoot, groups, signal, runner)
    : await loadWithBaselines(repoRoot, fast.mismatched, signal, runner);
  return mergePlanResults(plans, withoutPlans(fast.result, mismatchedNames), exact);
}

/** 작은 목록에서 기존 최대 16회보다 Git 실행 수가 늘지 않도록 좁은 범위로 계산할 plan 한도다. */
const TARGETED_PLAN_LIMIT = 16;
/** 부모 관계 출력과 membership 임시 메모리가 커지지 않도록 한 묶음의 예상 commit 합을 제한한다. */
const TARGETED_GROUP_COMMIT_LIMIT = 50_000;
/** 서로 다른 기준점 그룹의 rev-list를 동시에 실행할 최대 프로세스 수다. */
const TARGETED_GROUP_CONCURRENCY = 4;

/**
 * 원격 tip 전체를 제외한 범위만 읽어 local-only 커밋을 계산한다(빠른 경로).
 * - 결과 범위는 "원격 어디에도 없는 커밋"이므로 upstream 이 없는 브랜치에는 정확히 같은 의미다.
 * - upstream 브랜치는 결과가 upstream..local 의 부분집합이므로, 개수가 ahead 와 같을 때만 정확하다.
 * @returns 전체 결과와, ahead 수와 달라 다시 계산해야 하는 upstream 브랜치 목록
 */
async function loadExcludingRemotes(
  repoRoot: string,
  plans: readonly LocalOnlyPlan[],
  remoteHashes: readonly string[],
  signal: AbortSignal | undefined,
  runner: LocalOnlyBranchRunner
): Promise<{ result: Map<string, string[]>; mismatched: LocalOnlyPlan[] }> {
  const result = await loadExcludedRange(repoRoot, plans, remoteHashes, signal, runner);
  const counts = new Map<string, number>();
  for (const names of result.values()) {
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  // 개수 검사는 upstream 이 제외한 원격 tip 일 때만 유효하다(그래야 빠른 결과가 upstream..local 의 부분집합).
  // 로컬 브랜치를 upstream 으로 추적하는 등 기준점이 원격 tip 이 아니면 개수가 같아도 집합이 다를 수 있다.
  const excluded = new Set(remoteHashes);
  const mismatched = plans.filter((plan) =>
    plan.expectedCount !== undefined && (
      plan.baselineHashes.some((hash) => !excluded.has(hash)) ||
      (counts.get(plan.name) ?? 0) !== plan.expectedCount
    )
  );
  return { result, mismatched };
}

/**
 * 같은 제외 기준을 공유하는 tip들의 합집합만 읽고 각 tip의 membership을 부모로 전파한다.
 * @param repoRoot 저장소 @param plans 결과에 이름을 붙일 브랜치 @param excludedHashes 모든 plan에 공통인 제외 기준점
 * @param signal 취소 수명 @param runner 공통 Git 실행기 @returns 각 브랜치가 자기 tip에서 도달하는 정확한 범위
 */
async function loadExcludedRange(repoRoot: string, plans: readonly LocalOnlyPlan[], excludedHashes: readonly string[],
  signal: AbortSignal | undefined, runner: LocalOnlyBranchRunner): Promise<Map<string, string[]>> {
  const states = new Map<string, ReachabilityBits>();
  plans.forEach((plan, index) => seedBits(states, plan.hash, "include", 1n << BigInt(index)));
  const tips = [...new Set(plans.map((plan) => plan.hash))];
  const output = await runner(
    ["rev-list", "--topo-order", "--parents", "--stdin"],
    repoRoot,
    { signal, input: revisionInput(tips, excludedHashes) }
  );
  signal?.throwIfAborted();
  return mapLocalOnlyCommits(output, plans, states);
}

/**
 * 제외 집합이 정확히 같은 plan만 묶어 다른 upstream의 커밋을 잘못 빼지 않는다.
 * @param plans 정확한 범위를 읽을 브랜치 @returns 최초 plan 순서를 유지하는 기준점별 그룹. 큰 예상 출력은 나눠 기존 메모리 한도를 보호한다.
 */
function groupPlansByBaseline(plans: readonly LocalOnlyPlan[]): LocalOnlyPlan[][] {
  const grouped = new Map<string, { plans: LocalOnlyPlan[]; commits: number }>(), groups: LocalOnlyPlan[][] = [];
  for (const plan of plans) {
    const key = JSON.stringify([...new Set(plan.baselineHashes)].sort());
    const cost = Number.isSafeInteger(plan.expectedCount) && plan.expectedCount! > 0 ? plan.expectedCount! : Infinity;
    let group = grouped.get(key);
    if (!group || group.commits + cost > TARGETED_GROUP_COMMIT_LIMIT) {
      group = { plans: [], commits: 0 }; grouped.set(key, group); groups.push(group.plans);
    }
    group.plans.push(plan); group.commits += cost;
  }
  return groups;
}

/**
 * 한 브랜치는 기존 hash-only 범위 조회를, 같은 기준점의 여러 브랜치는 부모 관계가 있는 합집합 조회를 사용한다.
 * @param repoRoot 저장소 @param group 공통 제외 집합을 확인한 plan @param signal 현재 그룹의 수명 @param runner Git 실행기
 * @returns 커밋별 정확한 브랜치 membership. 큰 원본 출력은 취소 뒤 파싱하지 않는다.
 */
async function readTargetedGroup(repoRoot: string, group: readonly LocalOnlyPlan[], signal: AbortSignal,
  runner: LocalOnlyBranchRunner): Promise<Map<string, string[]>> {
  if (group.length > 1) return loadExcludedRange(repoRoot, group, group[0].baselineHashes, signal, runner);
  const plan = group[0], output = await runner(["rev-list", "--stdin"], repoRoot,
    { signal, input: revisionInput([plan.hash], plan.baselineHashes) });
  signal.throwIfAborted();
  return new Map(output.split("\n").map(line => line.trim()).filter(Boolean).map(hash => [hash, [plan.name]]));
}

/**
 * 기준점이 같은 브랜치는 한 번의 union 범위 조회로 계산하고 서로 다른 기준점은 섞지 않는다.
 * @param repoRoot 저장소 @param groups 공통 제외 집합별 plan @param signal 요청 수명 @param runner Git 실행기
 * @returns 커밋별 브랜치 이름. 한 그룹 실패 시 다른 자식도 종료한 뒤 원래 오류를 전파한다.
 */
async function loadTargetedPlans(
  repoRoot: string,
  groups: readonly (readonly LocalOnlyPlan[])[],
  signal: AbortSignal | undefined,
  runner: LocalOnlyBranchRunner
): Promise<Map<string, string[]>> {
  signal?.throwIfAborted();
  const result = new Map<string, string[]>(), controller = new AbortController();
  /** 외부 취소는 모든 활성 범위에 전달하고 다음 그룹은 시작하지 않는다. */
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let cursor = 0, failed = false, failure: unknown;
  logInfo("graph local-only targeted groups", { repoRoot, plans: groups.reduce((sum, group) => sum + group.length, 0), groups: groups.length,
    concurrency: Math.min(TARGETED_GROUP_CONCURRENCY, groups.length) });
  /** 각 worker는 서로 다른 기준점 그룹만 소유하고 첫 실패 뒤에는 새 Git 조회를 추가하지 않는다. */
  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted && cursor < groups.length) {
      const group = groups[cursor++];
      try {
        const exact = await readTargetedGroup(repoRoot, group, controller.signal, runner);
        for (const [hash, names] of exact) result.set(hash, [...(result.get(hash) ?? []), ...names]);
      } catch (error) {
        if (!failed) { failed = true; failure = error; controller.abort(error); }
        throw error;
      }
    }
  };
  try {
    await Promise.allSettled(Array.from({ length: Math.min(TARGETED_GROUP_CONCURRENCY, groups.length) }, worker));
    if (failed) throw failure;
    signal?.throwIfAborted();
    return result;
  } finally { controller.abort(); signal?.removeEventListener("abort", abort); }
}

/** 결과 map 에서 지정한 브랜치 이름을 빼고, 빈 항목은 지운다. */
function withoutPlans(result: Map<string, string[]>, names: ReadonlySet<string>): Map<string, string[]> {
  const kept = new Map<string, string[]>();
  for (const [hash, branches] of result) {
    const rest = branches.filter((name) => !names.has(name));
    if (rest.length) kept.set(hash, rest);
  }
  return kept;
}

/**
 * 두 결과 map 을 합치고, 커밋마다 브랜치 이름을 원래 plan 순서로 정렬한다.
 * @param plans 순서 기준 plan 목록
 * @param left 합칠 결과
 * @param right 합칠 결과
 * @returns 합쳐진 커밋 hash별 브랜치 이름 배열
 */
function mergePlanResults(
  plans: readonly LocalOnlyPlan[],
  left: Map<string, string[]>,
  right: Map<string, string[]>
): Map<string, string[]> {
  const order = new Map(plans.map((plan, index) => [plan.name, index]));
  const merged = new Map(left);
  for (const [hash, branches] of right) {
    merged.set(hash, [...new Set([...(merged.get(hash) ?? []), ...branches])]);
  }
  for (const [hash, branches] of merged) {
    merged.set(hash, branches.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)));
  }
  return merged;
}

/**
 * 브랜치마다 자기 기준점(upstream 또는 전체 원격)을 비트로 추적하며 전체 DAG 를 읽는다(정확한 경로).
 * @returns 커밋 hash별 local-only 브랜치 이름 배열
 */
async function loadWithBaselines(
  repoRoot: string,
  plans: readonly LocalOnlyPlan[],
  signal: AbortSignal | undefined,
  runner: LocalOnlyBranchRunner
): Promise<Map<string, string[]>> {
  const states = new Map<string, ReachabilityBits>();
  const revisions = new Set<string>();
  plans.forEach((plan, index) => {
    const bit = 1n << BigInt(index);
    seedBits(states, plan.hash, "include", bit);
    revisions.add(plan.hash);
    for (const baseline of plan.baselineHashes) {
      seedBits(states, baseline, "exclude", bit);
      revisions.add(baseline);
    }
  });
  const output = await runner(
    ["rev-list", "--topo-order", "--parents", "--stdin"],
    repoRoot,
    { signal, input: revisionInput([...revisions], []) }
  );
  return mapLocalOnlyCommits(output, plans, states);
}

/**
 * `rev-list --stdin` 에 넘길 revision 줄 목록을 만든다.
 * @param includes 포함할 커밋 hash
 * @param excludes `^` 로 제외할 커밋 hash
 * @returns 줄바꿈으로 끝나는 stdin 입력
 */
function revisionInput(includes: readonly string[], excludes: readonly string[]): string {
  return [...includes, ...excludes.map((hash) => `^${hash}`)].join("\n") + "\n";
}

/** 로컬·원격 snapshot별 singleflight와 취소 가능한 완료 캐시를 관리한다. */
export class GitLocalOnlyBranchCache {
  private readonly reuse = new LocalOnlySnapshotReuse();
  private branches: LocalBranchStatus[] = [];
  private remoteTips: LocalOnlyRemoteTip[] = [];
  private remoteReady = false;
  private snapshotKey = "";
  private generation = 0;
  private completed: Map<string, string[]> | undefined;
  private pending: { controller: AbortController; promise: Promise<Map<string, string[]>> } | undefined;

  /**
   * @param repoRoot Git 실행과 OUTPUT 집계에 사용할 저장소 루트
   * @param runner production runGit 또는 단위 테스트 실행기
   */
  constructor(
    private readonly repoRoot: string,
    private readonly runner: LocalOnlyBranchRunner = defaultRunner
  ) {}

  /** 새 Native refresh의 DAG 증거를 받고 이력이 바뀌면 현재 완료 결과도 즉시 무효화한다. */
  beginSnapshot(historyIdentity: string | undefined, fingerprint: string): void {
    const historyKey = localOnlyHistoryKey(historyIdentity, fingerprint, JSON.stringify([resolveGitExecutable(this.repoRoot), process.env.PATH]));
    const changed = this.reuse.begin(historyKey);
    if (changed || !historyKey) this.invalidate(historyKey ? "historyIdentityChanged" : "historyIdentityUnavailable");
  }

  /** 로컬 branch status snapshot을 교체하고 의미가 달라졌을 때만 계산 캐시를 무효화한다. */
  setLocalBranches(branches: readonly LocalBranchStatus[]): void {
    this.reuse.localRead();
    this.branches = branches.map((branch) => ({ ...branch }));
    this.reconcileSnapshot("localRefsChanged");
  }

  /** 성공한 remote catalog tip을 교체한다. 빈 배열도 remote가 없는 유효한 snapshot이다. */
  setRemoteTips(tips: readonly LocalOnlyRemoteTip[]): void {
    this.reuse.remoteRead();
    this.remoteTips = tips.map((tip) => ({ ...tip }));
    this.remoteReady = true;
    this.reconcileSnapshot("remoteRefsChanged");
  }

  /** remote catalog 실패 뒤 과거 기준점으로 잘못된 local-only 표시를 만들지 않도록 ready 상태를 해제한다. */
  setRemoteUnavailable(): void {
    this.reuse.remoteUnavailable();
    this.remoteReady = false;
    this.remoteTips = [];
    this.reconcileSnapshot("remoteRefsUnavailable");
  }

  /**
   * 현재 snapshot의 local-only map을 반환한다.
   * - 완료 결과와 진행 promise를 공유하며 반환 Map은 caller가 변경해도 캐시가 오염되지 않는다.
   */
  async getMap(): Promise<Map<string, string[]>> {
    if (!this.remoteReady) return new Map();
    this.restoreValidatedSnapshot();
    if (this.completed) {
      logInfo("graph local-only cache hit", { repoRoot: this.repoRoot, entries: this.completed.size });
      return cloneMap(this.completed);
    }
    if (this.pending) {
      logInfo("graph local-only cache coalesce", { repoRoot: this.repoRoot });
      return cloneMap(await this.pending.promise);
    }
    const generation = this.generation;
    const controller = new AbortController();
    const started = Date.now();
    logInfo("graph local-only cache miss", {
      repoRoot: this.repoRoot,
      branches: this.branches.length,
      remoteTips: this.remoteTips.length,
    });
    const promise = loadLocalOnlyBranchMap(
      this.repoRoot,
      this.branches,
      this.remoteTips,
      controller.signal,
      this.runner
    ).then((result) => {
      if (generation === this.generation) {
        this.completed = cloneMap(result);
        this.reuse.complete(this.snapshotKey, this.completed);
      }
      logInfo("graph local-only cache complete", {
        repoRoot: this.repoRoot,
        generation,
        entries: result.size,
        elapsedMs: Date.now() - started,
      });
      return result;
    }).catch(error => {
      if (controller.signal.aborted) logInfo("graph local-only read cancelled", { repoRoot: this.repoRoot, generation, elapsedMs: Date.now() - started });
      else logError("graph local-only cache failed", error, { repoRoot: this.repoRoot, generation, elapsedMs: Date.now() - started });
      throw error;
    });
    this.pending = { controller, promise };
    try {
      return cloneMap(await promise);
    } finally {
      if (this.pending?.promise === promise) this.pending = undefined;
    }
  }

  /**
   * 이미 계산을 마친 현재 snapshot 결과가 있으면 복사 없이 돌려준다(없으면 undefined).
   * - 페이지를 게시하기 전에 동기적으로 표시를 붙여, 같은 페이지를 두 번 게시하지 않게 하는 용도다.
   * - 반환 Map 은 읽기 전용으로 다뤄야 한다(호출부는 배열을 복사해 붙인다).
   */
  peek(): ReadonlyMap<string, readonly string[]> | undefined {
    if (this.remoteReady) this.restoreValidatedSnapshot();
    return this.remoteReady ? this.completed : undefined;
  }

  /** 새 snapshot을 모두 받은 뒤 동기 게시 경로도 같은 검증 결과를 사용해 중간 marker 없는 frame을 피한다. */
  private restoreValidatedSnapshot(): void {
    if (this.completed) return;
    this.completed = this.reuse.restore(this.snapshotKey);
    if (this.completed) logInfo("graph local-only snapshot revalidated", { repoRoot: this.repoRoot, entries: this.completed.size });
  }

  /** 알려진 Git mutation에서 snapshot과 완료 결과를 모두 버리고 실행 중인 rev-list를 종료한다. */
  invalidate(reason: string): void {
    this.reuse.invalidate();
    this.generation++;
    this.pending?.controller.abort();
    this.pending = undefined;
    this.completed = undefined;
    logInfo("graph local-only cache invalidated", { repoRoot: this.repoRoot, reason, generation: this.generation });
  }

  /** 패널 hide/dispose에서는 완료 결과를 보존하되 진행 중인 background process만 종료한다. */
  cancel(reason: string): void {
    if (reason !== "checkout") this.reuse.cancel();
    if (!this.pending) return;
    this.generation++;
    this.pending.controller.abort();
    this.pending = undefined;
    logInfo("graph local-only cache cancelled", { repoRoot: this.repoRoot, reason, generation: this.generation });
  }

  /** 로컬/원격 tip 의미 signature가 바뀐 경우에만 이전 결과와 process를 폐기한다. */
  private reconcileSnapshot(reason: string): void {
    const nextKey = branchSnapshotKey(this.branches, this.remoteTips, this.remoteReady);
    if (nextKey === this.snapshotKey) return;
    this.snapshotKey = nextKey;
    this.invalidate(reason);
  }
}

/** 브랜치별 include tip과 upstream/전체 remote exclude tip 계획을 만든다. */
function buildPlans(
  branches: readonly LocalBranchStatus[],
  remoteTips: readonly LocalOnlyRemoteTip[]
): LocalOnlyPlan[] {
  const tipsByName = new Map<string, string>();
  for (const branch of branches) if (branch.hash) tipsByName.set(branch.name, branch.hash);
  for (const remote of remoteTips) if (remote.hash) tipsByName.set(remote.name, remote.hash);
  const allRemoteHashes = [...new Set(remoteTips.map((tip) => tip.hash).filter(Boolean))];
  return branches.flatMap((branch) => {
    if (!branch.hash || (branch.upstream && !branch.gone && branch.ahead <= 0)) return [];
    if (branch.upstream && !branch.gone) {
      const upstreamHash = tipsByName.get(branch.upstream);
      return upstreamHash
        ? [{ name: branch.name, hash: branch.hash, baselineHashes: [upstreamHash], expectedCount: branch.ahead }]
        : [];
    }
    return [{ name: branch.name, hash: branch.hash, baselineHashes: allRemoteHashes }];
  });
}

/** tip hash의 include/exclude 비트에 브랜치 membership을 누적한다. */
function seedBits(
  states: Map<string, ReachabilityBits>,
  hash: string,
  side: keyof ReachabilityBits,
  bit: bigint
): void {
  const state = states.get(hash) ?? { include: 0n, exclude: 0n };
  state[side] |= bit;
  states.set(hash, state);
}

/**
 * topo-order를 자식→부모로 전파하고 포함된 비트만 읽어 행마다 plan 수만큼 빈 배열을 만들지 않는다.
 * @param output 부모 관계가 있는 Native topo 출력 @param plans 비트 위치와 이름의 순서 @param states tip별 초기 membership
 * @returns 정확한 커밋별 이름. 처리한 행의 상태는 부모에 전파한 뒤 해제해 과거 이력을 계속 보관하지 않는다.
 */
function mapLocalOnlyCommits(
  output: string,
  plans: readonly LocalOnlyPlan[],
  states: Map<string, ReachabilityBits>
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let namesByBit: Map<bigint, string> | undefined;
  let lastMask = 0n, lastNames: string[] = [];
  for (const line of output.split("\n")) {
    const [hash, ...parents] = line.trim().split(/\s+/);
    if (!hash) continue;
    const state = states.get(hash) ?? { include: 0n, exclude: 0n };
    const localOnly = state.include & ~state.exclude;
    if (localOnly !== 0n) {
      const names: string[] = localOnly === lastMask ? [...lastNames] : [];
      if (localOnly !== lastMask) {
        namesByBit ??= new Map(plans.map((plan, index) => [1n << BigInt(index), plan.name]));
        // 낮은 비트부터 꺼내 기존 plan 순서를 유지하며, 실제 membership 수만큼만 순회한다.
        for (let remaining = localOnly; remaining !== 0n; remaining &= remaining - 1n) {
          const name = namesByBit.get(remaining & -remaining);
          if (name !== undefined) names.push(name);
        }
        lastMask = localOnly; lastNames = names;
      }
      // 공유 이력의 같은 membership은 다시 해독하지 않고, 각 결과 배열은 별도로 유지한다.
      result.set(hash, names);
    }
    for (const parent of parents) {
      const inherited = states.get(parent) ?? { include: 0n, exclude: 0n };
      inherited.include |= state.include;
      inherited.exclude |= state.exclude;
      states.set(parent, inherited);
    }
    // topo-order에서 이 행의 모든 자식은 이미 처리됐으므로 다음 부모 전파에 필요한 상태만 남긴다.
    states.delete(hash);
  }
  return result;
}

/** ref snapshot의 local-only 의미 필드만 정렬해 cache generation key로 만든다. */
function branchSnapshotKey(
  branches: readonly LocalBranchStatus[],
  remoteTips: readonly LocalOnlyRemoteTip[],
  remoteReady: boolean
): string {
  const local = branches.map((branch) => [
    branch.name, branch.hash, branch.upstream ?? "", branch.ahead, branch.gone ? 1 : 0,
  ].join("\x1f")).sort();
  const remote = remoteTips.map((tip) => `${tip.name}\x1f${tip.hash}`).sort();
  return `${remoteReady ? "ready" : "pending"}\n${local.join("\n")}\n--remote--\n${remote.join("\n")}`;
}

/** 완료 map의 배열까지 복사해 cache와 commit decoration 호출자의 변경을 격리한다. */
function cloneMap(source: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  return new Map([...source].map(([hash, branches]) => [hash, [...branches]]));
}
