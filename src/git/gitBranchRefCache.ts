// git graph 상세 패널에서 쓰는 브랜치 ref/containment 캐시.
// - tip seed와 DAG 전파를 분리해 첫 Graph post가 색인 작업을 기다리지 않게 한다.
import type { Commit, CommitBranchInfo, LocalBranchStatus } from "../graph/graphTypes";
import { logError, logInfo } from "../ui/outputLog";
import { runGit } from "./gitExec";
import { parseBranchRefRecords } from "./gitLogRefs";

type GitRunner = (args: string[], repoRoot: string) => Promise<string>;
const MAX_WARMUP_PAGES = 4;
const MAX_WARMUP_COMMITS = 1_200;
const SLOW_WARMUP_MS = 100;

/** 페이지 누적 상태를 외부에서 관찰할 때 쓰는 집계 수치다. */
export interface BranchRefCacheStats {
  generation: number;
  snapshots: number;
  indexedPages: number;
  indexedCommits: number;
  fallbacks: number;
  incomplete: boolean;
}

/** Graph 페이지와 정확한 containment 색인의 관계를 설명한다. */
export interface BranchRefCachePage {
  commits: readonly Commit[];
  skip: number;
  allRefs: boolean;
}

/** Graph 세대별 tip/DAG containment를 비차단으로 누적하는 캐시다. */
export class GitBranchRefCache {
  private generation = 0;
  private readonly tips = new Map<string, CommitBranchInfo[]>();
  private readonly seededKinds = new Set<CommitBranchInfo["kind"]>();
  private readonly pages: BranchRefCachePage[] = [];
  private readonly queuedPages: BranchRefCachePage[] = [];
  private containsPromises = new Map<string, Promise<CommitBranchInfo[]>>();
  private memberships = new Map<string, Map<string, CommitBranchInfo>>();
  private indexedHashes = new Set<string>();
  private nextSkip = 0;
  private registeredSkip = 0;
  private warmedPages = 0;
  private warmedCommits = 0;
  private completePrefix = true;
  private warmupPromise: Promise<void> | undefined;
  private stats: BranchRefCacheStats = { generation: 0, snapshots: 0, indexedPages: 0, indexedCommits: 0, fallbacks: 0, incomplete: false };

  /**
   * @param repoRoot Git 명령과 집계 로그의 저장소 루트
   * @param separator git for-each-ref 출력의 필드 구분자
   * @param runner 테스트에서 exact fallback 명령을 검증할 주입 실행기
   */
  constructor(
    private readonly repoRoot: string,
    private readonly separator: string,
    private readonly runner: GitRunner = runGit
  ) {}

  /**
   * 지정 hash를 직접 tip으로 가리키는 현재 snapshot branch를 즉시 반환한다.
   * @param hash branch tip과 비교할 커밋 해시
   * @returns 호출자가 변경해도 내부 snapshot에 영향이 없는 branch 사본
   */
  async getBranchesPointingAt(hash: string): Promise<CommitBranchInfo[]> {
    return cloneBranches(this.tips.get(hash) ?? []);
  }

