// 작업트리 status 조회 결과의 세대별 캐시를 관리하는 순수 모듈.
// - GitService 의 git 실행 책임과 비동기 캐시 경쟁 제어를 분리한다.
// - invalidate 세대와 조회 ID를 함께 확인해 늦게 끝난 과거 조회가 최신 캐시를 덮지 못하게 한다.
/**
 * 이 모듈이 보장하는 작업 상태 경계:
 *
 * 1. StatusCache는 Git CLI 조회끼리의 완료 순서를 세대와 read ID로 직렬화한다.
 * 2. StatusRefreshFreshness는 UI 요청과 캐시 세대를 비교해 적용/재시도/폐기를 구분한다.
 * 3. StatusSourceFence는 CLI로 확정한 SoT에 VS Code Git provider가 수렴할 때까지 검증을 요구한다.
 * 4. fingerprint는 파일 상태만 비교하고 라인 통계는 제외해 표시 보강 시 fence가 흔들리지 않게 한다.
 *
 * VS Code API나 git 실행 함수는 의도적으로 받지 않는다. 따라서 서비스와 명령 레이어가 같은 최신성
 * 규칙을 재사용할 수 있고, 실제 저장소 없이도 완료 순서와 provider 수렴 경계를 단위 테스트할 수 있다.
 */
import type { FileChange } from "./gitTypes";

/** 작업트리 상태를 스테이징/미스테이징 두 그룹으로 나눈 결과. */
export interface StatusGroups {
  staged: FileChange[];
  unstaged: FileChange[];
}

/** 작업트리 상태 조회의 캐시와 통계 포함 정책. */
export interface StatusGroupOptions {
  /** true면 유효한 캐시나 진행 중 조회를 재사용하지 않고 새 조회를 시작한다. */
  force?: boolean;
  /** 완료된 캐시를 재사용할 최대 시간(ms). 기본값은 1000ms다. */
  maxCacheAgeMs?: number;
  /** false면 빠른 porcelain 목록만 읽으며, 기본값 true는 numstat까지 보강한다. */
  includeStats?: boolean;
}

/** 완료된 값과 진행 중 조회를 구분해 저장하는 내부 캐시 엔트리. */
type StatusCacheEntry<T> =
  | { kind: "ready"; at: number; value: T; detailLevel: number }
  | {
      kind: "pending";
      at: number;
      value: Promise<T>;
      generation: number;
      readId: number;
      detailLevel: number;
    };

/**
 * invalidate 세대와 조회 순서를 추적하는 비동기 status 캐시.
 * - 세대는 외부 상태 변경을, readId 는 같은 세대 안에서 시작된 강제 재조회 순서를 나타낸다.
 * - 값을 넣고 꺼낼 때 복제 함수를 사용해 호출자의 배열/객체 변경이 캐시로 전파되지 않게 한다.
 */
export class StatusCache<T> {
  private entry?: StatusCacheEntry<T>;
  private generation = 0;
  private nextReadId = 0;

  /**
   * 캐시 값의 안전한 사본을 만드는 함수를 받아 캐시를 생성한다.
   * @param cloneValue 캐시 경계에서 T 값을 복제하는 함수
   */
  constructor(private readonly cloneValue: (value: T) => T) {}

  /**
   * 아직 유효한 완료 값 또는 진행 중인 조회를 반환한다.
   * - 진행 중 조회는 나이와 무관하게 공유해 같은 상태를 중복으로 읽지 않는다.
   * - 완료 값은 maxAgeMs 이내일 때만 반환하며, 만료된 값은 다음 read 호출이 대체하도록 둔다.
   * @param maxAgeMs 완료된 캐시 값을 재사용할 최대 시간(ms)
   * @param minimumDetailLevel 호출자가 요구하는 최소 결과 상세도
   * @returns 재사용할 값의 Promise, 캐시가 없거나 만료됐으면 undefined
   */
  get(maxAgeMs: number, minimumDetailLevel = 0): Promise<T> | undefined {
    const entry = this.entry;
    if (!entry || entry.detailLevel < minimumDetailLevel) {
      return undefined;
    }
    if (entry.kind === "pending") {
      return entry.value.then(this.cloneValue);
    }
    if (Date.now() - entry.at > maxAgeMs) {
      return undefined;
    }
    return Promise.resolve(this.cloneValue(entry.value));
  }

