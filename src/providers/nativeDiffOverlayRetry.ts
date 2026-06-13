// native diff overlay 의 첫 paint 가 VS Code DOM 준비보다 빨리 실행될 때 재시도한다.
// - diff 화면 렌더링은 기다리지 않고, checkbox overlay 만 뒤에서 몇 차례 다시 붙인다.

const RETRY_DELAYS = [180, 420, 900, 1600, 2600];

/** 초기 paint 결과를 보고 필요한 경우 재렌더를 예약하는 작은 helper. */
export class NativeDiffInitialPaintRetry {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private signature = "";

  /**
   * renderer paint 결과를 분석하고, DOM 이 아직 준비되지 않은 경우만 후속 렌더를 예약한다.
   * @param signature 현재 snapshot 서명. 새 snapshot 이 오면 기존 retry 는 폐기된다.
   * @param result renderer 가 반환한 진단 문자열
   * @param reason 현재 render 사유
   * @param scheduleRender controller 의 render 예약 함수
   */
  schedule(
    signature: string,
    result: unknown,
    reason: string,
    scheduleRender: (reason: string, delay?: number) => void
  ): void {
    this.clear();
    this.signature = signature;
    const text = String(result ?? "");
    if (!needsRetry(text)) {
      return;
    }
    RETRY_DELAYS.forEach((delay, index) => {
      const timer = setTimeout(() => {
        if (this.signature !== signature) {
          return;
        }
        scheduleRender(`initialPaintRetry:${reason}:${index + 1}`, 0);
      }, delay);
      this.timers.push(timer);
    });
  }

  /** 예약된 retry timer 를 모두 해제한다. */
  clear(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
  }
}

/**
 * renderer 결과가 DOM 미준비 상태인지 판별한다.
 * @param result native overlay renderer 의 진단 문자열
 * @returns retry 가 의미 있으면 true
 */
function needsRetry(result: string): boolean {
  if (!result.includes("paint:native:")) {
    return false;
  }
  if (
    result.includes("rowLines=no-margin") ||
    result.includes("rowLines=no-source") ||
    result.includes("paint:no-editor")
  ) {
    return false;
  }
  return /paint:native:0\/[1-9]/.test(result);
}
