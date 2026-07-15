// conflict service가 반환하는 안전성 오류와 recovery 경로를 사용자 언어로 표시한다.
// - webview/native editor 어느 UI에서도 Git 계층의 원문 오류 계약을 중복 해석하지 않게 한다.
import * as vscode from "vscode";
import { logWarn } from "./outputLog";

const LOCALIZED_CONFLICT_ERRORS = new Set([
  "Accept Both requires two text conflict sides.",
  "Accept Both requires a text working-tree Result.",
  "Accept Both requires complete conflict marker blocks.",
  "Manual Result editing is not available for symlink, directory, or other non-regular file conflicts.",
  "Conflict path must stay inside the repository.",
  "This file is no longer conflicted. Reload the conflict editor.",
  "The conflict sources changed outside this editor. Reload it before resolving.",
  "The conflict Result changed outside this editor. Reload it before resolving.",
  "Another Git process is updating the index. Try the conflict action again.",
  "The Git index lock changed during conflict resolution. The index was not published.",
  "Conflict path parent contains a symbolic link.",
]);
const RECOVERY_ERROR_PREFIX =
  "The conflict file changed again. Recovery files were preserved at ";
const UNSUPPORTED_MODE_PREFIX = "Unsupported conflict stage mode: ";

/**
 * 알려진 conflict safety 오류는 지역화하고 예상하지 못한 Git 진단은 원문을 보존한다.
 * @param error service/transaction에서 전달된 unknown 오류
 * @returns showErrorMessage와 OUTPUT에 사용할 사용자 문자열
 */
export function localizeConflictActionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(RECOVERY_ERROR_PREFIX)) {
    return vscode.l10n.t(
      "The conflict file changed again. Recovery files were preserved at {0}",
      message.slice(RECOVERY_ERROR_PREFIX.length)
    );
  }
  if (message.startsWith(UNSUPPORTED_MODE_PREFIX)) {
    return vscode.l10n.t(
      "Unsupported conflict stage mode: {0}",
      message.slice(UNSUPPORTED_MODE_PREFIX.length)
    );
  }
  return LOCALIZED_CONFLICT_ERRORS.has(message)
    ? vscode.l10n.t(message)
    : message;
}

/**
 * 동시 writer의 원본을 recovery 경로에 보존한 성공 결과를 OUTPUT과 경고로 알린다.
 * @param repoRoot 로그에 남길 저장소 루트
 * @param rel 충돌 상대 경로
 * @param recoveryPath 보존된 실제 경로
 */
export function showConflictRecoveryWarning(
  repoRoot: string,
  rel: string,
  recoveryPath: string
): void {
  logWarn("conflict resolution preserved concurrent edits", {
    repoRoot,
    rel,
    recoveryPath,
  });
  void vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Conflict resolved, but concurrent edits were preserved at {0}",
      recoveryPath
    )
  );
}
