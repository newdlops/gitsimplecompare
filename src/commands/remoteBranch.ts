// 현재 브랜치의 원격 브랜치 설정 명령.
// - 실제 git 변경은 git/remoteBranchService, 사용자 선택 UI 는 ui/remoteBranchSetup 에 위임한다.
import * as vscode from "vscode";
import { promptRemoteBranchSetup } from "../ui/remoteBranchSetup";
import { logInfo } from "../ui/outputLog";
import { CommandDeps, resolveCompareService } from "./shared";

/**
 * 현재 선택된 저장소에서 현재 브랜치의 upstream remote branch 를 설정한다.
 * - Changes 뷰의 활성 저장소를 우선하고, 없으면 워크스페이스/활성 에디터에서 저장소를 찾는다.
 * @param deps 명령 공통 의존성
 */
export async function configureRemoteBranch(deps: CommandDeps): Promise<void> {
  const service = await resolveCompareService(deps);
  if (!service) {
    return;
  }
  const result = await promptRemoteBranchSetup(service.repoRoot, "manual");
  logInfo("configure remote branch command finished", {
    repoRoot: service.repoRoot,
    status: result.status,
    upstream:
      result.status === "configured" ||
      result.status === "published" ||
      result.status === "unset"
        ? result.result.upstream
        : undefined,
  });
  if (
    result.status === "configured" ||
    result.status === "published" ||
    result.status === "unset"
  ) {
    void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason: "remoteBranchConfigured",
    });
  }
}
