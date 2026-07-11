// 활성 비교 스냅샷과 Explorer 비교 표시 토글을 함께 관리하는 상태 컨트롤러.
// - git 조회는 수행하지 않고, 서비스/명령 계층이 만든 ComparisonSnapshot 을 안전하게 보관한다.
// - VS Code provider 와 외부 확장이 같은 이벤트를 구독할 수 있도록 단일 상태 변경 흐름을 제공한다.
import * as vscode from "vscode";
import type { ComparisonSnapshot } from "../git/comparisonService";
import { logError, logInfo } from "../ui/outputLog";

/** 비교 상태가 바뀐 원인을 OUTPUT 로그와 provider 진단에 남길 때 사용하는 값. */
export type ComparisonChangeReason =
  | "comparison"
  | "clear"
  | "enable"
  | "disable"
  | "refresh";

/** 명령/서비스 계층에 전달하는 새로고침 요청 정보. */
export interface ComparisonRefreshRequest {
  /** 새로고침을 발생시킨 사용자 동작 또는 파일 이벤트 이름. */
  reason: string;
  /** 요청 시점의 직렬화 가능한 비교 스냅샷 복사본. */
  comparison: ComparisonSnapshot;
}

/** controller 생성 시 적용할 초기 옵션. */
export interface ComparisonControllerOptions {
  /** Explorer/SCM/에디터 표시를 처음부터 활성화할지 여부. 기본값은 false 다. */
  enabled?: boolean;
}

/** refreshWith 에 실제 조회 동작을 주입하기 위한 함수 타입. */
export type ComparisonRefresher = (
  comparison: ComparisonSnapshot
) => Promise<ComparisonSnapshot | undefined>;

/** refreshWith가 숨겨진 비교까지 안전하게 갱신할지 정하는 선택 옵션. */
export interface ComparisonRefreshOptions {
  /** true면 표시 토글이 꺼져 있어도 보관 중인 스냅샷을 최신 상태로 바꾼다. */
  includeDisabled?: boolean;
}

/**
 * 현재 선택한 비교와 표시 활성화 여부를 관리한다.
 *
 * 스냅샷은 JSON 복사를 거쳐 보관/반환한다. 따라서 activate() 반환 API 를 사용하는
 * 다른 확장이 객체를 수정해도 내부 provider 상태가 의도치 않게 변하지 않는다.
 */
export class ComparisonController implements vscode.Disposable {
  private comparison: ComparisonSnapshot | undefined;
  private enabledValue: boolean;
  private disposed = false;
  /** 백그라운드 refresh 결과가 현재 상태를 덮어쓸 수 있는지 판정하는 세대 값. */
  private refreshGeneration = 0;
  /** 사용자가 시작한 비교 조회끼리 최신 요청을 판정하는 독립 세대 값. */
  private comparisonLoadGeneration = 0;

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly refreshEmitter =
    new vscode.EventEmitter<ComparisonRefreshRequest>();

  /**
   * 비교 스냅샷 또는 활성화 상태가 바뀔 때 발생한다.
   * - 외부 확장 공개 API 와 내부 provider 가 함께 사용하므로 payload 를 노출하지 않는다.
   * - 구독자는 getPublicComparison()/getComparison()으로 최신 직렬화 복사본을 읽는다.
   */
  readonly onDidChangeComparison: vscode.Event<void> = this.changeEmitter.event;

  /**
   * 현재 비교를 다시 조회해 달라는 요청 이벤트다.
   * - controller 는 git 계층을 직접 호출하지 않으며 명령 조립 계층이 이 이벤트를 처리한다.
   */
  readonly onDidRequestRefresh: vscode.Event<ComparisonRefreshRequest> =
    this.refreshEmitter.event;

  /**
   * controller 를 만든다.
   * @param options 초기 활성화 여부를 포함한 선택 옵션
   */
  constructor(options: ComparisonControllerOptions = {}) {
    this.enabledValue = options.enabled ?? false;
    logInfo("comparison controller activated", {
      enabled: this.enabledValue,
    });
  }

