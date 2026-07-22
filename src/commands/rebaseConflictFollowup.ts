// rebase 계열 충돌 Continue/Abort 후속 처리를 담당하는 command helper.
// - conflicts.ts 는 공통 충돌 명령 흐름만 유지하고, PR/branch/deferred rebase 상태 복원은 이 파일로 모은다.
import * as vscode from "vscode";
import { ConflictService } from "../git/conflictService";
import {
  continuePendingDeferredCommitRebase,
  dropPendingDeferredCommitRebaseStashAfterResolvedRestore,
  restorePendingDeferredCommitRebaseAfterAbort,
} from "../git/deferredCommitRebase";
import {
  dropPendingBranchRebaseMergeStashAfterResolvedRestore,
  finishPendingBranchRebaseMergeAfterContinue,
  restorePendingBranchRebaseMergeAfterAbort,
} from "../git/branchRebaseMerge";
import {
  dropPendingPullRequestStashAfterResolvedRestore,
  finishPendingPullRequestRebaseAfterContinue,
  restorePendingPullRequestRebaseAfterAbort,
} from "../git/pullRequestRebaseContinuation";
import { PullRequestStackRestackService } from "../git/pullRequestStackRestack";
import { RebaseService } from "../git/rebaseService";
import { readRebaseTodoProgress, type RebaseTodoProgress } from "../git/rebaseTodoProgress";
import { ConflictsController } from "../providers/conflictsController";
import { logInfo } from "../ui/outputLog";
import { GitGraphPanel } from "../webview/graphPanel";
import { graphRebaseTodoProgressMessage } from "../webview/graphRebaseTodoProgress";

/**
 * `git rebase --continue` 가 다음 충돌에서 멈춘 경우 오류 대신 그래프 TODO 카드를 갱신한다.
 * @param repoRoot 대상 저장소 루트
 * @returns 표시할 rebase todo 가 있으면 true
 */
export async function publishRebaseContinueConflict(
  repoRoot: string
): Promise<boolean> {
  return publishRebaseTodoProgress(
    repoRoot,
    "continue",
    vscode.l10n.t("Rebase paused at todo"),
    vscode.l10n.t("Resolve the current todo, then Continue, Skip, or Abort. Remaining todo items stay visible here.")
  );
}

/**
 * 일반 Continue 명령 이후 실제 rebase 상태를 그래프 rebase UI 에 동기화한다.
 * - 그래프 전용 Continue 가 아닌 경로로 rebase 가 끝나도 남은 todo UI 가 stale 로 보이지 않게 clear 한다.
 * - 다음 edit/conflict 에서 멈춘 경우에는 progress 카드와 강조 위치를 최신 상태로 갱신한다.
 * @param repoRoot 대상 저장소 루트
 */
export async function publishRebaseContinueState(
  repoRoot: string
): Promise<void> {
  const rebase = new RebaseService(repoRoot);
  const paused = await rebase.getPausedEditState();
  if (paused) {
    const progress = await readRebaseTodoProgress(repoRoot).catch(() => undefined);
    GitGraphPanel.postOpen(repoRoot, graphRebaseTodoProgressMessage({
      action: "continue",
      phase: "paused",
      title: vscode.l10n.t("Rebase paused at edit commit"),
      detail: vscode.l10n.t("Edit files for this commit, then Continue."),
      progress,
      active: true,
    }));
    GitGraphPanel.postOpen(repoRoot, { type: "graphRebasePaused", paused });
    logInfo("conflicts rebase continue graph state paused", {
      repoRoot,
      paused: paused.hash,
      original: paused.originalHash,
      progress: Boolean(progress),
    });
    return;
  }
  const conflicts = new ConflictService(repoRoot);
  const [operation, conflictFiles] = await Promise.all([
    conflicts.getOperation().catch(() => "none"),
    conflicts.listConflicts().catch(() => []),
  ]);
  if (operation === "rebase" && conflictFiles.length === 0) {
    const progress = await readRebaseTodoProgress(repoRoot).catch(() => undefined);
    GitGraphPanel.postOpen(repoRoot, graphRebaseTodoProgressMessage({
      action: "continue",
      phase: "paused",
      title: vscode.l10n.t("Rebase paused at todo"),
      detail: vscode.l10n.t("Resolve the current Git rebase step, then Continue, Skip, or Abort."),
      progress,
      active: true,
    }));
    GitGraphPanel.postOpen(repoRoot, { type: "graphRebaseOperation", active: true });
    logInfo("conflicts rebase continue graph state stopped", {
      repoRoot,
      progress: Boolean(progress),
    });
    return;
  }
  if (operation === "rebase" || conflictFiles.length > 0) {
    await publishRebaseContinueConflict(repoRoot);
    GitGraphPanel.postOpen(repoRoot, { type: "graphRebaseOperation", active: true });
    logInfo("conflicts rebase continue graph state active", {
      repoRoot,
      operation,
      conflicts: conflictFiles.length,
    });
    return;
  }
  GitGraphPanel.postOpen(repoRoot, { type: "graphRebaseClear" });
  logInfo("conflicts rebase continue graph state completed", { repoRoot });
}

