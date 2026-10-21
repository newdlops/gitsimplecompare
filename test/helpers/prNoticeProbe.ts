// 실제 PR Native 실행 뒤에만 고정 길이의 알림 응답 대기를 넣어 UI 완료 수명을 비교한다.
import assert from "node:assert/strict";
import { benchmarkOverrides as mock } from "./benchmarkOverrides";
import { PullRequestOperationService } from "../../src/git/pullRequestOperationService";
import { window } from "./vscodeMock";

/** Native 연산은 교체하지 않고 완료 시점만 관찰한다. VS Code 비모달 응답은 명시한 지연으로 모델링한다. */
export function probePrNotice(holdMs: number) {
  assert.ok(Number.isSafeInteger(holdMs) && holdMs >= 0 && holdMs <= 5000, "Notice hold must be bounded to 0–5000ms");
  let gitCompletedAt = 0, gitCompletedEpoch = 0, shownAt = 0, releasedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, release: (() => void) | undefined;
  for (const method of ["squashCherryPick", "rebasePullRequest"] as const) {
    const original = PullRequestOperationService.prototype[method];
    mock.method(PullRequestOperationService.prototype, method, async function (this: PullRequestOperationService, ...args: Parameters<typeof original>) {
      const result = await original.apply(this, args);
      gitCompletedAt = performance.now(); gitCompletedEpoch = Date.now(); return result;
    });
  }
  if (holdMs) mock.method(window, "showInformationMessage", () => {
    shownAt = performance.now();
    return new Promise<undefined>(resolve => {
      release = () => { clearTimeout(timer); releasedAt = performance.now(); resolve(undefined); };
      timer = setTimeout(release, holdMs);
    });
  });
  return {
    /** handler 종료 순간에도 알림이 미응답인지 별도로 기록한다. Native 속도 향상으로 해석하지 않는다. */
    handlerState: () => ({ gitCompletedAt, gitCompletedEpoch, pending: shownAt > 0 && releasedAt === 0 }),
    /** 모든 확인 후 테스트가 만든 알림 timer만 해제해 소유한 작업을 남기지 않는다. */
    dispose: () => { release?.(); },
  };
}
