// 그래프 제어도 일반 Conflicts 명령과 같은 PR/branch/stack 복원 후처리를 거치게 한다.
import * as vscode from "vscode";
import { finishRebaseAfterContinue, restoreRebaseAfterAbort } from "../commands/rebaseConflictFollowup";
import { readRebaseControlState } from "./graphRebaseControlState";
import { refreshAfterRebaseControl } from "./graphRebaseUtils";
import type { GraphRebaseControlResult, GraphRebaseDeps } from "./graphRebaseActions";

/**
 * native 제어와 별도로 pending/stash/다음 stack layer를 마무리한 뒤 완료 여부를 판단한다.
 * @param deps 그래프 저장소와 새로고침 의존성
 * @param action Continue/Skip의 후처리는 continue로 공유한다.
 * @param nativeRan 이미 끝난 작업의 후처리만 재시도하는 경우 false
 * @returns 복원 실패를 성공으로 바꾸지 않는 최종 그래프 상태
 */
export async function finishGraphRebaseControl(
  deps: Pick<GraphRebaseDeps, "logService" | "refreshGraph">,
  action: "continue" | "abort",
  nativeRan = true
): Promise<GraphRebaseControlResult> {
  const repoRoot = deps.logService.repoRoot;
  const controller = { refresh: async () => { await vscode.commands.executeCommand("gitSimpleCompare.refreshConflicts"); } };
  const followup = action === "abort"
    ? await restoreRebaseAfterAbort(repoRoot)
    : await finishRebaseAfterContinue(controller, repoRoot);
  if (followup === "failed") {
    refreshAfterRebaseControl(deps, "graphRebaseRecoveryFailed");
    return { status: "failed", message: vscode.l10n.t("Git finished, but recovery is incomplete. Check the error and retry after resolving it. Recovery snapshots were kept.") };
  }
  const state = await readRebaseControlState(deps, "");
  if (state.status !== "completed") return state;
  // 다음 stack layer가 다른 worktree에서 멈추면 현재 저장소만 보고 전체 완료로 표시하지 않는다.
  if (followup === "conflicts" || followup === "pending") {
    return { status: "conflicts", message: vscode.l10n.t("The operation is still paused. Resolve the remaining work in the Conflicts view, then continue there.") };
  }
  const aborted = action === "abort" && (nativeRan || followup === "completed");
  if (followup === "none" && nativeRan) {
    vscode.window.showInformationMessage(vscode.l10n.t(aborted ? "Rebase aborted." : "Rebase completed."));
  }
  return { status: aborted ? "aborted" : "completed" };
}
