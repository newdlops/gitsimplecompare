// 인터랙티브 rebase 진입 명령.
// - 최근 커밋을 골라 "이 커밋부터(이 커밋과 그 이후)" 편집하는 rebase 패널을 연다.
//   기준점(base)은 고른 커밋의 직전(picked^)이 된다.
import * as vscode from "vscode";
import { GitLogService } from "../git/gitLogService";
import { RebaseService } from "../git/rebaseService";
import { RebasePanel } from "../webview/rebasePanel";
import { CommandDeps, resolveWorkspaceService } from "./shared";

/**
 * "인터랙티브 rebase 시작" 명령 본문.
 * - HEAD 의 최근 커밋 목록에서 시작점을 고른 뒤 rebase 계획 패널을 연다.
 * @param deps 공유 의존성
 */
export async function startInteractiveRebase(
  deps: CommandDeps
): Promise<void> {
  const service = await resolveWorkspaceService(deps.registry);
  if (!service) {
    return;
  }

  const log = new GitLogService(service.repoRoot);
  const commits = await log.getCommits(30, ["HEAD"]);
  if (commits.length === 0) {
    vscode.window.showWarningMessage(vscode.l10n.t("No commits to rebase."));
    return;
  }

  const picked = await vscode.window.showQuickPick(
    commits.map((c) => ({
      label: c.subject,
      description: `${c.hash.slice(0, 7)} · ${c.authorName}`,
      hash: c.hash,
    })),
    {
      placeHolder: vscode.l10n.t(
        "Rebase from this commit (it and newer commits become editable)"
      ),
    }
  );
  if (!picked) {
    return;
  }

  RebasePanel.createOrShow(
    deps.extensionUri,
    new RebaseService(service.repoRoot),
    `${picked.hash}^`
  );
}
