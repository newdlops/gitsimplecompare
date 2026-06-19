// 그래프 브랜치 rename 입력/검증 UI 를 담당하는 모듈.
// - 실제 git ref 변경은 BranchRenameService 에 위임해 UI 와 git 접근 책임을 분리한다.
import * as vscode from "vscode";
import { BranchRenameService } from "../git/branchRenameService";
import { GitLogService } from "../git/gitLogService";
import type { LocalBranchStatus } from "../graph/graphTypes";

/** 그래프 branch rename 에 필요한 의존성 */
export interface GraphBranchRenameDeps {
  logService: GitLogService;
  refreshGraph: () => Promise<void>;
}

/**
 * 로컬 브랜치 이름을 변경한다.
 * - rename 뒤에는 branch ref 캐시와 그래프를 새로 읽어 chip 이름을 즉시 갱신한다.
 * @param deps graph 패널이 제공하는 git service 와 refresh 콜백
 * @param branchName 이름을 바꿀 로컬 브랜치 이름
 */
export async function renameBranch(
  deps: GraphBranchRenameDeps,
  branchName: string
): Promise<void> {
  const localBranch = await findLocalBranch(deps, branchName);
  if (!localBranch) {
    vscode.window.showWarningMessage(vscode.l10n.t("Branch not found: {0}", branchName));
    return;
  }
  const existingNames = new Set(
    (await deps.logService.getBranches()).map((branch) => branch.name)
  );
  const service = new BranchRenameService(deps.logService.repoRoot);
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("New branch name"),
    value: branchName,
    validateInput: async (value) =>
      validateRenameBranchName(service, value, branchName, existingNames),
  });
  const nextName = name?.trim();
  if (!nextName || nextName === branchName) {
    return;
  }
  await service.renameLocalBranch(branchName, nextName);
  deps.logService.invalidateCaches();
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Branch '{0}' renamed to '{1}'.", branchName, nextName)
  );
}

/**
 * 로컬 브랜치 목록에서 이름이 일치하는 항목을 찾는다.
 * @param deps graph 패널이 제공하는 git service
 * @param branchName 찾을 로컬 브랜치 이름
 * @returns 브랜치 상태. 없으면 undefined
 */
async function findLocalBranch(
  deps: Pick<GraphBranchRenameDeps, "logService">,
  branchName: string
): Promise<LocalBranchStatus | undefined> {
  return (await deps.logService.getLocalBranches()).find(
    (item) => item.name === branchName
  );
}

/**
 * rename 입력값을 즉시 검증한다.
 * @param service git branch 이름 검증 서비스
 * @param value 사용자가 입력한 새 브랜치 이름
 * @param oldName 기존 브랜치 이름
 * @param existingNames 이미 존재하는 로컬/원격 브랜치 이름 집합
 */
async function validateRenameBranchName(
  service: BranchRenameService,
  value: string,
  oldName: string,
  existingNames: Set<string>
): Promise<string | undefined> {
  const name = value.trim();
  if (!name) {
    return vscode.l10n.t("Branch name is required.");
  }
  if (name === oldName) {
    return undefined;
  }
  if (existingNames.has(name)) {
    return vscode.l10n.t("Branch '{0}' already exists.", name);
  }
  try {
    await service.assertValidBranchName(name);
    return undefined;
  } catch {
    return vscode.l10n.t("Invalid branch name.");
  }
}
