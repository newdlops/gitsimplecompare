// PR 알림의 Undo를 원래 작업에 고정하고 선택 시 새 Git 검증 계획을 준비한다.
import * as vscode from "vscode";
import type { OperationUndoPlan } from "../git/operationUndoStore";
import { PullRequestOperationService } from "../git/pullRequestOperationService";
import { logInfo } from "../ui/outputLog";
import { presentActionNotice } from "../ui/deferredActionNotices";
import type { GraphPullRequestActionDeps } from "./graphPullRequestActions";

/** 늦은 알림이 최근의 다른 작업을 Undo하지 못하게 고정하는 최소 식별자다. */
export interface PullRequestUndoTarget {
  branch: string;
  snapshotRef: string;
  beforeHead: string;
  afterHead: string;
  id?: string;
}

/** 완료 알림 응답은 패널 busy와 분리하고 Undo 선택만 새 busy/refresh 범위에서 실행한다. */
export async function offerPullRequestOperationUndo(deps: GraphPullRequestActionDeps, message: string,
  target: PullRequestUndoTarget, failed = false): Promise<void> {
  const undo = vscode.l10n.t("Undo PR Operation");
  await presentActionNotice(deps.notices,
    () => failed ? vscode.window.showErrorMessage(message, undo) : vscode.window.showInformationMessage(message, undo),
    async selected => {
      if (selected !== undo) return;
      if (deps.notices) await deps.notices.run(refreshGraph => undoPullRequestOperation({ ...deps, refreshGraph }, target.branch, target));
      else await undoPullRequestOperation(deps, target.branch, target);
    });
}

/** 오류 시 한 번 준비한 유효 계획을 알림에 고정하며 같은 브랜치의 중복 사전 검사를 피한다. */
export async function offerFailedPullRequestUndo(deps: GraphPullRequestActionDeps, message: string,
  branch?: string): Promise<void> {
  const service = new PullRequestOperationService(deps.logService.repoRoot);
  let plan = await prepareIfAvailable(service, branch);
  if (!plan && branch) plan = await prepareIfAvailable(service);
  if (plan) await offerPullRequestOperationUndo(deps, message, {
    id: plan.id, branch: plan.branch, snapshotRef: plan.snapshotRef,
    beforeHead: plan.restoredHead, afterHead: plan.expectedHead,
  }, true);
  else await presentActionNotice(deps.notices, () => vscode.window.showErrorMessage(message));
}

/**
 * 선택 순간의 작업 상태를 다시 읽고, 알림이 가리킨 작업과 같을 때만 확인창과 Native Undo로 진행한다.
 * @param deps 원래 저장소와 새로고침 @param branchName 명시적 메뉴의 선택 브랜치
 * @param target 알림의 원래 작업 식별자. 생략한 명시적 Undo 명령은 현재 유효 작업을 준비한다.
 */
export async function undoPullRequestOperation(deps: GraphPullRequestActionDeps, branchName?: string,
  target?: PullRequestUndoTarget): Promise<void> {
  const service = new PullRequestOperationService(deps.logService.repoRoot);
  const plan = await prepareIfAvailable(service, branchName);
  if (deps.notices?.signal.aborted) return;
  if (!plan || (target && (plan.branch !== target.branch || plan.snapshotRef !== target.snapshotRef ||
    plan.restoredHead !== target.beforeHead || plan.expectedHead !== target.afterHead || (target.id && plan.id !== target.id)))) {
    logInfo("PR operation undo unavailable for notification/worktree state", { repoRoot: deps.logService.repoRoot, branchName, staleNotice: !!target });
    vscode.window.showWarningMessage(target
      ? vscode.l10n.t("This PR operation is no longer the current saved operation. Undo was stopped; your changes were preserved.")
      : branchName ? vscode.l10n.t("No PR operation snapshot is available for '{0}'.", branchName)
        : vscode.l10n.t("No PR operation snapshot is available for the current branch."));
    return;
  }
  const undo = vscode.l10n.t("Undo PR Operation");
  if (await vscode.window.showWarningMessage(vscode.l10n.t(
    "Undo the last PR operation on '{0}'? The branch will reset to the saved snapshot.", plan.branch), { modal: true }, undo) !== undo) return;
  // 확인창 동안 외부 Git이 바뀌어도 서비스는 동일 plan을 다시 검증하고 CAS로 실행한다.
  if (deps.notices?.signal.aborted) return;
  logInfo("pr operation undo started", { repoRoot: deps.logService.repoRoot, branch: plan.branch });
  const result = await service.undoLastOperation(plan.branch, plan);
  logInfo("pr operation undo finished", { repoRoot: deps.logService.repoRoot, branch: result.branch, restoredHead: result.restoredHead.slice(0, 10) });
  await deps.refreshGraph();
  vscode.window.showInformationMessage(vscode.l10n.t("PR operation undone on '{0}'.", result.branch));
}

/** 이전 hasUndoSnapshot과 동일하게 읽기 실패는 사용 불가로 처리하고 상세 검사 자체는 한 번만 실행한다. */
async function prepareIfAvailable(service: PullRequestOperationService, branch?: string): Promise<OperationUndoPlan | undefined> {
  try { return await service.prepareUndo(branch); } catch { return undefined; }
}