  /**
   * Explorer/SCM/에디터 비교 표시가 활성화되어 있는지 반환한다.
   * @returns 토글이 켜졌으면 true
   */
  get enabled(): boolean {
    return this.enabledValue;
  }

  /**
   * 활성화 여부와 무관하게 선택된 비교가 보관되어 있는지 반환한다.
   * @returns 스냅샷이 있으면 true
   */
  get hasComparison(): boolean {
    return this.comparison !== undefined;
  }

  /**
   * 내부 provider 가 사용할 현재 비교를 직렬화 가능한 복사본으로 반환한다.
   * - 기본적으로 토글이 꺼져 있으면 undefined 를 반환해 UI 가 즉시 비워지게 한다.
   * @param includeDisabled true 면 토글이 꺼져 있어도 보관 중인 비교를 반환한다
   * @returns 복제된 비교 스냅샷 또는 undefined
   */
  getComparison(includeDisabled = false): ComparisonSnapshot | undefined {
    if ((!this.enabledValue && !includeDisabled) || !this.comparison) {
      return undefined;
    }
    return cloneComparison(this.comparison);
  }

  /**
   * activate() 반환 API 로 다른 확장에 공개할 비교 스냅샷을 반환한다.
   * - 기능 토글이 꺼진 상태를 외부 소비자도 동일하게 보도록 undefined 를 반환한다.
   * - JSON 복사본이므로 호출자가 값을 변경해도 controller 내부에는 영향이 없다.
   * @returns 활성화된 직렬화 가능 스냅샷 또는 undefined
   */
  getPublicComparison(): ComparisonSnapshot | undefined {
    return this.getComparison(false);
  }

  /**
   * 같은 확장 안의 고빈도 provider가 JSON 복사 없이 현재 스냅샷을 읽는다.
   * - 반환 객체는 controller 소유이므로 호출자는 절대 변경하지 않아야 한다.
   * - 외부 확장에는 getPublicComparison의 복사본만 공개한다.
   * @param includeDisabled true면 표시 토글이 꺼진 보관 스냅샷도 반환한다
   * @returns 내부 읽기 전용 스냅샷 또는 undefined
   */
  peekComparison(
    includeDisabled = false
  ): Readonly<ComparisonSnapshot> | undefined {
    if ((!this.enabledValue && !includeDisabled) || !this.comparison) {
      return undefined;
    }
    return this.comparison;
  }

  /**
   * 메시지 전송/영속화처럼 문자열이 필요한 소비자를 위해 현재 비교를 JSON 으로 직렬화한다.
   * @returns 활성 비교의 JSON 문자열, 비교가 비활성/미선택이면 undefined
   */
  getSerializedComparison(): string | undefined {
    const current = this.getPublicComparison();
    return current ? JSON.stringify(current) : undefined;
  }

  /**
   * 새 비교 스냅샷을 보관하고 모든 provider/외부 구독자에게 변경을 알린다.
   * - 토글이 꺼져 있어도 선택은 보관하므로 다시 켰을 때 즉시 이전 비교를 복원한다.
   * @param comparison 서비스 계층에서 계산한 완전한 비교 스냅샷
   */
  setComparison(comparison: ComparisonSnapshot): void {
    if (this.disposed) {
      return;
    }
    this.comparison = cloneComparison(comparison);
    this.refreshGeneration++;
    this.publishChange("comparison", {
      kind: comparison.kind,
      repoRoot: comparison.repoRoot,
      baseRef: comparison.baseRef,
      targetRef: comparison.targetRef,
      changes: comparison.changes.length,
      enabled: this.enabledValue,
    });
  }

  /**
   * setComparison 과 같은 동작을 제공하는 명시적 snapshot 별칭이다.
   * - 호출부가 controller 를 단순 snapshot store 로 사용할 때 의미를 분명히 한다.
   * @param snapshot 새로 보관할 비교 스냅샷
   */
  setSnapshot(snapshot: ComparisonSnapshot): void {
    this.setComparison(snapshot);
  }

