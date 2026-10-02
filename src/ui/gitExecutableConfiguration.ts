// VS Code 설정을 공통 Git 실행 계층에 연결하는 어댑터.
// - 저장소 cwd마다 유효 설정을 읽으므로 전역·워크스페이스·폴더 우선순위와 즉시 변경을 지원한다.
import * as vscode from "vscode";
import { setGitExecutableResolver } from "../git/gitExec";
import { setGitExecutionObserver } from "../git/gitExecutionDiagnostics";
import { logInfo, logWarn } from "./outputLog";

/**
 * 실행 경로 resolver·느린 프로세스 계측·설정 관찰을 등록하고 확장 종료 시 모두 해제한다.
 * @returns 확장 컨텍스트가 dispose할 설정 연결 객체
 */
export function registerGitExecutableConfiguration(): vscode.Disposable {
  const reset = setGitExecutableResolver(cwd => vscode.workspace
    .getConfiguration("gitSimpleCompare", vscode.Uri.file(cwd)).get<string>("gitPath", ""));
  // Git 내부 계산과 구분해야 할 동기 spawn/완료 대기를 모든 실행 모드에서 같은 필드로 관찰한다.
  const resetObserver = setGitExecutionObserver(timing => {
    if (timing.outcome === "error" && ["EBADF", "EMFILE", "ENFILE", "EAGAIN"].includes(String(timing.code))) {
      logWarn("git process retryable spawn error", { ...timing });
    } else if (timing.syncSpawnMs >= 100 || timing.elapsedMs >= 1_000) logWarn("git process slow", { ...timing });
  });
  logGitExecutableConfiguration("git executable configuration registered");
  const subscription = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("gitSimpleCompare.gitPath")) {
      logGitExecutableConfiguration("git executable setting changed");
    }
  });
  return { dispose: () => { subscription.dispose(); resetObserver(); reset(); } };
}

/**
 * 사용자 기본값과 폴더별 유효 실행 경로를 OUTPUT에 남겨 경로 차이를 추적한다.
 * @param event 등록 또는 설정 변경을 구분하는 로그 이름
 */
function logGitExecutableConfiguration(event: string): void {
  logInfo(event, {
    userDefault: vscode.workspace.getConfiguration("gitSimpleCompare").inspect<string>("gitPath")?.globalValue?.trim() || "git",
    workspaceExecutable: vscode.workspace.getConfiguration("gitSimpleCompare").get<string>("gitPath", "").trim() || "git",
    folders: vscode.workspace.workspaceFolders?.map(folder => ({
      root: folder.uri.fsPath,
      executable: vscode.workspace.getConfiguration("gitSimpleCompare", folder.uri).get<string>("gitPath", "").trim() || "git",
    })) ?? [],
  });
}
