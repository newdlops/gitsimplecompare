// git graph 의 브랜치 단위 squash/rebase merge UI 실행 흐름을 담당한다.
// - graphActions.ts 는 메시지 라우팅만 맡고, 확인/진행 표시/결과 안내는 이 파일로 모은다.
import * as vscode from "vscode";
import { BranchOperationService, type BranchOperationResult } from "../git/branchOperationService";
import { GitLogService } from "../git/gitLogService";
import { logError, logInfo } from "../ui/outputLog";

export type BranchMergeActionKind = "squash" | "rebase" | "undo";

interface GraphBranchMergeActionDeps {
  logService: GitLogService;
  refreshGraph: () => Promise<void>;
}

/**
 * 브랜치 context menu/QuickPick 에서 선택한 merge 계열 action 을 처리한다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 * @param branch 작업 대상 source 브랜치
 * @param action 실행할 branch operation 종류
 */
export async function handleBranchMergeAction(
  deps: GraphBranchMergeActionDeps,
  branch: string,
  action: BranchMergeActionKind
): Promise<void> {
  if (action === "undo") {
    await undoBranchOperation(deps);
    return;
  }
  if (action === "squash") {
    await squashMergeBranch(deps, branch);
  } else {
    await rebaseMergeBranch(deps, branch);
  }
}

/**
 * source 브랜치를 현재 브랜치에 squash commit 하나로 병합한다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 * @param sourceBranch 병합할 로컬 브랜치 이름
 */
export async function squashMergeBranch(
  deps: GraphBranchMergeActionDeps,
  sourceBranch: string
): Promise<void> {
  if (!(await confirm(
    vscode.l10n.t("Squash merge branch '{0}' into the current branch?", sourceBranch),
    vscode.l10n.t("Squash Merge")
  ))) {
    return;
  }
  await runBranchOperation(deps, sourceBranch, "squash", () =>
    new BranchOperationService(deps.logService.repoRoot).squashMerge(sourceBranch)
  );
}

/**
 * source 브랜치의 커밋을 현재 브랜치 위에 보존 커밋 형태로 재적용한다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 * @param sourceBranch 재적용할 로컬 브랜치 이름
 */
export async function rebaseMergeBranch(
  deps: GraphBranchMergeActionDeps,
  sourceBranch: string
): Promise<void> {
  if (!(await confirm(
    vscode.l10n.t(
      "Rebase merge branch '{0}' into the current branch? Clean commits are applied first; conflict commits are shown last.",
      sourceBranch
    ),
    vscode.l10n.t("Rebase Merge")
  ))) {
    return;
  }
  await runBranchOperation(deps, sourceBranch, "rebase", () =>
    new BranchOperationService(deps.logService.repoRoot).rebaseMerge(sourceBranch)
  );
}

/**
 * 브랜치 작업을 실행하고 성공/실패 양쪽에서 undo 진입점을 제공한다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 * @param sourceBranch 작업 대상 source 브랜치
 * @param operation 실행할 branch operation 종류
 * @param run 실제 git 작업 함수
 */
async function runBranchOperation(
  deps: GraphBranchMergeActionDeps,
  sourceBranch: string,
  operation: "squash" | "rebase",
  run: () => Promise<BranchOperationResult>
): Promise<void> {
  try {
    logInfo("branch operation started", {
      repoRoot: deps.logService.repoRoot,
      operation,
      sourceBranch,
    });
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: operation === "squash"
          ? vscode.l10n.t("Squash merging branch '{0}'", sourceBranch)
          : vscode.l10n.t("Rebase merging branch '{0}'", sourceBranch),
        cancellable: false,
      },
      run
    );
    if (result.status === "conflicts") {
      await handleBranchOperationConflicts(deps, result, operation);
      return;
    }
    logInfo("branch operation finished", {
      repoRoot: deps.logService.repoRoot,
      operation,
      branch: result.branch,
      sourceBranch,
      beforeHead: shortHash(result.beforeHead),
      afterHead: shortHash(result.afterHead),
      snapshotRef: result.snapshotRef,
    });
    await deps.refreshGraph();
    await offerBranchOperationUndo(
      deps,
      operation === "squash"
        ? vscode.l10n.t("Branch '{0}' squash-merged into '{1}'.", sourceBranch, result.branch)
        : vscode.l10n.t("Branch '{0}' rebase-merged into '{1}'.", sourceBranch, result.branch)
    );
  } catch (err) {
    await handleBranchOperationError(deps, err, operation, sourceBranch);
  }
}

/**
 * 브랜치 작업이 충돌로 멈춘 경우 Conflicts 뷰를 갱신하고 사용자에게 다음 단계를 안내한다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 * @param result 충돌 대기 상태
 * @param operation 실행 중이던 branch operation 종류
 */