  /**
   * 선택된 비교를 제거하고 관련 UI 를 비우도록 이벤트를 발생시킨다.
   * - 이미 비어 있으면 불필요한 Explorer 전체 갱신을 피하고 스킵 로그만 남긴다.
   * @param reason 비교를 지운 사용자 동작/저장소 상태 원인
   */
  clearComparison(reason = "unspecified"): void {
    if (this.disposed) {
      return;
    }
    // 스냅샷이 아직 없어도 진행 중인 사용자 조회가 뒤늦게 비교를 복원하지 못하게 한다.
    this.refreshGeneration++;
    this.comparisonLoadGeneration++;
    if (!this.comparison) {
      logInfo("comparison clear skipped", { reason, state: "empty" });
      return;
    }
    const previous = this.comparison;
    this.comparison = undefined;
    this.publishChange("clear", {
      reason,
      repoRoot: previous.repoRoot,
    });
  }

  /**
   * 비교 표시 토글을 원하는 값으로 설정한다.
   * - 스냅샷 자체는 지우지 않아 사용자가 다시 켤 때 git 조회 없이 복원할 수 있다.
   * @param enabled 새 활성화 값
   * @param reason 토글을 발생시킨 명령/설정 이름
   * @returns 실제 값이 바뀌었으면 true
   */
  setEnabled(enabled: boolean, reason = "manual"): boolean {
    if (this.disposed) {
      return false;
    }
    // 숨김은 명시적인 사용자 취소로 취급해 아직 끝나지 않은 비교가 표시를 다시 켜지 못하게 한다.
    if (!enabled) {
      this.comparisonLoadGeneration++;
    }
    if (this.enabledValue === enabled) {
      logInfo("comparison toggle skipped", { enabled, reason });
      return false;
    }
    this.enabledValue = enabled;
    this.refreshGeneration++;
    this.publishChange(enabled ? "enable" : "disable", {
      enabled,
      reason,
      hasComparison: !!this.comparison,
    });
    return true;
  }

  /**
   * 현재 활성화 값을 반대로 바꾸고 최종 값을 반환한다.
   * @param reason 토글을 발생시킨 명령/버튼 이름
   * @returns 토글 후 활성화 값
   */
  toggleEnabled(reason = "manual"): boolean {
    const next = !this.enabledValue;
    this.setEnabled(next, reason);
    return this.enabledValue;
  }

  /**
   * 사용자 비교 조회를 시작하며 이전에 진행 중인 선택/refresh 결과를 무효화한다.
   * @param reason 비교 종류나 명령 id
   * @returns 완료 시 최신 요청인지 검사할 generation token
   */
  beginComparisonLoad(reason: string): number {
    const generation = ++this.comparisonLoadGeneration;
    // 사용자 선택이 시작되기 전에 실행 중이던 백그라운드 결과는 이전 비교를 담고 있으므로 버린다.
    this.refreshGeneration++;
    logInfo("comparison load started", { reason, generation });
    return generation;
  }

  /**
   * 비동기 비교 조회가 시작 이후 다른 선택/토글에 의해 대체되지 않았는지 확인한다.
   * @param generation beginComparisonLoad가 반환한 token
   * @returns 아직 가장 최신 상태 변경 요청이면 true
   */
  isComparisonLoadCurrent(generation: number): boolean {
    return !this.disposed && generation === this.comparisonLoadGeneration;
  }

  /**
   * 현재 비교를 다시 계산해 달라고 명령 계층에 알린다.
   * - 비활성 상태나 비교 미선택 상태에서는 불필요한 git 작업을 막고 false 를 반환한다.
   * @param reason 파일 변경/수동 버튼 등 새로고침 원인
   * @returns 요청 이벤트를 실제 발생시켰으면 true
   */
  requestRefresh(reason = "manual"): boolean {
    const current = this.getComparison(false);
    if (this.disposed || !current) {
      logInfo("comparison refresh skipped", {
        reason,
        enabled: this.enabledValue,
        hasComparison: !!this.comparison,
      });
      return false;
    }
    logInfo("comparison refresh requested", {
      reason,
      repoRoot: current.repoRoot,
      kind: current.kind,
    });
    this.refreshEmitter.fire({ reason, comparison: current });
    return true;
  }

