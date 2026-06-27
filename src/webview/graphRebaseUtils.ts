// graph rebase 액션들이 공유하는 작은 유틸리티 모듈.
// - 실행 흐름 모듈의 파일 크기를 줄이고, path/refresh 같은 공통 조립만 담당한다.
import * as vscode from "vscode";

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
 * rebase 제어 후 그래프와 Changes 트리를 같은 타이밍에 갱신한다.
 * @param deps   graph refresh 콜백
 * @param reason changes refresh 사유
 */
export async function refreshAfterRebaseControl(
  deps: { refreshGraph: () => Promise<void> },
  reason: string
): Promise<void> {
  await deps.refreshGraph();
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", { reason });
}
