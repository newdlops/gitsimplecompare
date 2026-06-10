// 변경 분할(부분 커밋) 진입 명령.
// - 대상 저장소를 찾고, 인덱스가 깨끗한지 확인한 뒤 분할 패널을 연다.
//   (선택 hunk 만 정확히 커밋되도록 미리 스테이징된 변경이 없어야 한다.)
import * as vscode from "vscode";
import { DiffHunkService } from "../git/diffHunkService";
import { SplitPanel } from "../webview/splitPanel";
import { CommandDeps, resolveWorkspaceService } from "./shared";

/**
 * "변경을 여러 커밋으로 분할" 명령 본문.
 * @param deps 공유 의존성
 */
export async function showSplitCommits(deps: CommandDeps): Promise<void> {
  const service = await resolveWorkspaceService(deps.registry);
  if (!service) {
    return;
  }
  const hunkService = new DiffHunkService(service.repoRoot);

  // 인덱스에 이미 스테이징된 변경이 있으면 분할 결과가 섞이므로 막는다.
  if (await hunkService.hasStagedChanges()) {
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "You have staged changes. Commit or unstage them before splitting."
      )
    );
    return;
  }

  SplitPanel.createOrShow(deps.extensionUri, hunkService);
}
