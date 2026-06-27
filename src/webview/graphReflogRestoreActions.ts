// graph reflog 패널에서 기존 로컬 브랜치를 복구하는 액션 모듈.
// - reflog UI 전용 흐름을 graphActions.ts 에 누적하지 않도록 분리한다.
import * as vscode from "vscode";
import {
  restoreLocalBranchFromReflog,
  type ReflogBranchRestoreResult,
} from "../git/reflogBranchRestoreService";
import type { LocalBranchStatus } from "../graph/graphTypes";
import { logInfo } from "../ui/outputLog";
import type { GraphBranchActionDeps } from "./graphBranchActions";

/**
 * reflog 항목이 가리키는 commit 으로 기존 로컬 브랜치를 복구한다.
 * - 복구 대상 브랜치는 quick pick 으로 고르게 하고, 실제 ref 이동 전 확인을 한 번 더 받는다.
 * @param deps         graph 패널이 제공하는 git service 와 refresh 콜백
 * @param hash         reflog/object 항목이 가리키는 commit hash
 * @param isRealCommit 가상 커밋 여부를 판별하는 함수
 */
export async function restoreBranchFromReflog(
  deps: GraphBranchActionDeps,
  hash: string,
  isRealCommit: (hash: string) => boolean
): Promise<void> {
  const targetHash = hash.trim();
  if (!isRealCommit(targetHash)) {
    return;
  }
  const branch = await pickRestoreBranch(deps);
  if (!branch) {
    return;
  }
  const ok = await confirmRestore(branch, targetHash);
  if (!ok) {
    return;
  }

  logInfo("graph reflog branch restore started", {
    repoRoot: deps.logService.repoRoot,
    branch: branch.name,
    targetHash,
  });
  const result = await restoreLocalBranchFromReflog(
    deps.logService.repoRoot,
    branch.name,
    targetHash
  );
  logInfo("graph reflog branch restore finished", {
    repoRoot: deps.logService.repoRoot,
    branch: result.branchName,
    backupBranch: result.backupName,
    oldHash: result.oldHash,
    targetHash: result.targetHash,
  });

  await deps.refreshGraph();
  vscode.window.showInformationMessage(successMessage(result));
}

/**
 * 복구할 로컬 브랜치를 선택한다.
 * @param deps graph 패널이 제공하는 git service
 */
async function pickRestoreBranch(
  deps: GraphBranchActionDeps
): Promise<LocalBranchStatus | undefined> {
  const branches = (await deps.logService.getLocalBranches())
    .filter((branch) => !branch.current);
  if (branches.length === 0) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Checkout another branch before restoring the current branch from reflog.")
    );
    return undefined;
  }
  const items = branches.map((branch) => ({
    label: branch.name,
    description: shortHash(branch.hash),
    detail: branch.subject,
    branch,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t("Branch to restore to this reflog commit"),
  });
  return picked?.branch;
}

/**
 * 기존 브랜치 tip 을 백업한 뒤 이동한다는 확인 메시지를 보여준다.
 * @param branch     사용자가 선택한 복구 대상 브랜치
 * @param targetHash reflog 가 가리키는 복구 대상 commit
 */
async function confirmRestore(
  branch: LocalBranchStatus,
  targetHash: string
): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Restore branch '{0}' to reflog commit {1}? Current tip {2} will be saved as a backup branch.",
      branch.name,
      shortHash(targetHash),
      shortHash(branch.hash)
    ),
    { modal: true },
    vscode.l10n.t("Restore Branch")
  );
  return answer === vscode.l10n.t("Restore Branch");
}

/**
 * 복구 완료 안내 문구를 만든다.
 * @param result git 서비스에서 반환한 복구 결과
 */
function successMessage(result: ReflogBranchRestoreResult): string {
  if (!result.backupName) {
    return vscode.l10n.t(
      "Branch '{0}' already points at {1}.",
      result.branchName,
      shortHash(result.targetHash)
    );
  }
  return vscode.l10n.t(
    "Branch '{0}' restored to {1}. Backup: '{2}'.",
    result.branchName,
    shortHash(result.targetHash),
    result.backupName
  );
}

/**
 * UI 에 표시할 짧은 commit hash 를 만든다.
 * @param hash 전체 commit hash
 */
function shortHash(hash: string): string {
  return hash.slice(0, 10);
}
