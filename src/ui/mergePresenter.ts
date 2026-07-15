// 충돌 해결용 Merge Editor 를 여는 UI 헬퍼.
// - 충돌 명령/Changes 클릭 양쪽에서 같은 진입점을 쓰도록 분리한다.
// - VS Code Git 확장을 먼저 활성화해 raw conflict marker 파일로 떨어지는 일을 줄인다.
import * as vscode from "vscode";

/**
 * VS Code 내장 Git Merge Editor 로 충돌 파일을 연다.
 * - Git 확장 명령이 실패하면 마지막 안전장치로 일반 편집기를 연다.
 * @param uri 충돌이 발생한 실제 파일 URI
 * @param fallbackToText 실패 시 일반 file editor를 열지 여부
 * @param verifyOpened command 완료 뒤 실제 merge tab 활성화를 검증할지 여부
 * @param validateBeforeOpen Git 확장 activation 뒤 file URI를 열기 직전에 실행할 안전성 fence
 * @returns merge editor command가 성공하고 요청 시 tab 검증까지 통과했으면 true
 */
export async function openMergeEditorUri(
  uri: vscode.Uri,
  fallbackToText = true,
  verifyOpened = false,
  validateBeforeOpen?: () => Promise<boolean>
): Promise<boolean> {
  try {
    await vscode.extensions.getExtension("vscode.git")?.activate();
  } catch {
    // Git 확장이 비활성/사용 불가여도 아래 폴백 경로가 처리한다.
  }
  if (validateBeforeOpen && !await validateBeforeOpen()) return false;
  try {
    await vscode.commands.executeCommand("git.openMergeEditor", uri);
    if (!verifyOpened) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (activeMergeTabMatches(uri)) return true;
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        "The merge editor did not become active. The safe conflict Result editor remains available."
      )
    );
    return false;
  } catch {
    if (fallbackToText) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "The merge editor could not be opened. Opening the conflicted file instead."
        )
      );
      await vscode.commands.executeCommand("vscode.open", uri);
    } else {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "The merge editor could not be opened. The safe conflict Result editor remains open."
        )
      );
    }
    return false;
  }
}

/** 현재 tab input을 공개/구버전 VS Code API 모두에서 구조적으로 읽어 merge Result URI를 확인한다. */
function activeMergeTabMatches(uri: vscode.Uri): boolean {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as {
    base?: unknown;
    input1?: unknown;
    input2?: unknown;
    result?: unknown;
  } | undefined;
  if (!input) return false;
  const result = input.result as { toString?: () => string } | undefined;
  const mergeShape = "base" in input && "input1" in input && "input2" in input;
  return mergeShape && typeof result?.toString === "function" &&
    result.toString() === uri.toString();
}
