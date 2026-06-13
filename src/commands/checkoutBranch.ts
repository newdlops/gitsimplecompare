// 기능: 현재 저장소의 브랜치를 전환한다.
// - Changes view 상단 버튼에서 비교가 아니라 checkout 흐름을 열기 위한 명령 모듈이다.
import * as vscode from "vscode";
import { GitLogService } from "../git/gitLogService";
import { pickBranch } from "../ui/quickPick";
import { logError, logInfo } from "../ui/outputLog";
import {
  CommandDeps,
  readConfig,
  resolveCompareService,
} from "./shared";

/**
 * "브랜치 전환" 명령 본문.
 * - 활성 Changes 저장소를 우선 사용하고, 없으면 워크스페이스 저장소를 찾는다.
 * - 로컬 브랜치는 `git switch`, 원격 브랜치는 tracking 로컬 브랜치를 만든 뒤 전환한다.
 * @param deps 공유 의존성(저장소 레지스트리/Changes view)
 */
export async function checkoutBranch(deps: CommandDeps): Promise<void> {
  const service = await resolveCompareService(deps);
  if (!service) {
    return;
  }

  const branches = await service.listBranches(readConfig().includeRemoteBranches);
  const current = branches.find((branch) => branch.isCurrent)?.name;
  const picked = await pickBranch(
    branches,
    vscode.l10n.t("Select a branch to checkout"),
    current
  );
  if (!picked || picked.name === current) {
    return;
  }

  const logService = new GitLogService(service.repoRoot);
  try {
    if (picked.kind === "remote") {
      await logService.checkoutRemoteBranchAsLocal(picked.name);
    } else {
      await logService.checkoutLocalBranch(picked.name);
    }
    service.invalidateStatusCache();
    logInfo("branch checkout finished", {
      repoRoot: service.repoRoot,
      branch: picked.name,
      kind: picked.kind,
    });
    void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason: "checkoutBranch",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("branch checkout failed", err, {
      repoRoot: service.repoRoot,
      branch: picked.name,
      kind: picked.kind,
    });
    vscode.window.showErrorMessage(
      vscode.l10n.t("Could not checkout branch '{0}': {1}", picked.name, message)
    );
  }
}