  /**
   * 선택 커밋의 containment를 반환한다.
   * - 진행 중인 동일 세대 warmup을 먼저 공유하고, 불완전 범위는 hash별 exact fallback으로 보정한다.
   * @param hash 포함 여부를 판정할 커밋 hash
   * @returns current → local → remote 순으로 정렬된 정확한 branch 목록
   */
  async getBranchesContainingCommit(hash: string): Promise<CommitBranchInfo[]> {
    await this.warmupPromise;
    const indexed = this.memberships.get(hash);
    // 부모에게 전파 중인 membership은 다른 자식을 아직 만나지 않았을 수 있다.
    // 두 catalog와 해당 커밋의 topo 방문이 모두 완료돼야 정확한 결과로 재사용한다.
    if (indexed && this.indexedHashes.has(hash) && this.completePrefix && this.seededKinds.size === 2) {
      return cloneBranches(sortBranches([...indexed.values()]));
    }
    let cached = this.containsPromises.get(hash);
    if (!cached) {
      this.stats.fallbacks++;
      const generation = this.generation;
      cached = this.loadBranchesContainingCommit(hash).catch((error) => {
        // 이전 snapshot의 늦은 실패가 같은 hash의 새 요청을 지우지 않게 소유권을 확인한다.
        if (this.containsPromises.get(hash) === cached) this.containsPromises.delete(hash);
        logError("graph branch containment fallback failed", error, {
          repoRoot: this.repoRoot, hash, generation,
        });
        // 상세 파일/메시지는 계속 보여주되 실패를 영구적인 빈 branch 결과로 캐시하지 않는다.
        return [];
      });
      this.containsPromises.set(hash, cached);
    }
    return cloneBranches(await cached);
  }

  /**
   * 현재 checkout으로 표시되는 local branch만 snapshot에서 반환한다.
   * @returns 가상 working/staged 커밋에 연결할 current branch 사본
   */
  async getCurrentBranches(): Promise<CommitBranchInfo[]> {
    return cloneBranches([...this.tips.values()].flat().filter((branch) => branch.current));
  }

  /**
   * LocalBranchStatus 전체 snapshot으로 기존 local tip/current 상태를 교체한다.
   * @param branches 조회를 마친 로컬 branch 전체 목록. 빈 배열은 로컬 branch가 없다는 뜻이다.
   */
  seedLocalBranches(branches: readonly LocalBranchStatus[]): void {
    this.replaceTips("local", branches.map((branch) => ({ name: branch.name, tipHash: branch.hash, kind: "local" as const, current: branch.current })));
  }

  /**
   * remote catalog 전체 snapshot으로 기존 remote tip을 교체해 moved/deleted ref를 제거한다.
   * @param branches 원격 branch 전체 목록. 생략된 catalog와 달리 빈 배열도 조회 완료로 취급한다.
   */
  seedRemoteBranches(branches: readonly { name: string; hash: string }[]): void {
    this.replaceTips("remote", branches.map((branch) => ({ name: branch.name, tipHash: branch.hash, kind: "remote" as const, current: false })));
  }

  /**
   * parsed Graph page를 동기 등록하고 bounded propagation은 microtask로 넘긴다.
   * @param page 원본 topo page와 all-ref/offset 정보
   * @returns 등록 직후의 관찰용 통계 복사본
   */
  indexPage(page: BranchRefCachePage): BranchRefCacheStats {
    this.pages.push(page);
    const contiguous = page.allRefs
      && this.completePrefix
      && page.skip <= this.registeredSkip
      && page.skip + page.commits.length >= this.registeredSkip;
    if (!contiguous) {
      this.completePrefix = false;
      this.stats.incomplete = true;
      return this.getStats();
    }
    this.registeredSkip = Math.max(this.registeredSkip, page.skip + page.commits.length);
    this.queuedPages.push(page);
    this.scheduleWarmup();
    return this.getStats();
  }

  /**
   * 새 Graph 세대를 열고 큐/결과를 버려 늦은 warmup이 적용되지 못하게 한다.
   * catalog 완료 표시도 비워 새 snapshot 전에 만들어진 색인이 빈 branch 목록을 확정하지 못하게 한다.
   */
  invalidate(): void {
    this.generation++;
    this.tips.clear();
    this.seededKinds.clear();
    this.pages.length = 0;
    this.queuedPages.length = 0;
    this.containsPromises.clear();
    this.memberships.clear();
    this.indexedHashes.clear();
    this.nextSkip = 0;
    this.registeredSkip = 0;
    this.warmedPages = 0;
    this.warmedCommits = 0;
    this.completePrefix = true;
    this.warmupPromise = undefined;
    this.stats = { generation: this.generation, snapshots: 0, indexedPages: 0, indexedCommits: 0, fallbacks: 0, incomplete: false };
  }

