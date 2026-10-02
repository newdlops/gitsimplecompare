// Changes의 Git 사용 설정과 표시 설정 이벤트를 VS Code UI 경계에서 관리한다.
// - 확장 진입점은 상태 전환 콜백만 제공하고 설정 이벤트의 구독·로그는 이 모듈에 위임한다.
import * as vscode from "vscode";
import { logInfo } from "./outputLog";

/** 설정 이벤트가 요청할 Git 상태 전환과 화면 갱신 동작을 나타낸다. */
export interface ViewConfigurationCallbacks {
  onGitEnablementChanged: () => void;
  refreshView: () => void;
}

/**
 * 내장 Git 사용·아이콘 테마·거터·색상 테마 변경을 구독하고 관련 화면 동작만 요청한다.
 * @param callbacks Git 설정 변경과 표시 설정 변경을 각 책임 모듈로 전달할 콜백
 * @returns 확장 컨텍스트에서 함께 해제할 설정·색상 테마 구독 목록
 */
export function registerViewConfigurationEvents(
  callbacks: ViewConfigurationCallbacks
): vscode.Disposable[] {
  return [
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("git.enabled")) {
        logInfo("vscode git setting changed", {
          enabled: vscode.workspace.getConfiguration("git").get<boolean>("enabled", true),
        });
        callbacks.onGitEnablementChanged();
      }
      if (event.affectsConfiguration("workbench.iconTheme")) {
        logInfo("file icon theme changed");
        callbacks.refreshView();
      }
      if (event.affectsConfiguration("scm.diffDecorations")) {
        logInfo("editor gutter setting changed");
        callbacks.refreshView();
      }
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      logInfo("color theme changed");
      callbacks.refreshView();
    }),
  ];
}
