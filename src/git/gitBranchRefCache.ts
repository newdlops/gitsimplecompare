// git graph 상세 패널에서 쓰는 브랜치 ref/containment 캐시.
// - tip seed와 DAG 전파를 분리해 첫 Graph post가 색인 작업을 기다리지 않게 한다.
import type { Commit, CommitBranchInfo, LocalBranchStatus } from "../graph/graphTypes";
import { logInfo } from "../ui/outputLog";
import { runGit } from "./gitExec";
import { parseBranchRefRecords } from "./gitLogRefs";

type GitRunner = (args: string[], repoRoot: string) => Promise<string>;
const MAX_WARMUP_PAGES = 4;
const MAX_WARMUP_COMMITS = 1_200;
const SLOW_WARMUP_MS = 100;

/** 페이지 누적 상태를 외부에서 관찰할 때 쓰는 집계 수치다. */
export interface BranchRefCacheStats {
  generation: number; snapshots: number; indexedPages: number; indexedCommits: number;
  fallbacks: number; incomplete: boolean;
}

/** Graph 페이지와 정확한 containment 색인의 관계를 설명한다. */
export interface BranchRefCachePage { commits: readonly Commit[]; skip: number; allRefs: boolean; }

/** Graph 세대별 tip/DAG containment를 비차단으로 누적하는 캐시다. */
export class GitBranchRefCache {
  private generation = 0;
  private readonly tips = new Map<string, CommitBranchInfo[]>();
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
  constructor(private readonly repoRoot: string, private readonly separator: string, private readonly runner: GitRunner = runGit) {}

  /** 지정 hash를 직접 tip으로 가리키는 현재 snapshot branch를 즉시 반환한다. */
  async getBranchesPointingAt(hash: string): Promise<CommitBranchInfo[]> { return cloneBranches(this.tips.get(hash) ?? []); }

  /**
   * 선택 커밋의 containment를 반환한다.
   * - 진행 중인 동일 세대 warmup을 먼저 공유하고, 불완전 범위는 hash별 exact fallback으로 보정한다.
   * @param hash 포함 여부를 판정할 커밋 hash
   * @returns current → local → remote 순으로 정렬된 정확한 branch 목록
   */
  async getBranchesContainingCommit(hash: string): Promise<CommitBranchInfo[]> {
    await this.warmupPromise;
    const indexed = this.memberships.get(hash);
    if (indexed && this.completePrefix) return cloneBranches(sortBranches([...indexed.values()]));
    let cached = this.containsPromises.get(hash);
    if (!cached) {
      this.stats.fallbacks++;
      cached = this.loadBranchesContainingCommit(hash);
      this.containsPromises.set(hash, cached);
    }
    return cloneBranches(await cached);
  }

  /** 현재 checkout으로 표시되는 local branch만 snapshot에서 반환한다. */
  async getCurrentBranches(): Promise<CommitBranchInfo[]> { return cloneBranches([...this.tips.values()].flat().filter((branch) => branch.current)); }

  /** LocalBranchStatus 전체 snapshot으로 기존 local tip/current 상태를 교체한다. */
  seedLocalBranches(branches: readonly LocalBranchStatus[]): void {
    this.replaceTips("local", branches.map((branch) => ({ name: branch.name, tipHash: branch.hash, kind: "local" as const, current: branch.current })));
  }

