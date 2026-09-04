// 로컬 브랜치가 upstream/remote보다 앞선 커밋 범위를 한 번의 DAG 조회로 계산하는 모듈.
// - 브랜치마다 rev-list 프로세스를 만들지 않고 모든 관련 tip을 한 topo-order 그래프로 읽는다.
// - snapshot cache와 취소 신호를 함께 소유해 Graph 세대가 바뀐 뒤 stale Git 작업이 남지 않게 한다.
import type { LocalBranchStatus } from "../graph/graphTypes";
import { logInfo } from "../ui/outputLog";
import { runGit } from "./gitExec";

/** local-only 기준점으로 사용할 원격 추적 브랜치 tip이다. */
export interface LocalOnlyRemoteTip {
  name: string;
  hash: string;
}

/** 단위 테스트가 단일 rev-list 호출과 취소 신호를 검증할 수 있는 실행 함수다. */
export type LocalOnlyBranchRunner = (
  args: string[],
  repoRoot: string,
  options?: { signal?: AbortSignal }
) => Promise<string>;

interface ReachabilityBits {
  include: bigint;
  exclude: bigint;
}

interface LocalOnlyPlan {
  name: string;
  hash: string;
  baselineHashes: string[];
}

/**
 * 모든 후보 브랜치의 local-only 커밋을 단일 rev-list DAG에서 계산한다.
 * - upstream이 있으면 upstream..local, 없거나 gone이면 local --not --remotes 의미를 재현한다.
 * - upstream tip을 확인할 수 없는 브랜치는 잘못된 표시를 피하려고 이번 snapshot에서 제외한다.
 * @param repoRoot Git 명령을 실행할 저장소 또는 worktree 루트
 * @param branches Graph가 이미 읽은 로컬 브랜치 상태 snapshot
 * @param remoteTips Graph remote catalog가 이미 읽은 원격 tip snapshot
 * @param signal Graph 수명주기 변경 시 rev-list 프로세스를 종료할 신호
 * @param runner 실제 단일 Git 명령을 실행하는 함수
 * @returns 커밋 hash별 local-only 브랜치 이름 배열
 */
export async function loadLocalOnlyBranchMap(
  repoRoot: string,
  branches: readonly LocalBranchStatus[],
  remoteTips: readonly LocalOnlyRemoteTip[],
  signal?: AbortSignal,
  runner: LocalOnlyBranchRunner = runGit
): Promise<Map<string, string[]>> {
  const plans = buildPlans(branches, remoteTips);
  if (plans.length === 0) return new Map();

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
    ["rev-list", "--topo-order", "--parents", ...revisions],
    repoRoot,
    { signal }
  );
  return mapLocalOnlyCommits(output, plans, states);
}

/** 로컬·원격 snapshot별 singleflight와 취소 가능한 완료 캐시를 관리한다. */
export class GitLocalOnlyBranchCache {
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
    private readonly runner: LocalOnlyBranchRunner = runGit
  ) {}

  /** 로컬 branch status snapshot을 교체하고 의미가 달라졌을 때만 계산 캐시를 무효화한다. */
  setLocalBranches(branches: readonly LocalBranchStatus[]): void {
    this.branches = branches.map((branch) => ({ ...branch }));
    this.reconcileSnapshot("localRefsChanged");
  }

  /** 성공한 remote catalog tip을 교체한다. 빈 배열도 remote가 없는 유효한 snapshot이다. */
  setRemoteTips(tips: readonly LocalOnlyRemoteTip[]): void {
    this.remoteTips = tips.map((tip) => ({ ...tip }));
    this.remoteReady = true;
    this.reconcileSnapshot("remoteRefsChanged");
  }

  /** remote catalog 실패 뒤 과거 기준점으로 잘못된 local-only 표시를 만들지 않도록 ready 상태를 해제한다. */
  setRemoteUnavailable(): void {
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
      if (generation === this.generation) this.completed = cloneMap(result);
      logInfo("graph local-only cache complete", {
        repoRoot: this.repoRoot,
        generation,
        entries: result.size,
        elapsedMs: Date.now() - started,
      });
      return result;
    });
    this.pending = { controller, promise };
    try {
      return cloneMap(await promise);
    } finally {
      if (this.pending?.promise === promise) this.pending = undefined;
    }
  }

  /** 알려진 Git mutation에서 snapshot과 완료 결과를 모두 버리고 실행 중인 rev-list를 종료한다. */
  invalidate(reason: string): void {
    this.generation++;
    this.pending?.controller.abort();
    this.pending = undefined;
    this.completed = undefined;
    logInfo("graph local-only cache invalidated", { repoRoot: this.repoRoot, reason, generation: this.generation });
  }

  /** 패널 hide/dispose에서는 완료 결과를 보존하되 진행 중인 background process만 종료한다. */
  cancel(reason: string): void {
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
      return upstreamHash ? [{ name: branch.name, hash: branch.hash, baselineHashes: [upstreamHash] }] : [];
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

/** topo-order rev-list를 자식→부모로 전파해 include에는 있고 baseline에는 없는 비트를 결과로 만든다. */
function mapLocalOnlyCommits(
  output: string,
  plans: readonly LocalOnlyPlan[],
  states: Map<string, ReachabilityBits>
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    const [hash, ...parents] = line.trim().split(/\s+/);
    if (!hash) continue;
    const state = states.get(hash) ?? { include: 0n, exclude: 0n };
    const localOnly = state.include & ~state.exclude;
    if (localOnly !== 0n) {
      result.set(hash, plans.flatMap((plan, index) => (
        localOnly & (1n << BigInt(index)) ? [plan.name] : []
      )));
    }
    for (const parent of parents) {
      const inherited = states.get(parent) ?? { include: 0n, exclude: 0n };
      inherited.include |= state.include;
      inherited.exclude |= state.exclude;
      states.set(parent, inherited);
    }
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