/**
 * PR/branch rebase 충돌이 continue 로 해결된 뒤 목적 브랜치 반영과 stash 복원을 마무리한다.
 * @param controller 충돌 컨트롤러
 * @param repoRoot   대상 저장소 루트
 */
export async function finishRebaseAfterContinue(
  controller: ConflictsController,
  repoRoot: string
): Promise<void> {
  if (await finishPullRequestStackRestackAfterContinue(controller, repoRoot)) {
    return;
  }
  if (await finishPullRequestRebaseAfterContinue(controller, repoRoot)) {
    return;
  }
  await finishBranchRebaseMergeAfterContinue(controller, repoRoot);
}

/**
 * rebase abort 뒤 PR/branch pending 상태를 복원한다.
 * @param repoRoot 대상 저장소 루트
 */
export async function restoreRebaseAfterAbort(repoRoot: string): Promise<void> {
  if (await restorePullRequestStackRestackAfterAbort(repoRoot)) {
    return;
  }
  if (await restorePullRequestRebaseAfterAbort(repoRoot)) {
    return;
  }
  await restoreBranchRebaseMergeAfterAbort(repoRoot);
}

/**
 * stack layer rebase 충돌이 Continue/Skip으로 끝난 뒤 다음 layer를 자동 실행한다.
 * @param controller 새 충돌 worktree를 Conflicts view에 다시 연결할 컨트롤러
 * @param repoRoot 방금 rebase를 끝낸 linked worktree 또는 저장소 루트
 * @returns stack pending을 처리했으면 true
 */
async function finishPullRequestStackRestackAfterContinue(
  controller: ConflictsController,
  repoRoot: string
): Promise<boolean> {
  let result: Awaited<ReturnType<PullRequestStackRestackService["resumeAfterContinue"]>>;
  try {
    result = await new PullRequestStackRestackService(repoRoot).resumeAfterContinue();
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Could not continue pull request stack restack: {0}", errorText(err))
    );
    return true;
  }
  if (result.status === "none") {
    return false;
  }
  if (result.status === "conflicts") {
    if (result.conflictFiles[0]) {
      await vscode.commands.executeCommand("gitSimpleCompare.openConflictEditor", {
        root: result.worktreePath,
        path: result.conflictFiles[0],
      });
    }
    await controller.refresh();
    await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Stack restack continued to '{0}' and paused at the next conflict. Resolve it, then Continue or Abort.",
        result.branch
      )
    );
    return true;
  }
  await controller.refresh();
  GitGraphPanel.refreshOpen(result.repoRoot, "stackRestackContinue");
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "stackRestackContinue",
  });
  vscode.window.showInformationMessage(
    vscode.l10n.t("Pull request stack restack completed for {0} rewritten layer(s).", result.rewrittenBranches.length)
  );
  if (result.postAction) {
    await vscode.commands.executeCommand("gitSimpleCompare.completePullRequestStackAdvance", {
      repoRoot: result.repoRoot,
      postAction: result.postAction,
    });
  }
  return true;
}

