// 충돌 해결용 Merge Editor 를 여는 UI 헬퍼.
// - 충돌 명령/Changes 클릭 양쪽에서 같은 진입점을 쓰도록 분리한다.
// - VS Code Git 확장을 먼저 활성화해 raw conflict marker 파일로 떨어지는 일을 줄인다.
import * as vscode from "vscode";

/**
 * VS Code 내장 Git Merge Editor 로 충돌 파일을 연다.
 * - Git 확장 명령이 실패하면 마지막 안전장치로 일반 편집기를 연다.
 * @param uri 충돌이 발생한 실제 파일 URI
 */
export async function openMergeEditorUri(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.extensions.getExtension("vscode.git")?.activate();
  } catch {
    // Git 확장이 비활성/사용 불가여도 아래 폴백 경로가 처리한다.
  }
  try {
    await vscode.commands.executeCommand("git.openMergeEditor", uri);
  } catch {
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "The merge editor could not be opened. Opening the conflicted file instead."
      )
    );
    await vscode.commands.executeCommand("vscode.open", uri);
  }
}
