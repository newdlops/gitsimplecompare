// 비교/checkout Quick Pick이 공유하는 로컬·원격 브랜치 snapshot 캐시 모듈.
// - 현재 브랜치 표시를 같은 for-each-ref 출력에서 읽어 별도 rev-parse 프로세스를 없앤다.
// - 짧은 TTL과 mutation generation을 함께 사용해 반복 UI 진입은 빠르게, 외부 ref 변경은 유한 시간 안에 반영한다.
import type { BranchInfo } from "./gitTypes";
import { logInfo } from "../ui/outputLog";

const FIELD_SEPARATOR = "\x1f";
const DEFAULT_MAX_AGE_MS = 2_000;
const repositoryGenerations = new Map<string, number>();

/** Graph/명령 등 다른 서비스 인스턴스가 만든 ref 변경을 저장소 단위로 알린다. */
export function invalidateGitBranchListCaches(repoRoot: string): void {
  const generation = (repositoryGenerations.get(repoRoot) ?? 0) + 1;
  repositoryGenerations.set(repoRoot, generation);
  logInfo("branch list cache invalidated", { repoRoot, generation });
}

/** 브랜치 snapshot을 읽을 때 GitService의 repoRoot가 이미 결합된 실행 함수다. */
export type GitBranchListRunner = (args: string[]) => Promise<string>;

/** 캐시 사용 여부를 OUTPUT에서 구분할 수 있는 브랜치 조회 결과다. */
export interface GitBranchListRead {
  branches: BranchInfo[];
  source: "hit" | "miss" | "coalesced";
}

interface CachedBranchList {
  at: number;
  generation: number;
  branches: BranchInfo[];
}

interface PendingBranchList {
  generation: number;
  promise: Promise<BranchInfo[]>;
}

/** 저장소 서비스 하나에서 branch picker용 snapshot과 진행 중인 Git read를 관리한다. */
export class GitBranchListCache {
  private generation = 0;
  private repositoryGeneration: number;
  private readonly completed = new Map<boolean, CachedBranchList>();
  private readonly pending = new Map<boolean, PendingBranchList>();

  /**
   * @param maxAgeMs 외부 프로세스가 ref를 바꿔도 자동 갱신되는 최대 캐시 수명
   * @param now 테스트에서 TTL 경계를 결정적으로 제어할 현재 시각 함수
   */
  constructor(
    private readonly maxAgeMs = DEFAULT_MAX_AGE_MS,
    private readonly now: () => number = Date.now,
    private readonly repoRoot?: string
  ) {
    this.repositoryGeneration = repoRoot ? repositoryGenerations.get(repoRoot) ?? 0 : 0;
  }

  /** production GitService가 저장소 경로를 포함한 OUTPUT 계측 캐시를 만들 때 사용한다. */
  static forRepository(repoRoot: string): GitBranchListCache {
    return new GitBranchListCache(DEFAULT_MAX_AGE_MS, Date.now, repoRoot);
  }

  /**
   * 로컬 또는 로컬+원격 브랜치를 한 Git 프로세스로 읽고 짧게 재사용한다.
   * - 원격 포함 snapshot은 로컬 전용 요청도 만족하므로 두 캐시를 함께 채운다.
   * @param includeRemote refs/remotes를 포함할지 여부
   * @param runner 실제 for-each-ref를 실행할 함수
   * @returns 복사된 브랜치 배열과 hit/miss/coalesced 출처
   */
  async read(
    includeRemote: boolean,
    runner: GitBranchListRunner
  ): Promise<GitBranchListRead> {
    const started = this.now();
    for (;;) {
      this.syncRepositoryGeneration();
      const cached = this.freshEntry(includeRemote);
      if (cached) {
        const branches = selectBranches(cached.branches, includeRemote);
        this.report("hit", includeRemote, branches.length, this.now() - started);
        return { branches, source: "hit" };
      }
      const generation = this.generation;
      let entry = this.pending.get(includeRemote) ?? (includeRemote ? undefined : this.pending.get(true));
      const coalesced = entry?.generation === generation;
      if (!coalesced) {
        const refs = includeRemote ? ["refs/heads", "refs/remotes"] : ["refs/heads"];
        const promise = runner(["for-each-ref",
          `--format=%(HEAD)${FIELD_SEPARATOR}%(refname:short)${FIELD_SEPARATOR}%(refname)`, ...refs]).then(parseGitBranchList);
        entry = { generation, promise };
        this.pending.set(includeRemote, entry);
      }
      let branches: BranchInfo[];
      try { branches = await entry!.promise; }
      catch (error) {
        this.syncRepositoryGeneration();
        // 이미 무효화한 요청의 실패도 최신 snapshot을 기다리는 소비자를 실패시키지 않는다.
        if (generation !== this.generation) continue;
        throw error;
      } finally {
        if (!coalesced && this.pending.get(includeRemote) === entry) this.pending.delete(includeRemote);
      }
      this.syncRepositoryGeneration();
      // 다른 서비스의 checkout/commit이 진행 중 조회를 앞질렀으면 같은 최신 pass로 다시 합친다.
      if (generation !== this.generation) {
        if (this.repoRoot) logInfo("branch list response skipped", { repoRoot: this.repoRoot, reason: "generationChanged" });
        continue;
      }
      if (!coalesced) {
        const completed = { at: this.now(), generation, branches: cloneBranches(branches) };
        this.completed.set(includeRemote, completed);
        if (includeRemote) this.completed.set(false, { ...completed, branches: selectBranches(branches, false) });
      }
      const source = coalesced ? "coalesced" : "miss";
      const selected = selectBranches(branches, includeRemote);
      this.report(source, includeRemote, selected.length, this.now() - started);
      return { branches: selected, source };
    }
  }

