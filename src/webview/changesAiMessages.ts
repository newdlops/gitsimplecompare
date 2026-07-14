// Changes 웹뷰에서 발생한 AI 메시지를 관련 명령으로 라우팅한다.
// - provider의 긴 메시지 분기에서 AI 기능을 분리해 새 AI 모드를 추가해도 렌더 책임이 커지지 않게 한다.
import * as vscode from "vscode";
import type { ChangesWebviewMessage } from "./changesWebviewProtocol";

/**
 * Changes 웹뷰의 AI 커밋 메시지/플랜/설정 요청을 처리한다.
 * @param message 웹뷰에서 받은 메시지
 * @returns AI 관련 메시지를 처리했으면 true, 다른 라우터가 처리해야 하면 false
 */
export function routeChangesAiMessage(message: ChangesWebviewMessage): boolean {
  if (message.type === "generateCommitMessage") {
    void vscode.commands.executeCommand(
      "gitSimpleCompare.generateCommitMessage"
    );
    return true;
  }
  if (message.type === "configureAiCli") {
    void vscode.commands.executeCommand("gitSimpleCompare.configureAiCli");
    return true;
  }
  if (message.type === "openAiCommitPlan") {
    void vscode.commands.executeCommand("gitSimpleCompare.openAiCommitPlan", {
      operation: message.op,
      commitIntent: message.message,
      extraPrompt: message.prompt,
      autoGenerate: message.autoGenerate === true,
    });
    return true;
  }
  if (message.type === "aiCommitPlanAmendUnsupported") {
    vscode.window.showInformationMessage(
      vscode.l10n.t("AI plan mode is not available for amend commits.")
    );
    return true;
  }
  return false;
}
