// 그래프 checkout 중 충돌이 발생했을 때 Conflicts 뷰로 이동시키는 보조 모듈.
// - graphActions 는 checkout 흐름만 담당하고, 충돌 감지/포커스 UI 는 여기로 분리한다.
import * as vscode from "vscode";
import { ConflictService } from "../git/conflictService";
import { logInfo } from "../ui/outputLog";

/**
 * checkout 충돌로 보이는 git 오류인지 판단한다.
 * @param err git switch 계열 명령에서 발생한 오류
 * @returns 로컬 변경/미추적 파일 때문에 checkout 이 막힌 오류면 true
 */
export function isCheckoutConflictError(err: unknown): boolean {
  return /local changes|would be overwritten|untracked working tree files|not uptodate|Please commit/i.test(
    errorText(err)
  );
}

/**
 * 사용자가 충돌을 만들 수 있는 checkout 을 계속 진행할지 확인한다.
 * @param err 최초 checkout 실패 오류
 * @returns 사용자가 "Checkout with Conflicts" 를 선택하면 true
 */
export async function confirmCheckoutWithConflicts(
  err: unknown
): Promise<boolean> {
  const yes = vscode.l10n.t("Checkout with Conflicts");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("Checkout conflicts with local changes."),
    { modal: true, detail: errorText(err) },
    yes,
    vscode.l10n.t("Do Not Checkout")
  );
  return choice === yes;
}

/**
 * checkout 뒤 실제 충돌 파일이 있으면 Conflicts 뷰를 갱신하고 포커스한다.
 * @param repoRoot 저장소 루트
 * @returns 충돌 화면으로 이동했으면 true
 */
export async function focusCheckoutConflicts(repoRoot: string): Promise<boolean> {
  const files = await new ConflictService(repoRoot).listConflicts().catch(() => []);
  if (!files.length) {
    return false;
  }
  logInfo("graph checkout conflicts detected", {
    repoRoot,
    conflicts: files.length,
  });
  await vscode.commands.executeCommand("gitSimpleCompare.refreshConflicts");
  await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "graphCheckoutConflict",
  });
  await vscode.window.showWarningMessage(
    vscode.l10n.t("Checkout stopped with conflicts. Resolve them in the Conflicts view.")
  );
  return true;
}

/** 오류 메시지를 사용자에게 보여줄 짧은 문자열로 만든다. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