  /** remote catalog 전체 snapshot으로 기존 remote tip을 교체해 moved/deleted ref를 제거한다. */
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
    const contiguous = page.allRefs && this.completePrefix && page.skip <= this.registeredSkip && page.skip + page.commits.length >= this.registeredSkip;
    if (!contiguous) { this.completePrefix = false; this.stats.incomplete = true; return this.getStats(); }
    this.registeredSkip = Math.max(this.registeredSkip, page.skip + page.commits.length);
    this.queuedPages.push(page);
    this.scheduleWarmup();
    return this.getStats();
  }

  /** 새 Graph 세대를 열고 큐/결과를 버려 늦은 warmup이 적용되지 못하게 한다. */
  invalidate(): void {
    this.generation++;
    this.tips.clear(); this.pages.length = 0; this.queuedPages.length = 0;
    this.containsPromises.clear(); this.memberships.clear(); this.indexedHashes.clear();
    this.nextSkip = 0; this.registeredSkip = 0; this.warmedPages = 0; this.warmedCommits = 0; this.completePrefix = true; this.warmupPromise = undefined;
    this.stats = { generation: this.generation, snapshots: 0, indexedPages: 0, indexedCommits: 0, fallbacks: 0, incomplete: false };
  }

  /** 현재 세대의 집계 통계를 caller가 변경하지 못하도록 복사해 반환한다. */
  getStats(): BranchRefCacheStats { return { ...this.stats, incomplete: !this.completePrefix }; }

  /**
   * 숨김/처분처럼 현재 Graph가 더 이상 background 색인을 원하지 않을 때 queue를 취소한다.
   * @param reason OUTPUT 집계 로그에서 취소 원인을 구분할 값
   * @returns 없음. 기존 tip은 다음 resume snapshot 교체 전까지 읽기 전용으로 남긴다.
   */
  cancelWarmup(reason: string): void {
    this.generation++;
    this.queuedPages.length = 0; this.memberships.clear(); this.indexedHashes.clear(); this.warmupPromise = undefined;
    this.completePrefix = false; this.stats.generation = this.generation; this.stats.incomplete = true;
    logInfo("graph branch containment warmup cancel", { repoRoot: this.repoRoot, generation: this.generation, reason, pages: this.warmedPages, commits: this.warmedCommits });
  }

  /** kind별 snapshot을 먼저 비운 뒤 새 tip을 넣고, 기존 page는 새 snapshot으로 다시 예약한다. */
  private replaceTips(kind: CommitBranchInfo["kind"], branches: readonly CommitBranchInfo[]): void {
    for (const [hash, entries] of this.tips) {
      const remaining = entries.filter((entry) => entry.kind !== kind);
      remaining.length ? this.tips.set(hash, remaining) : this.tips.delete(hash);
    }
    for (const branch of branches) {
      if (!branch.tipHash) continue;
      const entries = this.tips.get(branch.tipHash) ?? [];
      entries.push(branch); this.tips.set(branch.tipHash, entries);
    }
    this.stats.snapshots++;
    this.memberships.clear(); this.indexedHashes.clear(); this.nextSkip = 0;
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

  /** loaded DAG 밖/불완전 범위의 의미를 Git에 위임하는 hash별 singleflight fallback이다. */
  private async loadBranchesContainingCommit(hash: string): Promise<CommitBranchInfo[]> {
    const format = ["%(objectname)", "%(HEAD)", "%(refname:short)", "%(refname)"].join(this.separator);
    const output = await this.runner(["for-each-ref", "--contains", hash, `--format=${format}`, "refs/heads", "refs/remotes"], this.repoRoot).catch(() => "");
    return parseBranchRefRecords(output, this.separator).map(toBranchInfo);
  }
}

/** 같은 이름의 local/remote ref를 충돌 없이 membership map에 넣을 key를 만든다. */
function branchKey(branch: CommitBranchInfo): string { return `${branch.kind}:${branch.name}`; }
/** 기존 UI 계약의 current → local → remote → name branch 정렬을 적용한다. */
function sortBranches(branches: CommitBranchInfo[]): CommitBranchInfo[] { return branches.sort((a, b) => Number(b.current) - Number(a.current) || (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "local" ? -1 : 1)); }
/** parser의 내부 hash field를 웹뷰 상세 branch 정보로 바꾼다. */
function toBranchInfo(ref: CommitBranchInfo & { hash: string }): CommitBranchInfo { return { name: ref.name, tipHash: ref.hash, kind: ref.kind, current: ref.current }; }
/** 내부 배열/객체의 mutable 참조가 caller로 새지 않게 얕은 복사를 만든다. */
function cloneBranches(branches: readonly CommitBranchInfo[]): CommitBranchInfo[] { return branches.map((branch) => ({ ...branch })); }
