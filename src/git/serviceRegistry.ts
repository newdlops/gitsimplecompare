// GitService 인스턴스를 저장소 루트별로 캐싱·재사용하는 레지스트리.
// - 같은 저장소에 대해 매번 새 인스턴스를 만들 필요가 없고, 프로바이더/명령 등
//   여러 레이어가 동일한 인스턴스를 공유하도록 하는 단일 진입점이다(재사용성).
import { GitService } from "./gitService";
import { detectRepoRoot, detectRepositoryIdentity } from "./repositoryDiscovery";

/** 저장소 탐색과 함께 얻은 공유 GitService/브랜치 결과. */
export interface ResolvedRepositoryIdentity {
  service: GitService;
  branch: string;
}

/**
 * repoRoot → GitService 매핑을 관리하는 간단한 레지스트리.
 * - 확장 활성화 동안 하나만 만들어 공유한다.
 */
export class GitServiceRegistry {
  private readonly cache = new Map<string, GitService>();
  private readonly resolveCache = new Map<
    string,
    { at: number; root: string | undefined }
  >();

  /**
   * 저장소 루트에 해당하는 GitService 를 반환한다(없으면 생성해 캐싱).
   * @param repoRoot 저장소 루트 절대 경로
   */
  get(repoRoot: string): GitService {
    let service = this.cache.get(repoRoot);
    if (!service) {
      service = new GitService(repoRoot);
      this.cache.set(repoRoot, service);
    }
    return service;
  }

  /**
   * 임의 경로(파일/폴더)가 속한 저장소를 탐지해 해당 GitService 를 반환한다.
   * @param cwd 탐색 시작 경로
   * @returns GitService, 저장소가 아니면 undefined
   */
  async resolve(cwd: string): Promise<GitService | undefined> {
    const cached = this.resolveCache.get(cwd);
    if (cached && Date.now() - cached.at < 5000) {
      return cached.root ? this.get(cached.root) : undefined;
    }
    const root = await detectRepoRoot(cwd);
    this.resolveCache.set(cwd, { at: Date.now(), root });
    if (!root) {
      return undefined;
    }
    return this.get(root);
  }

  /**
   * 임의 경로의 저장소 서비스와 현재 브랜치를 가능한 한 한 Git 프로세스로 함께 조회한다.
   * - root 탐지 캐시가 있으면 root 재탐색은 생략하고 브랜치만 읽는다.
   * - cold path에서는 detectRepositoryIdentity를 사용해 root→branch 직렬 장벽을 없앤다.
   * @param cwd 탐색 시작 경로
   * @returns 저장소가 아니면 undefined, 맞으면 공유 서비스와 브랜치
   */
  async resolveWithBranch(
    cwd: string
  ): Promise<ResolvedRepositoryIdentity | undefined> {
    const cached = this.resolveCache.get(cwd);
    if (cached && Date.now() - cached.at < 5000) {
      if (!cached.root) return undefined;
      const service = this.get(cached.root);
      try {
        return { service, branch: await service.getCurrentBranch() };
      } catch {
        return { service, branch: "" };
      }
    }
    const identity = await detectRepositoryIdentity(cwd);
    this.resolveCache.set(cwd, {
      at: Date.now(),
      root: identity?.root,
    });
    return identity
      ? { service: this.get(identity.root), branch: identity.branch }
      : undefined;
  }

  /**
   * 모든 저장소의 작업트리 상태 캐시를 수동적으로 무효화한다.
   * - watcher/전체 refresh가 호출하는 경로이므로 각 GitService에 실제 mutation 시각은 기록하지 않는다.
   */
  invalidateStatusCaches(): void {
    for (const service of this.cache.values()) {
      service.invalidateStatusCache(false);
    }
  }

  /**
   * 특정 저장소의 작업 상태 캐시만 수동적으로 무효화한다.
   * - 로컬 파일 저장/stage처럼 활성 저장소 하나에 국한된 이벤트가 다른 저장소의 진행 중 조회를 재시도시키지 않게 한다.
   * @param repoRoot 상태가 실제로 바뀐 저장소 root
   */
  invalidateStatusCache(repoRoot: string): void {
    this.cache.get(repoRoot)?.invalidateStatusCache(false);
  }

  /** 저장소 루트 탐지 캐시를 비운다. */
  invalidateResolveCache(): void {
    this.resolveCache.clear();
  }
}
