// Changes hook 관리 모듈이 보내는 제한된 메시지를 등록된 내부 command 로 라우팅한다.
// - provider 의 큰 메시지 분기와 hook 기능을 분리하고, 임의 command ID 실행을 허용하지 않는다.
import * as vscode from "vscode";
import { logError } from "../ui/outputLog";
import type { ChangesWebviewMessage } from "./changesWebviewProtocol";

/**
 * commit hook/실패 카드 전용 웹뷰 메시지를 식별해 대응 명령을 실행한다.
 * @param message Changes 웹뷰에서 받은 검증 전 메시지
 * @returns 이 모듈이 처리한 hook 메시지이면 true, 다른 기능 메시지이면 false
 */
export function routeCommitHookMessage(
  message: ChangesWebviewMessage,
  webview?: vscode.Webview
): boolean {
  switch (message.type) {
    case "runCommitHookPreflight":
      runHookOperation(
        webview,
        "preflight",
        undefined,
        "gitSimpleCompare.runCommitHookPreflight",
        { message: message.message }
      );
      return true;
    case "refreshCommitHooks":
      runHookOperation(
        webview,
        "refresh",
        undefined,
        "gitSimpleCompare.refreshCommitHooks"
      );
      return true;
    case "toggleCommitHook":
      runHookOperation(
        webview,
        "toggle",
        message.hookName,
        "gitSimpleCompare.toggleCommitHook",
        { name: message.hookName, enabled: message.enabled }
      );
      return true;
    case "createCommitHook":
      runHookOperation(
        webview,
        "create",
        undefined,
        "gitSimpleCompare.createCommitHook"
      );
      return true;
    case "openCommitHook":
      void vscode.commands.executeCommand(
        "gitSimpleCompare.openCommitHook",
        message.hookName
      );
      return true;
    case "openCommitHooksFolder":
      void vscode.commands.executeCommand(
        "gitSimpleCompare.openCommitHooksFolder"
      );
      return true;
    case "openCommitFailure":
      void vscode.commands.executeCommand("gitSimpleCompare.openCommitFailure", {
        path: message.path,
        line: message.line,
        column: message.column,
      });
      return true;
    case "dismissCommitFailure":
      void vscode.commands.executeCommand(
        "gitSimpleCompare.dismissCommitFailure"
      );
      return true;
    case "showCommitFailureOutput":
      void vscode.commands.executeCommand(
        "gitSimpleCompare.showCommitFailureOutput"
      );
      return true;
    default:
      return false;
  }
}

/**
 * hook mutation/refresh 명령의 시작과 완료를 웹뷰에 알려 busy 상태를 render와 분리한다.
 * @param webview operation 상태를 받을 현재 Changes 웹뷰
 * @param action refresh/toggle/create 종류
 * @param hookName toggle 대상 hook 이름
 * @param command 실행할 내부 command ID
 * @param args command에 전달할 선택 인자
 */
function runHookOperation(
  webview: vscode.Webview | undefined,
  action: "preflight" | "refresh" | "toggle" | "create",
  hookName: string | undefined,
  command: string,
  args?: unknown
): void {
  void webview?.postMessage({
    type: "commitHookOperation",
    active: true,
    action,
    hookName,
  });
  void Promise.resolve(
    vscode.commands.executeCommand(command, ...(args === undefined ? [] : [args]))
  )
    .catch((error) => {
      logError("commit hook webview operation failed", error, {
        action,
        hookName,
      });
      vscode.window.showErrorMessage(
        vscode.l10n.t(
          "Commit hook action failed. See the Git Simple Compare output for details."
        )
      );
    })
    .finally(() => {
      void webview?.postMessage({
        type: "commitHookOperation",
        active: false,
        action,
        hookName,
      });
    });
}