/**
 * stack restack rebase Abort 뒤 이미 끝난 layer와 parent 메타데이터까지 backup으로 복원한다.
 * @param repoRoot abort가 수행된 linked worktree 또는 저장소 루트
 * @returns stack pending을 처리했으면 true
 */
async function restorePullRequestStackRestackAfterAbort(
  repoRoot: string
): Promise<boolean> {
  try {
    const graphRepoRoot = await new PullRequestStackRestackService(repoRoot).restoreAfterAbort();
    if (!graphRepoRoot) {
      return false;
    }
    GitGraphPanel.refreshOpen(graphRepoRoot, "stackRestackAbort");
    void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason: "stackRestackAbort",
    });
    vscode.window.showInformationMessage(
      vscode.l10n.t("Pull request stack restack was aborted and completed layers were restored from safety refs.")
    );
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Stack restack was aborted, but some layers could not be restored: {0}", errorText(err))
    );
    return true;
  }
}

/**
 * rebase 계열 stash 복원 충돌이 해결된 뒤 보존 stash 를 정리한다.
 * @param controller 충돌 컨트롤러
 */
export async function dropRebaseStashesAfterResolvedRestore(
  controller: ConflictsController
): Promise<void> {
  await dropPullRequestStashAfterResolvedRestore(controller);
  await dropBranchRebaseMergeStashAfterResolvedRestore(controller);
  await dropDeferredCommitRebaseStashAfterResolvedRestore(controller);
}

/**
 * deferred rebase merge 의 현재 cherry-pick/revert 충돌이 해결된 뒤 남은 큐를 이어서 적용한다.
 * @param controller 충돌 컨트롤러
 * @param repoRoot   대상 저장소 루트
 */
export async function finishDeferredCommitRebaseAfterContinue(
  controller: ConflictsController,
  repoRoot: string
): Promise<void> {
  let result: Awaited<ReturnType<typeof continuePendingDeferredCommitRebase>>;
  try {
    result = await continuePendingDeferredCommitRebase(repoRoot);
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Could not finish rebase merge: {0}", errorText(err))
    );
    return;
  }
  if (result.status === "none" || result.status === "pending") {
    return;
  }
  if (result.status === "completed") {
    const label = deferredOperationLabel(result.operation);
    vscode.window.showInformationMessage(
      result.restoredLocalChanges
        ? vscode.l10n.t("{0} completed and local changes were restored on '{1}'.", label, result.branch)
        : vscode.l10n.t("{0} completed on '{1}'.", label, result.branch)
    );
  } else if (result.status === "conflicts") {
    const label = deferredOperationLabel(result.operation);
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "{0} paused at the next conflict commit. Resolve conflicts, then Continue, Skip, or Abort.",
        label
      )
    );
    await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
  } else if (result.status === "restoreConflicts") {
    const label = deferredOperationLabel(result.operation);
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "{0} completed, but restoring preserved local changes caused conflicts.",
        label
      )
    );
    await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
  }
  await controller.refresh();
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "deferredRebaseContinue",
  });
}

/**
 * deferred rebase merge abort 뒤 시작 브랜치와 보존 stash 를 복원한다.
 * @param repoRoot 대상 저장소 루트
 */
export async function restoreDeferredCommitRebaseAfterAbort(repoRoot: string): Promise<void> {
  let result: Awaited<ReturnType<typeof restorePendingDeferredCommitRebaseAfterAbort>>;
  try {
    result = await restorePendingDeferredCommitRebaseAfterAbort(repoRoot);
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Rebase merge was aborted, but local changes could not be restored: {0}", errorText(err))
    );
    return;
  }
  if (result.status !== "restored") {
    return;
  }
  const label = deferredOperationLabel(result.operation);
  vscode.window.showInformationMessage(
    vscode.l10n.t("{0} aborted and local changes were restored on '{1}'.", label, result.branch)
  );
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "deferredRebaseAbort",
  });
}

