// native diff overlay 의 첫 paint 가 VS Code DOM 준비보다 빨리 실행될 때 재시도한다.
// - diff 화면 렌더링은 기다리지 않고, checkbox overlay 만 뒤에서 몇 차례 다시 붙인다.

const RETRY_DELAYS = [180, 420, 900, 1600, 2600];

/** 진행 중 이벤트를 누적하지 않고 마지막 요청 하나만 처리하는 renderer 작업 drain. */
export class NativeOverlayRenderDrain {
  private pendingReason: string | undefined;
  private active = false;
  private task: Promise<void> = Promise.resolve();

  /**
   * 작업이 진행 중이면 최신 원인만 교체하고, 비어 있으면 새 drain을 시작한다.
   * @param reason 최신 snapshot을 읽게 만든 이벤트 원인
   * @param run 원인 하나의 renderer 갱신을 수행할 함수
   * @param onError snapshot 조회 또는 렌더 예외를 기록할 함수
   */
  enqueue(
    reason: string,
    run: (reason: string) => Promise<void>,
    onError: (error: unknown, reason: string) => void
  ): void {
    this.pendingReason = reason;
    if (this.active) return;
    this.active = true;
    this.task = this.drain(run, onError).finally(() => {
      this.active = false;
    });
  }

  /** 아직 시작하지 않은 마지막 render 요청을 폐기한다. */
  clear(): void {
    this.pendingReason = undefined;
  }

  /** 현재 진행 중인 drain의 완료 Promise를 반환한다. */
  completion(): Promise<void> {
    return this.task;
  }

  /** 첫 요청과 실행 중 들어온 마지막 요청을 순서대로 처리한다. */
  private async drain(
    run: (reason: string) => Promise<void>,
    onError: (error: unknown, reason: string) => void
  ): Promise<void> {
    while (this.pendingReason) {
      const reason = this.pendingReason;
      this.pendingReason = undefined;
      try {
        await run(reason);
      } catch (error) {
        onError(error, reason);
      }
    }
  }
}

/** inspector 연결 실패 뒤 interaction과 독립적으로 한 번만 재시도하는 timer. */
export class NativeOverlayConnectionRetry {
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * 이미 예약된 deadline은 유지하고 새 retry가 없을 때만 실행을 예약한다.
   * @param delayMs inspector cooldown이 끝날 때까지 남은 시간
   * @param run deadline에 최신 overlay snapshot을 요청할 함수
   */
  schedule(delayMs: number, run: () => void): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      run();
    }, Math.max(0, delayMs));
  }

  /** 연결 성공 또는 controller 종료 시 예약된 재시도를 해제한다. */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/**
 * 정리용 Promise를 지정 시간까지만 기다려 extension reload가 외부 CDP 상태에 묶이지 않게 한다.
 * @param task 완료를 best-effort로 기다릴 비동기 작업
 * @param timeoutMs 기다릴 최대 시간
 */
export async function waitAtMost(task: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    task.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

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
    const retryReason = reason.startsWith("initialPaintRetry");
    if (!retryReason) {
      this.clear();
      this.signature = signature;
    } else if (this.signature !== signature) {
      return;
    }
    const text = String(result ?? "");
    if (!needsRetry(text)) {
      if (retryReason) {
        this.clear();
      }
      return;
    }
    if (retryReason) {
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
  if (!result.includes("paint:native:") && !result.includes("paint:no-editor")) {
    return result.includes("render-scheduled:");
  }
  if (
    result.includes("rowLines=no-margin") ||
    result.includes("rowLines=no-source") ||
    result.includes("paint:no-editor")
  ) {
    return true;
  }
  return /paint:native:0\/[1-9]/.test(result);
}
