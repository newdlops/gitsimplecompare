// 그래프 checkout 중 충돌이 발생했을 때 Conflicts 뷰로 이동시키는 보조 모듈.
// - graphActions 는 checkout 흐름만 담당하고, 충돌 감지/포커스 UI 는 여기로 분리한다.
import * as vscode from "vscode";
import { ConflictService } from "../git/conflictService";
import { GitError } from "../git/gitExec";
import {
  isUntrackedCheckoutBlocker,
  materializeUntrackedCheckoutConflicts,
  untrackedCheckoutPaths,
} from "../git/untrackedCheckoutConflicts";
import { logInfo } from "../ui/outputLog";

export type CheckoutConflictRetryResult = "cancelled" | "completed" | "conflicts";

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
 * checkout 실패 후 사용자가 승인하면 untracked blocker 는 marker 파일로 만들고, 그 외에는 전달된 merge checkout 을 재시도한다.
 * @param err       최초 checkout 실패 오류
 * @param repoRoot  저장소 루트
 * @param targetRef checkout 대상 ref. untracked incoming 내용을 읽는 기준이다.
 * @param checkout  실제 checkout 재시도 함수
 * @returns 사용자가 취소했는지, checkout 이 완료됐는지, 충돌 해결 화면으로 이어져야 하는지
 */
export async function retryCheckoutWithConflicts(
  err: unknown,
  repoRoot: string,
  targetRef: string,
  checkout: () => Promise<void>
): Promise<CheckoutConflictRetryResult> {
  if (!(await confirmCheckoutWithConflicts(err))) {
    return "cancelled";
  }
  if (!isUntrackedCheckoutBlocker(err)) {
    await checkout();
    return "completed";
  }
  const files = await materializeUntrackedCheckoutConflicts(
    repoRoot,
    targetRef,
    untrackedCheckoutPaths(err),
    checkout
  );
  await focusMaterializedUntrackedConflicts(repoRoot, files.map((file) => file.path));
  return "conflicts";
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

/**
 * marker 파일로 만든 untracked 충돌을 Changes 뷰와 실제 VS Code editor 에 노출한다.
 * @param repoRoot 저장소 루트
 * @param paths    marker 파일을 쓴 상대 경로 목록
 */
async function focusMaterializedUntrackedConflicts(
  repoRoot: string,
  paths: string[]
): Promise<void> {
  logInfo("graph checkout untracked conflicts materialized", {
    repoRoot,
    conflicts: paths.length,
  });
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "graphCheckoutUntrackedConflict",
  });
  await vscode.commands.executeCommand("gitSimpleCompare.changes.focus");
  if (paths[0]) {
    await vscode.commands.executeCommand(
      "vscode.open",
      vscode.Uri.file(`${repoRoot}/${paths[0]}`)
    );
  }
  await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Checkout created editable conflict marker files for untracked files. Resolve the current/incoming sections, then stage the files."
    )
  );
}

/** 오류 메시지를 사용자에게 보여줄 짧은 문자열로 만든다. */
function errorText(err: unknown): string {
  return err instanceof GitError
    ? `${err.message}\n${err.stderr}`
    : err instanceof Error
      ? err.message
      : String(err);
}