/** PR rebase 충돌이 continue 로 해결된 뒤 목적 브랜치 반영과 stash 복원을 마무리한다. */
async function finishPullRequestRebaseAfterContinue(
  controller: ConflictsController,
  repoRoot: string
): Promise<boolean> {
  let result: Awaited<ReturnType<typeof finishPendingPullRequestRebaseAfterContinue>>;
  try {
    result = await finishPendingPullRequestRebaseAfterContinue(repoRoot);
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Could not finish PR rebase: {0}", errorText(err))
    );
    return true;
  }
  if (result.status === "none" || result.status === "pending") {
    if (result.status === "pending") {
      await publishRebaseTodoProgress(
        repoRoot,
        "continue",
        vscode.l10n.t("PR rebase paused at todo"),
        vscode.l10n.t("Resolve the current todo, then Continue, Skip, or Abort. Remaining todo items stay visible here.")
      );
    }
    return result.status !== "none";
  }
  if (result.status === "completed") {
    vscode.window.showInformationMessage(
      result.restoredLocalChanges
        ? vscode.l10n.t("PR rebase completed and local changes were restored on '{0}'.", result.branch)
        : vscode.l10n.t("PR rebase completed on '{0}'.", result.branch)
    );
  } else if (result.status === "restoreConflicts") {
    vscode.window.showWarningMessage(
      vscode.l10n.t("PR rebase completed, but restoring preserved local changes caused conflicts.")
    );
    await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
  }
  await controller.refresh();
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "prRebaseContinue",
  });
  return true;
}

/** 브랜치 rebase merge 충돌이 continue 로 해결된 뒤 목적 브랜치 반영과 stash 복원을 마무리한다. */
async function finishBranchRebaseMergeAfterContinue(
  controller: ConflictsController,
  repoRoot: string
): Promise<boolean> {
  let result: Awaited<ReturnType<typeof finishPendingBranchRebaseMergeAfterContinue>>;
  try {
    result = await finishPendingBranchRebaseMergeAfterContinue(repoRoot);
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Could not finish branch rebase merge: {0}", errorText(err))
    );
    return true;
  }
  if (result.status === "none") {
    return false;
  }
  if (result.status === "pending") {
    await publishRebaseTodoProgress(
      repoRoot,
      "continue",
      vscode.l10n.t("Branch rebase merge paused"),
      vscode.l10n.t("Resolve the current todo, then Continue, Skip, or Abort. Remaining todo items stay visible here."),
      result.rebaseTodo
    );
    return true;
  }
  if (result.status === "completed") {
    vscode.window.showInformationMessage(
      result.restoredLocalChanges
        ? vscode.l10n.t("Branch rebase merge completed and local changes were restored on '{0}'.", result.branch)
        : vscode.l10n.t("Branch rebase merge completed on '{0}'.", result.branch)
    );
    GitGraphPanel.postOpen(repoRoot, graphRebaseTodoProgressMessage({
      action: "continue",
      phase: "completed",
      title: vscode.l10n.t("Branch rebase merge completed"),
      detail: vscode.l10n.t("Current branch '{0}' was rebased.", result.branch),
      active: false,
    }));
  } else if (result.status === "restoreConflicts") {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Branch rebase merge completed, but restoring preserved local changes caused conflicts.")
    );
    await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
  }
  await controller.refresh();
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "branchRebaseMergeContinue",
  });
  return true;
}

/** PR rebase abort 뒤 시작 브랜치와 보존 stash 를 복원한다. */
async function restorePullRequestRebaseAfterAbort(repoRoot: string): Promise<boolean> {
  let result: Awaited<ReturnType<typeof restorePendingPullRequestRebaseAfterAbort>>;
  try {
    result = await restorePendingPullRequestRebaseAfterAbort(repoRoot);
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("PR rebase was aborted, but local changes could not be restored: {0}", errorText(err))
    );
    return true;
  }
  if (result.status !== "restored") {
    return false;
  }
  vscode.window.showInformationMessage(
    vscode.l10n.t("PR rebase aborted and local changes were restored on '{0}'.", result.branch)
  );
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "prRebaseAbort",
  });
  return true;
}