  /** 현재 세대의 집계 통계를 caller가 변경하지 못하도록 복사해 반환한다. */
  getStats(): BranchRefCacheStats {
    return { ...this.stats, incomplete: !this.completePrefix };
  }

  /**
   * 숨김/처분처럼 현재 Graph가 더 이상 background 색인을 원하지 않을 때 queue를 취소한다.
   * @param reason OUTPUT 집계 로그에서 취소 원인을 구분할 값
   * @returns 없음. 기존 tip은 다음 resume snapshot 교체 전까지 읽기 전용으로 남긴다.
   */
  cancelWarmup(reason: string): void {
    this.generation++;
    this.queuedPages.length = 0;
    this.containsPromises.clear();
    this.memberships.clear();
    this.indexedHashes.clear();
    this.warmupPromise = undefined;
    this.completePrefix = false; this.stats.generation = this.generation; this.stats.incomplete = true;
    logInfo("graph branch containment warmup cancel", { repoRoot: this.repoRoot, generation: this.generation, reason, pages: this.warmedPages, commits: this.warmedCommits });
  }

  /**
   * kind별 snapshot을 교체하고 기존 DAG를 새 branch 이름/current 상태로 다시 전파한다.
   * - 이전 DAG와 연결을 알 수 없는 새 tip은 정확한 Git 조회로 전환한다.
   * - 완료된 fallback과 진행 중 singleflight도 교체해 삭제/이동한 branch가 남지 않게 한다.
   * @param kind 교체할 로컬 또는 원격 catalog 종류
   * @param branches 해당 종류의 완전한 새 branch 목록
   */
  private replaceTips(kind: CommitBranchInfo["kind"], branches: readonly CommitBranchInfo[]): void {
    const hasUncoveredTip = this.pages.length > 0 && branches.some((branch) =>
      branch.tipHash && !this.tips.has(branch.tipHash) && !this.indexedHashes.has(branch.tipHash)
    );
    if (hasUncoveredTip) {
      this.completePrefix = false;
      this.stats.incomplete = true;
      logInfo("graph branch containment index skipped", {
        repoRoot: this.repoRoot, generation: this.generation, kind, reason: "uncoveredSnapshotTip",
      });
    }
    this.seededKinds.add(kind);
    this.containsPromises.clear();
    for (const [hash, entries] of this.tips) {
      const remaining = entries.filter((entry) => entry.kind !== kind);
      remaining.length ? this.tips.set(hash, remaining) : this.tips.delete(hash);
    }
    for (const branch of branches) {
      if (!branch.tipHash) continue;
      const entries = this.tips.get(branch.tipHash) ?? [];
      entries.push(branch);
      this.tips.set(branch.tipHash, entries);
    }
    this.stats.snapshots++;
    this.memberships.clear();
    this.indexedHashes.clear();
    this.nextSkip = 0;
    this.queuedPages.splice(0, this.queuedPages.length, ...this.pages);
    this.scheduleWarmup();
  }