async function handleBranchOperationConflicts(
  deps: GraphBranchMergeActionDeps,
  result: BranchOperationResult,
  operation: "squash" | "rebase"
): Promise<void> {
  logInfo("branch operation paused for conflicts", {
    repoRoot: deps.logService.repoRoot,
    operation,
    branch: result.branch,
    sourceBranch: result.sourceBranch,
    beforeHead: shortHash(result.beforeHead),
    snapshotRef: result.snapshotRef,
    preservedStashHash: result.preservedStashHash,
  });
  await deps.refreshGraph();
  await vscode.commands.executeCommand("gitSimpleCompare.refreshConflicts");
  await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
  if (operation === "rebase") {
    vscode.window.showWarningMessage(
      result.preservedStashHash
        ? vscode.l10n.t(
            "Branch rebase merge paused with conflicts. Resolve them in the Conflicts view, then Continue. Local changes are preserved in stash {0}.",
            result.preservedStashHash
          )
        : vscode.l10n.t(
            "Branch rebase merge paused with conflicts. Resolve them in the Conflicts view, then Continue."
          )
    );
    return;
  }
  vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Branch squash merge paused with conflicts. Resolve them in the Conflicts view, then commit the squash result."
    )
  );
}

/**
 * 브랜치 작업 실패를 로깅하고 가능한 경우 undo 버튼을 제공한다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 * @param err catch 로 받은 오류
 * @param operation 실패한 branch operation 종류
 * @param sourceBranch 작업 대상 source 브랜치
 */
async function handleBranchOperationError(
  deps: GraphBranchMergeActionDeps,
  err: unknown,
  operation: "squash" | "rebase",
  sourceBranch: string
): Promise<void> {
  logError("branch operation failed", err, {
    repoRoot: deps.logService.repoRoot,
    operation,
    sourceBranch,
  });
  const undo = vscode.l10n.t("Undo Branch Operation");
  const service = new BranchOperationService(deps.logService.repoRoot);
  const canUndo = await service.hasUndoSnapshot();
  const message = vscode.l10n.t("Branch operation failed: {0}", errText(err));
  const pick = canUndo
    ? await vscode.window.showErrorMessage(message, undo)
    : await vscode.window.showErrorMessage(message);
  if (pick === undo) {
    await undoBranchOperation(deps);
  }
}

/**
 * 성공 안내에서 바로 undo 를 실행할 수 있게 action 버튼을 제공한다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 * @param message 사용자에게 보여줄 완료 메시지
 */
async function offerBranchOperationUndo(
  deps: GraphBranchMergeActionDeps,
  message: string
): Promise<void> {
  const undo = vscode.l10n.t("Undo Branch Operation");
  const pick = await vscode.window.showInformationMessage(message, undo);
  if (pick === undo) {
    await undoBranchOperation(deps);
  }
}

/**
 * 현재 브랜치에 저장된 branch operation snapshot 으로 reset 한다.
 * @param deps graph action 실행에 필요한 서비스와 새로고침 함수
 */
export async function undoBranchOperation(
  deps: GraphBranchMergeActionDeps
): Promise<void> {
  const service = new BranchOperationService(deps.logService.repoRoot);
  if (!await service.hasUndoSnapshot()) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("No branch operation snapshot is available for the current branch.")
    );
    return;
  }
  if (!(await confirm(
    vscode.l10n.t("Undo the last branch operation on the current branch? The branch will reset to the saved snapshot."),
    vscode.l10n.t("Undo Branch Operation")
  ))) {
    return;
  }
  logInfo("branch operation undo started", { repoRoot: deps.logService.repoRoot });
  const result = await service.undoLastOperation();
  logInfo("branch operation undo finished", {
    repoRoot: deps.logService.repoRoot,
    branch: result.branch,
    restoredHead: shortHash(result.restoredHead),
  });
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Branch operation undone on '{0}'.", result.branch)
  );
}

/**
 * 확인이 필요한 branch operation 을 모달로 확인한다.
 * @param message 사용자에게 보여줄 확인 문구
 * @param label 확인 버튼 라벨
 * @returns 사용자가 확인 버튼을 눌렀으면 true
 */
async function confirm(message: string, label: string): Promise<boolean> {
  return (
    (await vscode.window.showWarningMessage(message, { modal: true }, label)) ===
    label
  );
}

/**
 * 긴 커밋 해시를 UI 표시용으로 줄인다.
 * @param hash 전체 commit hash
 * @returns 앞 10자리 commit hash
 */
function shortHash(hash: string): string {
  return hash.slice(0, 10);
}

/**
 * 오류 메시지를 사용자에게 보여줄 짧은 문자열로 만든다.
 * @param err catch 로 받은 알 수 없는 오류 값
 * @returns 사용자 표시용 문자열
 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