/** 브랜치 rebase merge abort 뒤 시작 브랜치와 보존 stash 를 복원한다. */
async function restoreBranchRebaseMergeAfterAbort(repoRoot: string): Promise<boolean> {
  let result: Awaited<ReturnType<typeof restorePendingBranchRebaseMergeAfterAbort>>;
  try {
    result = await restorePendingBranchRebaseMergeAfterAbort(repoRoot);
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Branch rebase merge was aborted, but local changes could not be restored: {0}", errorText(err))
    );
    return true;
  }
  if (result.status !== "restored") {
    return false;
  }
  vscode.window.showInformationMessage(
    vscode.l10n.t("Branch rebase merge aborted and local changes were restored on '{0}'.", result.branch)
  );
  GitGraphPanel.postOpen(repoRoot, graphRebaseTodoProgressMessage({
    action: "abort",
    phase: "aborted",
    title: vscode.l10n.t("Branch rebase merge aborted"),
    detail: vscode.l10n.t("The destination branch was restored."),
    active: false,
  }));
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "branchRebaseMergeAbort",
  });
  return true;
}

/** PR stash 복원 충돌이 해결된 뒤 이미 적용된 stash 를 제거한다. */
async function dropPullRequestStashAfterResolvedRestore(
  controller: ConflictsController
): Promise<void> {
  const svc = controller.current;
  if (!svc) {
    return;
  }
  const result = await dropPendingPullRequestStashAfterResolvedRestore(svc.repoRoot);
  if (result.status !== "dropped") {
    return;
  }
  vscode.window.showInformationMessage(
    vscode.l10n.t("PR preserved stash cleaned on '{0}'.", result.branch)
  );
  await controller.refresh();
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "prStashCleanup",
  });
}

/** 브랜치 rebase merge 의 stash 복원 충돌이 해결된 뒤 이미 적용된 stash 를 제거한다. */
async function dropBranchRebaseMergeStashAfterResolvedRestore(
  controller: ConflictsController
): Promise<void> {
  const svc = controller.current;
  if (!svc) {
    return;
  }
  const result = await dropPendingBranchRebaseMergeStashAfterResolvedRestore(svc.repoRoot);
  if (result.status !== "dropped") {
    return;
  }
  vscode.window.showInformationMessage(
    vscode.l10n.t("Branch rebase merge preserved stash cleaned on '{0}'.", result.branch)
  );
  await controller.refresh();
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "branchRebaseMergeStashCleanup",
  });
}

/** deferred rebase merge 의 stash 복원 충돌이 해결된 뒤 이미 적용된 stash 를 제거한다. */
async function dropDeferredCommitRebaseStashAfterResolvedRestore(
  controller: ConflictsController
): Promise<void> {
  const svc = controller.current;
  if (!svc) {
    return;
  }
  const result = await dropPendingDeferredCommitRebaseStashAfterResolvedRestore(svc.repoRoot);
  if (result.status !== "dropped") {
    return;
  }
  const label = deferredOperationLabel(result.operation);
  vscode.window.showInformationMessage(
    vscode.l10n.t("{0} preserved stash cleaned on '{1}'.", label, result.branch)
  );
  await controller.refresh();
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "deferredRebaseStashCleanup",
  });
}

/** 진행 중인 rebase todo 를 읽어 그래프 패널의 카드형 progress 에 표시한다. */
async function publishRebaseTodoProgress(
  repoRoot: string,
  action: "run" | "continue" | "skip" | "abort",
  title: string,
  detail: string,
  progress?: RebaseTodoProgress
): Promise<boolean> {
  const current = progress ?? await readRebaseTodoProgress(repoRoot).catch(() => undefined);
  if (!current) {
    return false;
  }
  GitGraphPanel.postOpen(repoRoot, graphRebaseTodoProgressMessage({
    action,
    phase: "conflicts",
    title,
    detail,
    progress: current,
    active: true,
  }));
  return true;
}

/** deferred queue 작업 종류를 사용자 안내 문구로 변환한다. */
function deferredOperationLabel(operation: "cherry-pick" | "revert"): string {
  return operation === "revert"
    ? vscode.l10n.t("Rebase revert")
    : vscode.l10n.t("Rebase merge");
}

/** 오류 객체에서 사람이 읽을 메시지를 뽑는다. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
