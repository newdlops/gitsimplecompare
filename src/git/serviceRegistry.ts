// GitService 인스턴스를 저장소 루트별로 캐싱·재사용하는 레지스트리.
// - 같은 저장소에 대해 매번 새 인스턴스를 만들 필요가 없고, 프로바이더/명령 등
//   여러 레이어가 동일한 인스턴스를 공유하도록 하는 단일 진입점이다(재사용성).
import { GitService } from "./gitService";

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
    const root = await GitService.detectRepoRoot(cwd);
    this.resolveCache.set(cwd, { at: Date.now(), root });
    if (!root) {
      return undefined;
    }
    return this.get(root);
  }

  /** 모든 저장소의 작업트리 상태 캐시를 무효화한다. */
  invalidateStatusCaches(): void {
    for (const service of this.cache.values()) {
      service.invalidateStatusCache();
    }
  }

  /** 저장소 루트 탐지 캐시를 비운다. */
  invalidateResolveCache(): void {
    this.resolveCache.clear();
  }
}
