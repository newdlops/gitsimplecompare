// Hunk 스테이징 진입 명령.
// - 별도 hunk 웹뷰가 아니라 HEAD ↔ Working Tree native editable diff 를 연다.
import * as vscode from "vscode";
import type { DiffStage } from "../git/diffHunkService";
import { CommandDeps, resolveWorkspaceService } from "./shared";
import { openWorkingChange } from "./workingChanges";

export interface SplitFocus {
  path?: string;
  stage?: DiffStage;
}

/**
 * "Hunk 스테이징" 명령 본문.
 * @param deps 공유 의존성
 */
export async function showSplitCommits(
  deps: CommandDeps,
  focus?: SplitFocus
): Promise<void> {
  const active = deps.changesView.getActiveRepo();
  const service = active
    ? deps.registry.get(active)
    : await resolveWorkspaceService(deps.registry);
  if (!service) {
    return;
  }
  // 첫 미스테이징 경로만 필요하므로 +/- 통계 보강은 생략해 diff 진입을 빠르게 연다.
  const path = focus?.path ?? (
    await service.getStatusGroups({ includeStats: false })
  ).unstaged[0]?.path;
  if (!path) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("No unstaged changes found.")
    );
    return;
  }
  await openWorkingChange(deps, {
    root: service.repoRoot,
    path,
    stage: "unstaged",
  });
}