  /**
   * 주입받은 조회 함수로 현재 비교를 갱신하고 최신 요청 결과만 적용한다.
   * - 명령 계층이 별도 이벤트 연결 없이도 안전한 refresh 직렬화 정책을 재사용할 때 쓴다.
   * - 실행 중 토글/비교가 바뀌면 오래된 결과를 버려 다른 저장소 상태를 덮어쓰지 않는다.
   * @param refresher ComparisonService.refresh 등을 감싼 비동기 조회 함수
   * @param reason OUTPUT 로그에 남길 새로고침 원인
   * @param options 숨겨진 비교까지 갱신할지 정하는 선택 옵션
   * @returns 적용된 최신 스냅샷 복사본, 스킵/삭제되었으면 undefined
   */
  async refreshWith(
    refresher: ComparisonRefresher,
    reason = "manual",
    options: ComparisonRefreshOptions = {}
  ): Promise<ComparisonSnapshot | undefined> {
    const includeDisabled = options.includeDisabled ?? false;
    const current = this.getComparison(includeDisabled);
    if (this.disposed || !current) {
      this.requestRefresh(reason);
      return undefined;
    }

    const generation = ++this.refreshGeneration;
    logInfo("comparison refresh started", {
      reason,
      repoRoot: current.repoRoot,
      kind: current.kind,
      generation,
    });
    try {
      const refreshed = await refresher(current);
      if (
        this.disposed ||
        generation !== this.refreshGeneration ||
        (!this.enabledValue && !includeDisabled)
      ) {
        logInfo("comparison refresh result skipped", {
          reason,
          generation,
          currentGeneration: this.refreshGeneration,
          enabled: this.enabledValue,
          includeDisabled,
        });
        return undefined;
      }
      if (!refreshed) {
        this.clearComparison(`refresh:${reason}`);
        return undefined;
      }
      this.comparison = cloneComparison(refreshed);
      this.publishChange("refresh", {
        reason,
        repoRoot: refreshed.repoRoot,
        changes: refreshed.changes.length,
        generation,
      });
      return cloneComparison(refreshed);
    } catch (error) {
      if (
        this.disposed ||
        generation !== this.refreshGeneration ||
        (!this.enabledValue && !includeDisabled)
      ) {
        logInfo("comparison refresh error skipped", {
          reason,
          generation,
          currentGeneration: this.refreshGeneration,
          enabled: this.enabledValue,
          includeDisabled,
        });
        return undefined;
      }
      logError("comparison refresh failed", error, {
        reason,
        repoRoot: current.repoRoot,
        kind: current.kind,
        generation,
      });
      throw error;
    }
  }

  /**
   * 이벤트 emitter 를 해제하고 이후 비동기 refresh 결과가 적용되지 않게 한다.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.refreshGeneration++;
    this.comparisonLoadGeneration++;
    this.comparison = undefined;
    this.changeEmitter.dispose();
    this.refreshEmitter.dispose();
    logInfo("comparison controller disposed");
  }

  /**
   * 상태 변경을 OUTPUT 에 기록한 뒤 내부/외부 공용 이벤트를 한 번 발생시킨다.
   * @param reason 정규화된 상태 변경 종류
   * @param detail 문제 재현에 필요한 비교/토글 부가 정보
   */
  private publishChange(
    reason: ComparisonChangeReason,
    detail: Record<string, unknown>
  ): void {
    logInfo("comparison state changed", { reason, ...detail });
    this.changeEmitter.fire();
  }
}

/**
 * ComparisonSnapshot 을 JSON 경계를 통과한 독립 객체로 복제한다.
 * - snapshot 계약은 public cross-extension API 용으로 직렬화 가능해야 하므로 JSON 복사가 적합하다.
 * @param comparison 복제할 원본 스냅샷
 * @returns 중첩 changes/pullRequest 객체까지 분리된 새 스냅샷
 */
function cloneComparison(comparison: ComparisonSnapshot): ComparisonSnapshot {
  return JSON.parse(JSON.stringify(comparison)) as ComparisonSnapshot;
}
