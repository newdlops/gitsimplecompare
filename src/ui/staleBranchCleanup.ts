// stale 브랜치 정리의 선택·확인·결과를 기존 VS Code 네이티브 UI로 표시한다.
// - Git 판별은 서비스가 제공한 스냅샷을 사용하고, 여기서는 지역화와 표시만 담당한다.
import * as vscode from "vscode";
import { basename } from "node:path";
import type { StaleBranch, StaleBranchCleanupResult, StaleBranchInspection } from "../git/staleBranchService";
import { showOutputLog } from "./outputLog";

/** 사용자가 본 tip 스냅샷을 다중 선택 결과에도 유지한다. */
interface StaleBranchItem extends vscode.QuickPickItem { branch: StaleBranch }

/**
 * 삭제 가능한 로컬 전용 브랜치만 선택창에 표시하고 나머지 빈 상태를 안내한다.
 * @param inspection 모든 원격을 확인한 후보 목록
 * @returns 선택한 브랜치. 닫기나 빈 선택이면 undefined이며 삭제 확인으로 진행하지 않는다.
 */
export async function pickStaleBranches(inspection: StaleBranchInspection): Promise<StaleBranch[] | undefined> {
  const t = vscode.l10n.t;
  if (!inspection.remotes.length) {
    await vscode.window.showInformationMessage(t("No remotes are configured. Add a remote before checking for stale branches."));
    return;
  }
  const available = inspection.branches.filter(branch => !branch.inUse);
  if (!available.length) {
    await vscode.window.showInformationMessage(inspection.branches.length
      ? t("No removable stale branches. {0} local-only branch(es) are in use by worktrees.", inspection.branches.length)
      : t("No stale local branches found. Every local branch has a matching name on a remote."));
    return;
  }
  const selected = await vscode.window.showQuickPick<StaleBranchItem>(available.map(branch => ({
    label: branch.name,
    description: branch.merged ? t("Merged into current HEAD") : t("Not merged into current HEAD"),
    detail: `${branch.hash.slice(0, 10)} · ${branch.subject}`,
    picked: false,
    branch,
  })), {
    title: t("Clean Up Stale Branches — {0}", basename(inspection.repoRoot)),
    placeHolder: t("Select local branches absent from all remotes. Branches in use by worktrees are excluded."),
    canPickMany: true, ignoreFocusOut: true, matchOnDescription: true, matchOnDetail: true,
  });
  return selected?.length ? selected.map(item => item.branch) : undefined;
}

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
