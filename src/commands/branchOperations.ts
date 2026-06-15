// 브랜치 단위 squash merge / rebase merge 명령 모듈.
// - 명령 팔레트와 Changes view 메뉴에서 직접 실행할 수 있도록 저장소/브랜치 선택 UI 를 제공한다.
// - 실제 git 상태 변경은 BranchOperationService 에 위임해 graph 웹뷰 액션과 같은 구현을 재사용한다.
// - remote-only 브랜치는 실행 직전에 로컬 브랜치를 만든 뒤 같은 branch operation 경로로 처리한다.
import * as vscode from "vscode";
import { materializeBranchSource } from "../git/branchMaterialize";
import {
  BranchOperationService,
  type BranchOperationResult,
} from "../git/branchOperationService";
import type { BranchInfo } from "../git/gitTypes";
import { logError, logInfo } from "../ui/outputLog";
import { CommandDeps, resolveCompareService } from "./shared";

type BranchOperationKind = "squash" | "rebase";

/**
 * 현재 브랜치로 source 브랜치를 squash commit 하나로 병합한다.
 * - source 브랜치는 로컬 브랜치 목록에서 사용자가 고른다.
 * @param deps 명령들이 공유하는 의존성
 */
export async function branchSquashMerge(deps: CommandDeps): Promise<void> {
  const picked = await pickSourceBranch(deps, "squash");
  if (!picked) {
    return;
  }
  await runBranchOperation(picked, "squash");
}

/**
 * 현재 브랜치 위에 source 브랜치의 커밋을 보존 커밋 형태로 재적용한다.
 * - 충돌 없는 커밋을 먼저 적용하고, 충돌 커밋은 마지막에 Conflicts 뷰로 노출한다.
 * @param deps 명령들이 공유하는 의존성
 */
export async function branchRebaseMerge(deps: CommandDeps): Promise<void> {
  const picked = await pickSourceBranch(deps, "rebase");
  if (!picked) {
    return;
  }
  await runBranchOperation(picked, "rebase");
}

/**
 * 현재 브랜치의 마지막 branch operation 을 undo snapshot 으로 되돌린다.
 * @param deps 명령들이 공유하는 의존성
 */
export async function undoBranchOperation(deps: CommandDeps): Promise<void> {
  const service = await resolveCompareService(deps);
  if (!service) {
    return;
  }
  const branchService = new BranchOperationService(service.repoRoot);
  if (!await branchService.hasUndoSnapshot()) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("No branch operation snapshot is available for the current branch.")
    );
    return;
  }
  const label = vscode.l10n.t("Undo Branch Operation");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Undo the last branch operation on the current branch? The branch will reset to the saved snapshot."
    ),
    { modal: true },
    label
  );
  if (choice !== label) {
    return;
  }
  try {
    logInfo("branch operation undo started", { repoRoot: service.repoRoot });
    const result = await branchService.undoLastOperation();
    logInfo("branch operation undo finished", {
      repoRoot: service.repoRoot,
      branch: result.branch,
      restoredHead: shortHash(result.restoredHead),
    });
    service.invalidateStatusCache();
    await refreshAfterBranchOperation("branchOperationUndo");
    vscode.window.showInformationMessage(
      vscode.l10n.t("Branch operation undone on '{0}'.", result.branch)
    );
  } catch (err) {
    logError("branch operation undo failed", err, { repoRoot: service.repoRoot });
    vscode.window.showErrorMessage(
      vscode.l10n.t("Branch operation undo failed: {0}", errorText(err))
    );
  }
}

/**
 * source 브랜치를 선택하고 실행에 필요한 repoRoot 정보를 함께 반환한다.
 * @param deps 명령들이 공유하는 의존성
 * @param operation 실행할 branch operation 종류
 */
async function pickSourceBranch(
  deps: CommandDeps,
  operation: BranchOperationKind
): Promise<{ repoRoot: string; branch: BranchInfo } | undefined> {
  const service = await resolveCompareService(deps);
  if (!service) {
    return undefined;
  }
  const branches = await service.listBranches(true);
  const current = branches.find((branch) => branch.isCurrent)?.name;
  const candidates = branches.filter(
    (branch) => !branch.isCurrent
  );
  if (!candidates.length) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("No other local or remote branch is available.")
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((branch) => ({
      label: branch.name,
      description: branch.kind === "remote"
        ? vscode.l10n.t("remote")
        : vscode.l10n.t("local"),
      detail: current
        ? vscode.l10n.t("Merge into current branch '{0}'.", current)
        : undefined,
      branch,
    })),
    {
      placeHolder: operation === "squash"
        ? vscode.l10n.t("Select a branch to squash merge into the current branch")
        : vscode.l10n.t("Select a branch to rebase merge into the current branch"),
    }
  );
  return picked ? { repoRoot: service.repoRoot, branch: picked.branch } : undefined;
}

/**
 * 선택된 브랜치 작업을 확인 후 실행하고 결과 상태에 맞게 UI 를 갱신한다.
 * @param picked 선택된 저장소와 source 브랜치
 * @param operation 실행할 branch operation 종류
 */
