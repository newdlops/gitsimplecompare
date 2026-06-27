// rebase 충돌/정지 상태에서 관련 뷰를 포커스하고 사용자 안내를 띄우는 모듈.
// - graphRebaseActions.ts 의 실행 흐름과 충돌 UI 후속 처리를 분리한다.
import * as vscode from "vscode";
import { ConflictService } from "../git/conflictService";
import { readRebaseContinueDiagnostics } from "../git/rebaseContinueDiagnostics";
import { logInfo } from "../ui/outputLog";
import {
  rebaseDiagnosticDetail,
  rebaseDiagnosticLogDetail,
} from "./graphRebaseDiagnostics";

/**
 * rebase 충돌이 발생하면 충돌 뷰로 이동하고, index 충돌이 없으면 진단 메시지를 보여준다.
 * @param repoRoot 저장소 루트
 */
export async function focusRebaseConflicts(repoRoot: string): Promise<void> {
  const [files, diagnostics] = await Promise.all([
    new ConflictService(repoRoot).listConflicts().catch(() => []),
    readRebaseContinueDiagnostics(repoRoot).catch(() => undefined),
  ]);
  logInfo("graph rebase conflicts detected", {
    repoRoot,
    conflicts: files.length,
    ...rebaseDiagnosticLogDetail(diagnostics),
  });
  await vscode.commands.executeCommand("gitSimpleCompare.refreshConflicts");
  await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "graphRebaseConflict",
  });
  if (files.length === 0) {
    vscode.window.showWarningMessage(
      rebaseDiagnosticDetail(diagnostics) ||
        vscode.l10n.t("Rebase paused at a todo item. Check the current todo card, then Continue, Skip, or Abort.")
    );
    return;
  }
  vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Rebase paused due to conflicts. Resolve them in the Conflicts view, then Continue, Skip, or Abort."
    )
  );
}