  /**
   * 새 authoritative status 조회를 시작하고 완료 결과를 조건부로 캐시에 반영한다.
   * - 시작 시점의 generation/readId 를 기억한 뒤, 완료 시에도 자신이 최신 조회인지 확인한다.
   * - invalidate 이전 조회나 같은 세대에서 뒤이어 시작된 조회보다 오래된 조회는 호출자에게 결과만
   *   돌려주고 캐시는 건드리지 않는다.
   * @param loader git status/diff 를 읽어 새 값을 만드는 비동기 함수
   * @param detailLevel loader 결과가 충족하는 상세도 수준
   * @returns loader 결과의 안전한 사본
   */
  async read(loader: () => Promise<T>, detailLevel = 0): Promise<T> {
    const generation = this.generation;
    const readId = ++this.nextReadId;
    const value = loader();
    this.entry = {
      kind: "pending",
      at: Date.now(),
      value,
      generation,
      readId,
      detailLevel,
    };

    try {
      const loaded = await value;
      if (this.isCurrentRead(generation, readId)) {
        this.entry = {
          kind: "ready",
          at: Date.now(),
          value: this.cloneValue(loaded),
          detailLevel,
        };
      }
      return this.cloneValue(loaded);
    } catch (error) {
      if (this.isCurrentRead(generation, readId)) {
        this.entry = undefined;
      }
      throw error;
    }
  }

  /**
   * 현재 캐시를 버리고 세대를 한 단계 증가시킨다.
   * - 호출 원인이 실제 mutation인지 watcher의 수동 무효화인지는 상위 서비스가 판단하며,
   *   어떤 원인이든 진행 중 과거 조회를 폐기해야 하므로 항상 generation 을 올린다.
   * @returns 증가한 뒤의 현재 generation
   */
  invalidate(): number {
    this.generation += 1;
    this.entry = undefined;
    return this.generation;
  }

  /**
   * 현재 캐시 무효화 세대를 반환한다.
   * @returns 마지막 invalidate 횟수를 반영한 generation 토큰
   */
  getGeneration(): number {
    return this.generation;
  }

  /**
   * 비동기 작업 시작 때 저장한 세대가 아직 현재 세대인지 확인한다.
   * @param generation 비동기 작업 시작 시 캡처한 generation 토큰
   * @returns 중간에 invalidate 되지 않았다면 true
   */
  isGenerationCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  /**
   * 완료된 조회가 현재 캐시 엔트리의 소유자인지 확인한다.
   * @param generation 조회 시작 시점의 invalidate 세대
   * @param readId 같은 세대 안에서 조회에 부여한 순번
   * @returns 세대와 조회 순번이 모두 현재 pending 엔트리와 일치하면 true
   */
  private isCurrentRead(generation: number, readId: number): boolean {
    const entry = this.entry;
    return entry?.kind === "pending"
      && entry.generation === generation
      && entry.readId === readId
      && this.generation === generation;
  }
}

/** VS Code Git provider 상태가 마지막 authoritative CLI 상태와 어떤 관계인지 나타낸다. */
export type ProviderStatusDecision = "accept" | "verify";

/** 비동기 status 결과가 현재 UI 요청과 어떤 관계인지 나타낸다. */
export type StatusRefreshFreshness =
  | "current"
  | "generationChanged"
  | "superseded";

/** status 결과 최신성 판정에 필요한 저장소, 요청, cache generation 스냅샷. */
export interface StatusRefreshIdentity {
  /** 현재 Changes UI가 선택한 저장소. */
  activeRoot: string | undefined;
  /** 조회를 시작할 때 선택돼 있던 저장소. */
  requestRoot: string;
  /** 저장소 refresh state가 가진 최신 요청 번호. */
  latestRequestId: number;
  /** 이 비동기 조회에 부여된 요청 번호. */
  requestId: number;
  /** GitService가 현재 가진 status cache generation. */
  currentGeneration: number;
  /** 이 비동기 조회가 시작될 때 저장한 generation. */
  requestGeneration: number;
}

/**
 * status 비동기 결과를 적용, generation 재시도, 완전 폐기 중 하나로 분류한다.
 * - 저장소/requestId가 달라졌으면 새 요청이 결과를 책임지므로 superseded다.
 * - 동일 요청에서 generation만 달라졌으면 watcher가 조회 중 cache를 무효화한 것이므로 재시도할 수 있다.
 * @param identity 저장소, 요청 번호, cache generation의 시작/현재 값
 * @returns current, generationChanged 또는 superseded
 */