  /** 알려진 checkout/commit/branch 생성 뒤 이전 snapshot을 즉시 무효화한다. */
  invalidate(): void {
    if (this.repoRoot) {
      invalidateGitBranchListCaches(this.repoRoot);
      this.syncRepositoryGeneration();
      return;
    }
    this.clearLocalGeneration();
  }

  /** 요청 범위를 만족하고 TTL·generation이 모두 유효한 완료 snapshot을 찾는다. */
  private freshEntry(includeRemote: boolean): CachedBranchList | undefined {
    const entry = this.completed.get(includeRemote) ?? (
      includeRemote ? undefined : this.completed.get(true)
    );
    return entry && entry.generation === this.generation && this.now() - entry.at <= this.maxAgeMs
      ? entry
      : undefined;
  }

  /** 저장소 공용 generation 변화를 이 인스턴스의 완료·진행 cache에 반영한다. */
  private syncRepositoryGeneration(): void {
    if (!this.repoRoot) return;
    const generation = repositoryGenerations.get(this.repoRoot) ?? 0;
    if (generation === this.repositoryGeneration) return;
    this.repositoryGeneration = generation;
    this.clearLocalGeneration();
  }

  /** 이 인스턴스의 generation을 올리고 이전 snapshot과 singleflight 참조를 버린다. */
  private clearLocalGeneration(): void {
    this.generation++;
    this.completed.clear();
    this.pending.clear();
  }

  /** cache source와 Git 대기 시간을 저장소 단위로 OUTPUT에 기록한다. */
  private report(source: GitBranchListRead["source"], includeRemote: boolean, count: number, elapsedMs: number): void {
    if (!this.repoRoot) return;
    logInfo("branch list loaded", { repoRoot: this.repoRoot, includeRemote, count, source, elapsedMs });
  }
}

/** for-each-ref의 HEAD/name/full-ref 레코드를 BranchInfo 배열로 변환한다. */
export function parseGitBranchList(output: string): BranchInfo[] {
  return output.split("\n").flatMap((line) => {
    if (!line) return [];
    const [head, name, fullRef] = line.split(FIELD_SEPARATOR);
    if (!name || !fullRef) return [];
    const remote = fullRef.startsWith("refs/remotes/");
    if (remote && name.endsWith("/HEAD")) return [];
    return [{
      name,
      kind: remote ? "remote" as const : "local" as const,
      isCurrent: !remote && head.trim() === "*",
    }];
  });
}

/** 원격 포함 snapshot을 로컬 전용 요청에 안전하게 투영하고 mutable 객체를 복사한다. */
function selectBranches(branches: readonly BranchInfo[], includeRemote: boolean): BranchInfo[] {
  return cloneBranches(includeRemote ? branches : branches.filter((branch) => branch.kind === "local"));
}

/** 캐시 내부 BranchInfo 객체가 호출자 수정으로 오염되지 않도록 배열과 항목을 복제한다. */
function cloneBranches(branches: readonly BranchInfo[]): BranchInfo[] {
  return branches.map((branch) => ({ ...branch }));
}
