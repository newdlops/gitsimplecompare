// graph rebase 액션들이 공유하는 작은 유틸리티 모듈.
// - 실행 흐름 모듈의 파일 크기를 줄이고, path/refresh 같은 공통 조립만 담당한다.
import * as vscode from "vscode";
import { logError, logInfo } from "../ui/outputLog";

/**
 * rebaseEditor.js 헬퍼 스크립트의 파일 시스템 경로를 만든다.
 * @param extensionUri 확장 루트 URI
 */
export function editorScriptPath(extensionUri: vscode.Uri): string {
  return vscode.Uri.joinPath(
    extensionUri,
    "media",
    "rebase",
    "rebaseEditor.js"
  ).fsPath;
}

/**
 * rebase 제어 후 그래프와 Changes 조회를 시작하고 Git 결과 전달을 기다리게 하지 않는다.
 * - 그래프 generation 검증은 기존 refresh 콜백이 담당한다. 조회 실패가 성공한 Git 작업을 실패로 바꾸지 않는다.
 * @param deps   graph refresh 콜백
 * @param reason changes refresh 사유
 */
export function refreshAfterRebaseControl(
  deps: { refreshGraph: () => Promise<void> },
  reason: string
): void {
  const started = Date.now();
  logInfo("rebase views refresh scheduled", { reason });
  void Promise.resolve().then(() => deps.refreshGraph()).then(() => {
    logInfo("rebase graph refresh completed", { reason, elapsedMs: Date.now() - started });
  }).catch(error => logError("rebase graph refresh failed", error, { reason }));
  void Promise.resolve().then(() => vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", { reason }))
    .catch(error => logError("rebase changes refresh failed", error, { reason }));
}