export function statusRefreshFreshness(
  identity: StatusRefreshIdentity
): StatusRefreshFreshness {
  if (
    identity.activeRoot !== identity.requestRoot ||
    identity.latestRequestId !== identity.requestId
  ) {
    return "superseded";
  }
  return identity.currentGeneration === identity.requestGeneration
    ? "current"
    : "generationChanged";
}

/**
 * 자체 Git mutation 뒤 VS Code Git provider가 같은 상태를 관측할 때까지 SoT 경계를 유지한다.
 * - 고정 시간 동안 provider를 무시하는 대신, 파일/상태 fingerprint가 실제 CLI 결과와 수렴했는지 확인한다.
 * - provider가 다른 fingerprint를 보내면 새 외부 변경일 수도 있으므로 호출자에게 CLI 검증을 요청한다.
 */
export class StatusSourceFence {
  private authoritativeSignature: string | undefined;

  /**
   * 방금 CLI로 확정한 상태를 provider 동기화 기준으로 기록한다.
   * @param groups 실제 Git porcelain에서 읽은 staged/unstaged 상태
   */
  protect(groups: StatusGroups): void {
    this.authoritativeSignature = statusGroupsSignature(groups);
  }

  /**
   * provider 결과를 즉시 받아도 되는지, CLI로 한 번 검증해야 하는지 판정한다.
   * - 보호 중인 fingerprint와 같으면 provider가 따라온 것이므로 fence를 해제한다.
   * @param groups VS Code Git API가 제공한 staged/unstaged 상태
   * @returns 바로 UI에 적용하면 accept, 실제 Git 확인이 필요하면 verify
   */
  inspectProvider(groups: StatusGroups): ProviderStatusDecision {
    if (this.authoritativeSignature === undefined) {
      return "accept";
    }
    if (statusGroupsSignature(groups) === this.authoritativeSignature) {
      this.authoritativeSignature = undefined;
      return "accept";
    }
    return "verify";
  }

  /**
   * provider와 달라 CLI를 재조회한 결과로 fence를 갱신한다.
   * - provider가 실제 새 상태와 같았다면 보호를 끝내고, provider만 오래됐다면 최신 CLI 상태를 계속 보호한다.
   * @param authoritative 실제 Git CLI에서 다시 확인한 상태
   * @param provider 검증을 유발한 VS Code Git provider 상태
   */
  reconcile(authoritative: StatusGroups, provider: StatusGroups): void {
    const actual = statusGroupsSignature(authoritative);
    this.authoritativeSignature =
      actual === statusGroupsSignature(provider) ? undefined : actual;
  }

  /** 테스트/관찰 코드가 현재 provider 동기화 대기 여부를 확인한다. */
  isProtected(): boolean {
    return this.authoritativeSignature !== undefined;
  }
}

/**
 * 라인 통계와 배열 순서에 영향받지 않는 작업 상태 fingerprint를 만든다.
 * - SoT 일치 여부에는 stage 구분, Git 상태, 현재/이전 경로만 필요하며 +/- 통계는 표시 보강 정보다.
 * @param groups fingerprint를 만들 작업 상태 그룹
 * @returns 항목 순서가 달라도 같은 상태면 동일한 문자열
 */
export function statusGroupsSignature(groups: StatusGroups): string {
  return [
    ...groups.staged.map((item) => statusItemSignature("S", item)),
    ...groups.unstaged.map((item) => statusItemSignature("W", item)),
  ]
    .sort()
    .join("\n");
}

/**
 * 상태 항목 하나를 충돌 없는 fingerprint 레코드로 직렬화한다.
 * @param bucket staged(S) 또는 working(W) 구분
 * @param item Git 파일 상태와 경로
 * @returns NUL 구분자를 사용한 안정적인 항목 문자열
 */
function statusItemSignature(bucket: "S" | "W", item: FileChange): string {
  return `${bucket}\0${item.status}\0${item.path}\0${item.oldPath ?? ""}`;
}

/**
 * 캐시된 status 결과를 호출자가 실수로 변형하지 못하도록 파일 항목까지 복제한다.
 * @param groups 캐시에 넣거나 캐시에서 꺼낼 작업트리 상태
 * @returns staged/unstaged 배열과 각 FileChange 를 새로 만든 사본
 */
export function cloneStatusGroups(groups: StatusGroups): StatusGroups {
  return {
    staged: groups.staged.map((item) => ({ ...item })),
    unstaged: groups.unstaged.map((item) => ({ ...item })),
  };
}
