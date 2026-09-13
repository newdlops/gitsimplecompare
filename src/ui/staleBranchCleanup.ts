// stale 브랜치 정리의 최종 확인·결과를 기존 VS Code 네이티브 UI로 표시한다.
// - Git 판별은 서비스가 제공한 스냅샷을 사용하고, 여기서는 지역화와 표시만 담당한다.
import * as vscode from "vscode";
import type { StaleBranch, StaleBranchCleanupResult } from "../git/staleBranchService";
import { showOutputLog } from "./outputLog";

/**
 * 정확한 저장소와 선택 이름을 보여 주고 로컬 브랜치 일괄 삭제를 확인한다.
 * @param repoRoot 선택창에서 고정한 저장소
 * @param branches 사용자가 체크한 브랜치
 * @param force 미병합 브랜치에 대한 두 번째 확인인지 여부
 * @returns 해당 삭제 버튼을 누른 경우에만 true
 */
export async function confirmStaleBranchCleanup(repoRoot: string, branches: readonly StaleBranch[], force = false): Promise<boolean> {
  const t = vscode.l10n.t;
  const action = force ? t("Force Delete") : t("Delete Local Branches");
  const message = force
    ? t("Force delete {0} branch(es) that Git could not safely delete?", branches.length)
    : t("Delete {0} selected stale local branch(es)?", branches.length);
  const explanation = force
    ? t("These branches were not safely deleted because their history is not fully merged. Force deletion can lose commits reachable only from these branches.")
    : t("Remote branches and working files are kept. Branches that are not fully merged require a separate confirmation.");
  const names = branches.slice(0, 20).map(branch => `${branch.name} (${branch.hash.slice(0, 10)})`);
  if (branches.length > names.length) names.push(t("… and {0} more selected branch(es)", branches.length - names.length));
  return await vscode.window.showWarningMessage(message, {
    modal: true, detail: `${repoRoot}\n\n${names.join("\n")}\n\n${explanation}`,
  }, action) === action;
}

/**
 * 삭제와 보존 수를 구분하고 부분 실패의 이유는 OUTPUT으로 바로 확인하게 한다.
 * @param result 일반 삭제와 선택적인 강제 삭제를 합친 최종 결과
 * @returns 사용자 알림 처리 완료 Promise
 */
export async function showStaleBranchCleanupResult(result: StaleBranchCleanupResult): Promise<void> {
  const t = vscode.l10n.t;
  const kept = result.unmerged.length + result.skipped.length;
  if (!kept) {
    await vscode.window.showInformationMessage(t("Deleted {0} stale local branch(es).", result.deleted.length));
    return;
  }
  const output = t("Show Output");
  const choice = await vscode.window.showWarningMessage(
    t("Deleted {0} stale local branch(es); kept {1}. See Output for details.", result.deleted.length, kept), output,
  );
  if (choice === output) showOutputLog(false);
}
