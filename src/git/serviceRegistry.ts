// GitService 인스턴스를 저장소 루트별로 캐싱·재사용하는 레지스트리.
// - 같은 저장소에 대해 매번 새 인스턴스를 만들 필요가 없고, 프로바이더/명령 등
//   여러 레이어가 동일한 인스턴스를 공유하도록 하는 단일 진입점이다(재사용성).
import { GitService } from "./gitService";
import { detectRepositoryIdentity, type DetectedRepositoryIdentity } from "./repositoryDiscovery";
import { RepositoryDiscoveryAnchors } from "./repositoryDiscoveryAnchor";

interface DiscoveryGroup {
  result: Promise<DetectedRepositoryIdentity | undefined>;
  leader: string;
  consumers: number;
}

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
  /** 같은 세대의 cold root/branch 조회만 공유한다. branch의 시간 기반 캐시는 만들지 않는다. */
  private readonly pendingDiscovery = new Map<string, Promise<DetectedRepositoryIdentity | undefined>>();
  private discoveryGeneration = 0;
  private readonly anchors = new RepositoryDiscoveryAnchors();
  private readonly anchoredDiscovery = new Map<string, DiscoveryGroup>();

  /**
   * production은 공통 Git 탐색을 사용하고 테스트는 지연·무효화 경계만 대체한다.
   * @param discover root와 branch를 같은 실행에서 반환할 저장소 탐색기
   * @param report 여러 폴더의 조회 공유를 OUTPUT에 한 번 기록하는 선택적 관찰 경계
   */
  constructor(private readonly discover = detectRepositoryIdentity,
    private readonly report?: (fields: Record<string, unknown>) => void) {}

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
    const existing = this.pendingDiscovery.get(cwd);
    if (existing) { const identity = await existing; return identity ? this.get(identity.root) : undefined; }
    const generation = this.discoveryGeneration, anchor = await this.anchors.find(cwd);
    if (generation !== this.discoveryGeneration) return this.resolve(cwd);
    const anchored = anchor ? this.resolveCache.get(anchor) : undefined;
    if (anchored?.root && Date.now() - anchored.at < 5000) {
      this.resolveCache.set(cwd, anchored); return this.get(anchored.root);
    }
    const identity = await this.discoverOnce(cwd, anchor ?? null);
    if (!identity) {
      return undefined;
    }
    return this.get(identity.root);
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
    const identity = await this.discoverOnce(cwd);
    return identity
      ? { service: this.get(identity.root), branch: identity.branch }
      : undefined;
  }

  /**
   * 같은 경로의 진행 중 root/branch 조회를 공유하고 완료 후에는 즉시 해제한다.
   * - Clone/Init 후 무효화되면 이전 조회가 늦게 완료해도 새 negative/root 캐시를 덮어쓰지 않는다.
   * @param cwd 실제 Git 탐색 경로 @returns 현재 요청이 확인한 identity 또는 비저장소 결과
   */
  private async discoverOnce(cwd: string, knownAnchor?: string | null): Promise<DetectedRepositoryIdentity | undefined> {
    const existing = this.pendingDiscovery.get(cwd);
    if (existing) return existing;
    const generation = this.discoveryGeneration;
    const pending = Promise.resolve().then(async () => {
      const anchor = knownAnchor === undefined ? await this.anchors.find(cwd) : knownAnchor;
      if (!anchor || generation !== this.discoveryGeneration) return this.discover(cwd);
      return this.discoverAnchored(cwd, anchor, generation);
    }).then(identity => {
      if (generation === this.discoveryGeneration) {
        this.resolveCache.set(cwd, { at: Date.now(), root: identity?.root });
      }
      return identity;
    });
    this.pendingDiscovery.set(cwd, pending);
    try { return await pending; }
    finally { if (this.pendingDiscovery.get(cwd) === pending) this.pendingDiscovery.delete(cwd); }
  }

  /**
   * 같은 작업트리 후보의 Native 조회를 공유하되 각 alias 경계를 완료 뒤 다시 확인한다.
   * @param cwd 원래 요청 경로. Native leader도 이 cwd를 유지한다. @param anchor 검증한 가장 가까운 marker
   * @param generation 무효화 전 결과의 cache 적용을 막는 세대 @returns 현재 alias의 Native identity
   */
  private async discoverAnchored(cwd: string, anchor: string, generation: number): Promise<DetectedRepositoryIdentity | undefined> {
    let group = this.anchoredDiscovery.get(anchor);
    if (group) group.consumers++;
    else {
      group = { result: Promise.resolve().then(() => this.discover(cwd)).then(identity => {
        // Native가 직접 확인한 root만 기존 5초 root cache에 넣는다. branch 완료값은 캐시하지 않는다.
        if (generation === this.discoveryGeneration && identity?.root === anchor)
          this.resolveCache.set(anchor, { at: Date.now(), root: identity.root });
        return identity;
      }), leader: cwd, consumers: 1 };
      this.anchoredDiscovery.set(anchor, group);
      const owned = group;
      void owned.result.finally(() => {
        if (this.anchoredDiscovery.get(anchor) === owned) this.anchoredDiscovery.delete(anchor);
        if (owned.consumers > 1) try { this.report?.({ repoRoot: anchor, consumers: owned.consumers, generation }); } catch { /* 관찰 오류는 탐색 결과를 바꾸지 않는다. */ }
      }).catch(() => undefined);
    }
    const identity = await group.result;
    const currentAnchor = await this.anchors.find(cwd);
    if (currentAnchor !== anchor) return this.discover(cwd);
    if (identity?.root !== anchor) return cwd === group.leader ? identity : this.discover(cwd);
    if (generation === this.discoveryGeneration) this.resolveCache.set(anchor, { at: Date.now(), root: identity.root });
    return identity;
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

  /** 저장소 루트 탐지 세대를 바꿔 완료 캐시와 진행 중 조회를 다음 탐색에서 재사용하지 않는다. */
  invalidateResolveCache(): void {
    this.discoveryGeneration++;
    this.resolveCache.clear();
    this.pendingDiscovery.clear();
    this.anchoredDiscovery.clear();
    this.anchors.clear();
  }
}