  /** 한 microtask warmup future로 queue를 공유하고 page/commit budget을 넘으면 exact fallback으로 전환한다. */
  private scheduleWarmup(): void {
    if (this.warmupPromise || this.queuedPages.length === 0) return;
    const generation = this.generation;
    logInfo("graph branch containment warmup defer", { repoRoot: this.repoRoot, generation, queuedPages: this.queuedPages.length });
    this.warmupPromise = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      const started = Date.now(); let pageCount = 0; let commitCount = 0;
      logInfo("graph branch containment warmup start", { repoRoot: this.repoRoot, generation, queuedPages: this.queuedPages.length });
      while (generation === this.generation && this.queuedPages.length > 0) {
        const page = this.queuedPages.shift()!;
        if (this.warmedPages >= MAX_WARMUP_PAGES || this.warmedCommits + page.commits.length > MAX_WARMUP_COMMITS || page.skip > this.nextSkip || page.skip + page.commits.length < this.nextSkip) {
          this.completePrefix = false; this.stats.incomplete = true; this.queuedPages.length = 0; break;
        }
        pageCount++; commitCount += page.commits.length; this.warmedPages++; this.warmedCommits += page.commits.length; this.nextSkip = Math.max(this.nextSkip, page.skip + page.commits.length);
        this.stats.indexedPages++;
        for (const commit of page.commits) this.indexCommit(commit);
      }
      this.stats.indexedCommits = this.indexedHashes.size;
      const elapsed = Date.now() - started;
      logInfo("graph branch containment warmup complete", { repoRoot: this.repoRoot, generation, pages: pageCount, commits: commitCount, elapsed, incomplete: !this.completePrefix });
      if (elapsed >= SLOW_WARMUP_MS) logInfo("graph branch containment warmup slow", { repoRoot: this.repoRoot, generation, pages: pageCount, commits: commitCount, elapsed });
    }).finally(() => { if (generation === this.generation) this.warmupPromise = undefined; });
  }

  /** child-to-parent membership을 topo 순서로 전파해 merge parent도 빠짐없이 덮는다. */
  private indexCommit(commit: Commit): void {
    if (this.indexedHashes.has(commit.hash)) return;
    const own = this.memberships.get(commit.hash) ?? new Map<string, CommitBranchInfo>();
    for (const branch of this.tips.get(commit.hash) ?? []) own.set(branchKey(branch), branch);
    this.memberships.set(commit.hash, own); this.indexedHashes.add(commit.hash);
    for (const parent of commit.parents) {
      const inherited = this.memberships.get(parent) ?? new Map<string, CommitBranchInfo>();
      for (const [key, branch] of own) inherited.set(key, branch);
      this.memberships.set(parent, inherited);
    }
  }

  /**
   * loaded DAG 밖/불완전 범위의 정확한 containment를 Git에서 읽는다.
   * @param hash 포함 여부를 검사할 커밋 해시
   * @returns 현재 branch 목록. Git 실패는 호출자에게 전파해 빈 성공 결과와 구분한다.
   */
  private async loadBranchesContainingCommit(hash: string): Promise<CommitBranchInfo[]> {
    const format = ["%(objectname)", "%(HEAD)", "%(refname:short)", "%(refname)"].join(this.separator);
    const output = await this.runner(
      ["for-each-ref", "--contains", hash, `--format=${format}`, "refs/heads", "refs/remotes"],
      this.repoRoot
    );
    return parseBranchRefRecords(output, this.separator).map(toBranchInfo);
  }
}

/** 같은 이름의 local/remote ref를 받아 충돌 없는 membership map key를 반환한다. */
function branchKey(branch: CommitBranchInfo): string {
  return `${branch.kind}:${branch.name}`;
}

/** branch 배열을 current → local → remote → name 순으로 제자리 정렬해 반환한다. */
function sortBranches(branches: CommitBranchInfo[]): CommitBranchInfo[] {
  return branches.sort((a, b) =>
    Number(b.current) - Number(a.current)
    || (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "local" ? -1 : 1)
  );
}

/** parser의 내부 hash 레코드를 받아 웹뷰 상세가 사용하는 tipHash branch 정보로 반환한다. */
function toBranchInfo(ref: CommitBranchInfo & { hash: string }): CommitBranchInfo {
  return { name: ref.name, tipHash: ref.hash, kind: ref.kind, current: ref.current };
}

/** branch 목록을 받아 내부 배열/객체의 mutable 참조가 caller로 새지 않는 사본을 반환한다. */
function cloneBranches(branches: readonly CommitBranchInfo[]): CommitBranchInfo[] {
  return branches.map((branch) => ({ ...branch }));
}
