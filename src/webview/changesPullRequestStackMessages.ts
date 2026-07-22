// Changes 웹뷰 PR Stacks 전용 메시지를 등록 명령으로 전달하는 라우터.
// - provider 본문이 GitHub 작업별 필드를 알지 않게 하고 PR stack 기능의 프로토콜 변경을 한곳에 모은다.
import * as vscode from "vscode";
import type { ChangesWebviewMessage } from "./changesWebviewProtocol";

/**
 * PR Stacks 섹션 메시지면 대응하는 VS Code 명령을 실행한다.
 * @param msg Changes 웹뷰에서 받은 메시지
 * @returns 이 라우터가 처리한 PR stack 메시지면 true
 */
export function routeChangesPullRequestStackMessage(
  msg: ChangesWebviewMessage
): boolean {
  if (msg.type === "refreshPullRequestStacks") {
    void vscode.commands.executeCommand("gitSimpleCompare.refreshPullRequestStacks");
    return true;
  }
  if (msg.type === "openStackPullRequest" && (msg.url || msg.number)) {
    void vscode.commands.executeCommand("gitSimpleCompare.openStackPullRequest", {
      repoRoot: msg.repoRoot,
      number: msg.number,
      url: msg.url,
    });
    return true;
  }
  if (msg.type === "changeStackPullRequestBase" && msg.number) {
    void vscode.commands.executeCommand("gitSimpleCompare.changeStackPullRequestBase", {
      repoRoot: msg.repoRoot,
      number: msg.number,
    });
    return true;
  }
  if (msg.type === "createStackPullRequest") {
    void vscode.commands.executeCommand("gitSimpleCompare.createStackPullRequest", {
      repoRoot: msg.repoRoot,
      number: msg.number,
      baseBranch: msg.baseBranch,
    });
    return true;
  }
  return false;
}
