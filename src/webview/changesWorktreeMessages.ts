// Changes 웹뷰 Worktrees 전용 메시지를 등록 명령으로 전달하는 라우터.
// - provider가 worktree 명령 인자 조립까지 맡지 않게 해 웹뷰 생명주기 책임을 작게 유지한다.
import * as vscode from "vscode";
import type { ChangesWebviewMessage } from "./changesWebviewProtocol";

/**
 * Worktrees 섹션 메시지면 대응하는 VS Code 명령을 실행한다.
 * @param msg Changes 웹뷰에서 받은 메시지
 * @returns 이 라우터가 처리한 worktree 메시지면 true
 */
export function routeChangesWorktreeMessage(msg: ChangesWebviewMessage): boolean {
  if (msg.type === "refreshWorktrees") {
    void vscode.commands.executeCommand("gitSimpleCompare.refreshWorktrees");
    return true;
  }
  if (msg.type === "openWorktree" && msg.path) {
    executeWorktreeCommand("gitSimpleCompare.openWorktree", msg);
    return true;
  }
  if (msg.type === "removeWorktree" && msg.repoRoot && msg.path) {
    executeWorktreeCommand("gitSimpleCompare.removeWorktree", msg);
    return true;
  }
  if (msg.type === "renameWorktree" && msg.repoRoot && msg.path) {
    executeWorktreeCommand("gitSimpleCompare.renameWorktree", msg);
    return true;
  }
  return false;
}

/**
 * 세 worktree 행 명령이 공유하는 안전한 POJO 인자를 만들어 실행한다.
 * @param command 실행할 등록 명령 ID
 * @param msg 웹뷰 행에서 온 worktree 필드
 */
function executeWorktreeCommand(command: string, msg: ChangesWebviewMessage): void {
  void vscode.commands.executeCommand(command, {
    repoRoot: msg.repoRoot,
    path: msg.path,
    isMain: msg.isMain,
    branch: msg.branch,
  });
}
