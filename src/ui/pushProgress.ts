// Git 순차 push의 진행 이벤트를 기존 VS Code 알림과 OUTPUT에 표시하는 UI 어댑터다.
import * as vscode from "vscode";
import { isGitLifecycleError } from "../git/gitError";
import { gitErrorText } from "../git/pushErrors";
import { SequentialPushError, type PushExecutionOptions, type PushProgress } from "../git/sequentialPush";
import { logInfo } from "./outputLog";

/**
 * 기존 push 알림에 커밋 번호·성공률·취소를 연결한다. 원격 URL/파일 내용은 로그에 포함하지 않는다.
 * @param repoRoot 진행 로그의 저장소 @param task Git 서비스에 전달할 실행 옵션을 받는 작업
 * @returns 서비스 결과. 부분 실패/취소는 원격 진행량을 보존한 오류로 호출부에 전달한다.
 */
export async function withPushProgress<T>(repoRoot: string, task: (options: PushExecutionOptions) => Promise<T>): Promise<T> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Pushing..."), cancellable: true,
  }, async (progress, token) => {
    const controller = new AbortController();
    let last: PushProgress = { phase: "planning", strategy: "single", completed: 0, total: 0 };
    const cancellation = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try {
      return await task({ signal: controller.signal, onProgress: event => {
        last = event;
        reportPushProgress(repoRoot, progress, event);
      } });
    } catch (error) {
      const failure = error instanceof SequentialPushError ? error : controller.signal.aborted && isGitLifecycleError(error)
        ? new SequentialPushError(error, { ...last }, true) : error;
      if (isPushCancelled(failure)) {
        logInfo("push transfer cancelled", { repoRoot, ...failure.result });
        void vscode.window.showInformationMessage(vscode.l10n.t(
          "Push cancelled. {0}/{1} commits were confirmed pushed. Check the remote before retrying.",
          failure.result.completed, failure.result.total
        ));
      }
      throw failure;
    } finally {
      cancellation.dispose();
      // 일부 전송 뒤 실패해도 ahead/upstream 상태와 그래프가 stale로 남지 않게 갱신한다.
      void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", { reason: "push" });
    }
  });
}

/**
 * 순수 Git 진행을 기존 알림에 연결한다. PR/Stack처럼 push 뒤 후속 단계가 있으면 백분율은 생략한다.
 * @param repoRoot 로그 저장소 @param progress VS Code 진행 표시 @param event 확인된 전송 상태
 * @param percentage 전체 작업이 push일 때만 성공한 비율을 증가시킨다.
 */
export function reportPushProgress(repoRoot: string, progress: vscode.Progress<{ message?: string; increment?: number }>, event: PushProgress, percentage = true): void {
  logInfo(`push transfer ${event.phase}`, { repoRoot, ...event });
  if (event.phase === "planning") progress.report({ message: vscode.l10n.t("Preparing push...") });
  if (event.phase === "ready" && event.strategy === "sequential") {
    progress.report({ message: vscode.l10n.t("Pushing {0} commits one by one...", event.total) });
  }
  if (event.phase === "pushing" && event.strategy === "sequential") {
    progress.report({ message: vscode.l10n.t("Pushing commit {0}/{1} ({2})...", event.completed + 1, event.total, event.commit?.slice(0, 7) ?? "") });
  }
  if (event.phase === "pushed" && percentage) progress.report({ increment: 100 / event.total });
}

/** 취소 알림을 이미 표시한 오류를 구분해 상위 명령이 다시 실패 모달을 띄우지 않게 한다. */
export function isPushCancelled(error: unknown): error is SequentialPushError {
  return error instanceof SequentialPushError && error.cancelled;
}

/**
 * 부분 성공을 지역화해 원격 상태와 재시도 동작을 설명한다.
 * @param error 전송 원본 오류 @returns 일반 Git 진단 또는 성공한 커밋 수를 포함한 오류 문구
 */
export function pushFailureText(error: unknown): string {
  return error instanceof SequentialPushError ? vscode.l10n.t(
    "Push stopped after {0}/{1} commits. Commits already pushed remain on the remote. Retry to continue.\n{2}",
    error.result.completed, error.result.total, gitErrorText(error.cause)
  ) : gitErrorText(error);
}
