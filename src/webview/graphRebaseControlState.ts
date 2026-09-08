// 진행 중인 rebase 상태를 UI 결과로 변환하고 edit 문서의 표시/저장을 담당한다.
import * as vscode from "vscode";
import { ConflictService } from "../git/conflictService";
import { RebaseService, type RebasePausedState } from "../git/rebaseService";
import { createRebaseEditTempFile } from "../git/rebaseEditSession";
import { EMPTY_TREE } from "../git/gitLogService";
import { readRebaseContinueDiagnostics, type RebaseContinueDiagnostics } from "../git/rebaseContinueDiagnostics";
import { REBASE_RESTORE_CONFLICT_MESSAGE } from "../git/rebasePlanSafety";
import { openRefVsWorkingDiff } from "../ui/diffPresenter";
import { logInfo } from "../ui/outputLog";
import { focusRebaseConflicts } from "./graphRebaseConflictFocus";
import { rebaseDiagnosticDetail, rebaseDiagnosticGuidance, rebaseDiagnosticLogDetail } from "./graphRebaseDiagnostics";
import { rebaseProgressLogDetail } from "./graphRebaseProgressLog";
import { refreshAfterRebaseControl } from "./graphRebaseUtils";
import type { GraphRebaseDeps, GraphRebaseControlResult } from "./graphRebaseActions";

/** continue 뒤 rebase 의 다음 상태를 읽고 필요한 UI 전환을 수행한다. */
export async function readRebaseControlState(
  deps: Pick<GraphRebaseDeps, "logService" | "refreshGraph">,
  completedMessage: string,
  knownDiagnostics?: RebaseContinueDiagnostics
): Promise<GraphRebaseControlResult> {
  const repoRoot = deps.logService.repoRoot;
  const rebase = new RebaseService(repoRoot);
  const paused = await rebase.getPausedEditState();
  if (paused) {
    logInfo("graph rebase continue paused again", {
      repoRoot,
      paused: paused.hash,
      original: paused.originalHash,
      files: paused.files.length,
      ...(await rebaseProgressLogDetail(repoRoot)),
    });
    refreshAfterRebaseControl(deps, "graphRebaseEditPaused");
    await openPausedEditFile(repoRoot, paused);
    return { status: "paused", paused };
  }
  const conflictService = new ConflictService(repoRoot);
  const [conflicts, operation] = await Promise.all([
    conflictService.listConflicts(), conflictService.getOperation(),
  ]);
  const diagnostics = knownDiagnostics ??
    (operation === "rebase" && !conflicts.length
      ? await readRebaseContinueDiagnostics(repoRoot).catch(() => undefined) : undefined);
  const diagnosticDetail = rebaseDiagnosticDetail(diagnostics);
  const diagnosticGuidance = rebaseDiagnosticGuidance(diagnostics);
  if (conflicts.length > 0) {
    const restoringLocalChanges = operation === "none";
    const stopped = await rebase.getStoppedState();
    logInfo("graph rebase continue stopped with conflicts", {
      repoRoot,
      conflicts: conflicts.length,
      stopped: stopped?.hash,
      original: stopped?.originalHash,
      ...(await rebaseProgressLogDetail(repoRoot)),
      ...rebaseDiagnosticLogDetail(diagnostics),
    });
    refreshAfterRebaseControl(deps, "graphRebaseConflict");
    await focusRebaseConflicts(repoRoot, { files: conflicts, diagnostics });
    return {
      status: "conflicts",
      restoringLocalChanges,
      stopped,
      message: restoringLocalChanges ? REBASE_RESTORE_CONFLICT_MESSAGE : diagnosticDetail,
      guidance: diagnosticGuidance,
    };
  }
  if (operation === "rebase") {
    const stopped = await rebase.getStoppedState();
    logInfo("graph rebase continue stopped at todo", {
      repoRoot,
      stopped: stopped?.hash,
      original: stopped?.originalHash,
      ...(await rebaseProgressLogDetail(repoRoot)),
      ...rebaseDiagnosticLogDetail(diagnostics),
    });
    refreshAfterRebaseControl(deps, "graphRebaseStopped");
    vscode.window.showWarningMessage(
      diagnosticDetail ||
        vscode.l10n.t("Rebase paused at a todo item. Check the current todo card, then Continue, Skip, or Abort.")
    );
    return {
      status: "stopped",
      stopped,
      message: diagnosticDetail,
      guidance: diagnosticGuidance,
    };
  }
  logInfo("graph rebase continue completed", {
    repoRoot,
    operation,
    ...(await rebaseProgressLogDetail(repoRoot)),
  });
  refreshAfterRebaseControl(deps, "graphRebaseCompleted");
  if (completedMessage) {
    vscode.window.showInformationMessage(vscode.l10n.t(completedMessage));
  }
  return { status: "completed" };
}

/** edit 정지 지점에서 첫 편집 가능 파일 또는 사용자가 고른 파일을 editable diff 로 연다. */
export async function openPausedEditFile(
  repoRoot: string,
  paused: RebasePausedState,
  requestedPath?: string
): Promise<void> {
  const file = requestedPath
    ? paused.files.find((entry) => entry.path === requestedPath)
    : paused.files.find((entry) => !entry.status.startsWith("D"));
  if (!file) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("No editable file is available for this paused commit.")
    );
    return;
  }
  if (file.status.startsWith("D")) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Deleted files cannot be opened as editable working-tree diffs.")
    );
    return;
  }
  const base = paused.parent || EMPTY_TREE;
  const editFile = await createRebaseEditTempFile(repoRoot, paused, file);
  await openRefVsWorkingDiff(
    repoRoot,
    base,
    vscode.Uri.file(editFile.tempPath),
    file.path,
    {
      fileLabel: file.path.slice(file.path.lastIndexOf("/") + 1),
      leftRelPath: editFile.leftRelPath,
      rightLabel: vscode.l10n.t("Rebase Edit"),
    }
  );
  logInfo("graph rebase edit file opened", {
    repoRoot,
    path: file.path,
    tempPath: editFile.tempPath,
    paused: paused.hash,
    original: paused.originalHash,
  });
}
