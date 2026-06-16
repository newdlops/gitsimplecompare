// PR operation 중 보존된 임시 worktree 를 명령 팔레트에서 정리한다.
import * as vscode from "vscode";
import { cleanupPrOperationWorktrees, listPrOperationWorktrees } from "../git/temporaryWorktree";
import { CommandDeps, resolveWorkspaceService } from "./shared";

/** 현재 저장소에 남아 있는 PR operation 임시 worktree 를 제거한다. */
export async function cleanupPullRequestOperationWorktrees(
  deps: CommandDeps
): Promise<void> {
  const service = await resolveWorkspaceService(deps.registry);
  if (!service) {
    return;
  }
  const worktrees = await listPrOperationWorktrees(service.repoRoot);
  if (!worktrees.length) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("No PR operation temporary worktrees found.")
    );
    return;
  }
  const preview = worktrees.slice(0, 5).map((item) => item.path).join("\n");
  const suffix = worktrees.length > 5 ? `\n... +${worktrees.length - 5}` : "";
  const confirm = vscode.l10n.t("Delete Temporary Worktrees");
  const pick = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Delete {0} PR operation temporary worktree(s)?\n{1}{2}",
      worktrees.length,
      preview,
      suffix
    ),
    { modal: true },
    confirm
  );
  if (pick !== confirm) {
    return;
  }
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Deleting PR operation temporary worktrees"),
      cancellable: false,
    },
    () => cleanupPrOperationWorktrees(service.repoRoot)
  );
  if (result.failed.length) {
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Deleted {0} PR operation temporary worktree(s), but {1} failed. First failure: {2}",
        result.removed.length,
        result.failed.length,
        result.failed[0]?.message ?? ""
      )
    );
    return;
  }
  vscode.window.showInformationMessage(
    vscode.l10n.t("Deleted {0} PR operation temporary worktree(s).", result.removed.length)
  );
}