async function runBranchOperation(
  picked: { repoRoot: string; branch: BranchInfo },
  operation: BranchOperationKind
): Promise<void> {
  const sourceBranch = picked.branch.name;
  if (!(await confirmBranchOperation(sourceBranch, operation))) {
    return;
  }
  try {
    logInfo("branch command operation started", {
      repoRoot: picked.repoRoot,
      sourceBranch,
      sourceKind: picked.branch.kind,
      operation,
    });
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: operation === "squash"
          ? vscode.l10n.t("Squash merging branch '{0}'", sourceBranch)
          : vscode.l10n.t("Rebase merging branch '{0}'", sourceBranch),
        cancellable: false,
      },
      () => runMaterializedBranchOperation(picked, operation)
    );
    await handleBranchOperationResult(result, operation, picked.repoRoot);
  } catch (err) {
    logError("branch command operation failed", err, {
      repoRoot: picked.repoRoot,
      sourceBranch,
      operation,
    });
    vscode.window.showErrorMessage(
      vscode.l10n.t("Branch operation failed: {0}", errorText(err))
    );
  }
}

/**
 * remote source 면 로컬 브랜치를 먼저 만든 뒤 branch operation 을 실행한다.
 * @param picked 선택된 저장소와 source 브랜치
 * @param operation 실행할 branch operation 종류
 */
async function runMaterializedBranchOperation(
  picked: { repoRoot: string; branch: BranchInfo },
  operation: BranchOperationKind
): Promise<BranchOperationResult> {
  const source = await materializeBranchSource(
    picked.repoRoot,
    picked.branch.name,
    picked.branch.kind
  );
  if (source.created) {
    logInfo("branch command materialized remote branch", {
      repoRoot: picked.repoRoot,
      remoteBranch: picked.branch.name,
      localBranch: source.branch,
    });
  }
  const service = new BranchOperationService(picked.repoRoot);
  return operation === "squash"
    ? service.squashMerge(source.branch)
    : service.rebaseMerge(source.branch);
}

/**
 * branch operation 결과에 따라 그래프/변경/충돌 뷰를 갱신하고 사용자 메시지를 표시한다.
 * @param deps 명령들이 공유하는 의존성
 * @param result branch operation 실행 결과
 * @param operation 실행한 branch operation 종류
 */
async function handleBranchOperationResult(
  result: BranchOperationResult,
  operation: BranchOperationKind,
  repoRoot: string
): Promise<void> {
  if (result.status === "conflicts") {
    logInfo("branch command operation paused for conflicts", {
      repoRoot,
      operation,
      sourceBranch: result.sourceBranch,
      snapshotRef: result.snapshotRef,
      preservedStashHash: result.preservedStashHash,
    });
    await refreshAfterBranchOperation("branchOperationConflicts");
    await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
    vscode.window.showWarningMessage(
      operation === "rebase"
        ? vscode.l10n.t(
            "Branch rebase merge paused with conflicts. Resolve them in the Conflicts view, then Continue."
          )
        : vscode.l10n.t(
            "Branch squash merge paused with conflicts. Resolve them in the Conflicts view, then commit the squash result."
          )
    );
    return;
  }
  logInfo("branch command operation finished", {
    repoRoot,
    operation,
    branch: result.branch,
    sourceBranch: result.sourceBranch,
    beforeHead: shortHash(result.beforeHead),
    afterHead: shortHash(result.afterHead),
  });
  await refreshAfterBranchOperation("branchOperationCompleted");
  vscode.window.showInformationMessage(
    operation === "squash"
      ? vscode.l10n.t("Branch '{0}' squash-merged into '{1}'.", result.sourceBranch, result.branch)
      : vscode.l10n.t("Branch '{0}' rebase-merged into '{1}'.", result.sourceBranch, result.branch)
  );
}

/**
 * branch operation 실행 전 사용자 확인을 받는다.
 * @param sourceBranch source 브랜치 이름
 * @param operation 실행할 branch operation 종류
 */
async function confirmBranchOperation(
  sourceBranch: string,
  operation: BranchOperationKind
): Promise<boolean> {
  const label = operation === "squash"
    ? vscode.l10n.t("Squash Merge")
    : vscode.l10n.t("Rebase Merge");
  const message = operation === "squash"
    ? vscode.l10n.t("Squash merge branch '{0}' into the current branch?", sourceBranch)
    : vscode.l10n.t(
        "Rebase merge branch '{0}' into the current branch? Clean commits are applied first; conflict commits are shown last.",
        sourceBranch
      );
  return (
    (await vscode.window.showWarningMessage(message, { modal: true }, label)) ===
    label
  );
}

/**
 * branch operation 이후 관련 뷰를 갱신한다.
 * @param reason refresh 로그와 debounce 구분에 사용할 사유
 */
async function refreshAfterBranchOperation(reason: string): Promise<void> {
  await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", { reason });
  await vscode.commands.executeCommand("gitSimpleCompare.refreshConflicts");
}

/**
 * 긴 커밋 해시를 UI 표시용으로 줄인다.
 * @param hash 전체 commit hash
 */
function shortHash(hash: string): string {
  return hash.slice(0, 10);
}

/**
 * 오류 메시지를 사용자에게 보여줄 짧은 문자열로 만든다.
 * @param err catch 로 받은 알 수 없는 오류 값
 */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
