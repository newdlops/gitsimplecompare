// 그래프 안에서 만든 interactive rebase 계획을 실행하는 모듈.
// - 웹뷰 패널은 메시지 라우팅만 하고, 기준점 계산/실행/충돌 이동은 이 모듈이 담당한다.
import * as vscode from "vscode";
import { ConflictService } from "../git/conflictService";
import { GitLogService } from "../git/gitLogService";
import {
  RebaseItem,
  RebasePlanInfo,
  RebaseResult,
  RebaseService,
} from "../git/rebaseService";
import { logInfo } from "../ui/outputLog";

/** 그래프 rebase 실행에 필요한 공유 의존성 */
export interface GraphRebaseDeps {
  extensionUri: vscode.Uri;
  logService: GitLogService;
  refreshGraph: () => Promise<void>;
}

/**
 * 그래프에서 드래그한 커밋을 기준으로 현재 브랜치의 rebase 계획을 만든다.
 * @param hash 사용자가 드래그한 커밋 해시
 * @param onto 사용자가 드래그를 놓은 대상 커밋 해시
 * @param deps 그래프 패널 의존성
 */
export async function prepareGraphRebase(
  hash: string | undefined,
  onto: string | undefined,
  deps: Pick<GraphRebaseDeps, "logService">
): Promise<RebasePlanInfo> {
  const service = new RebaseService(deps.logService.repoRoot);
  const plan = await service.prepareCurrentBranchPlan(hash, onto);
  logInfo("graph rebase plan prepared", {
    repoRoot: deps.logService.repoRoot,
    startHash: hash,
    requestedOnto: onto,
    base: plan.base,
    root: Boolean(plan.root),
    onto: plan.onto,
    commits: plan.commits.length,
  });
  return plan;
}

/**
 * 그래프 UI 에서 확정한 rebase 계획을 실행한다.
 * - staged/unstaged 변경은 RebaseService 의 --autostash 로 보존하고, 실행 전 사용자 확인만 거친다.
 * - 충돌로 멈추면 Conflicts 뷰를 갱신하고 포커스한다.
 * @param base rebase 기준 커밋
 * @param root true 면 root commit 부터 interactive rebase 한다.
 * @param onto --onto 대상 커밋. 없으면 일반 interactive rebase 로 실행한다.
 * @param items rebase todo 항목(오래된 커밋부터)
 * @param deps 그래프 패널 의존성
 */
export async function runGraphRebase(
  base: string,
  root: boolean,
  onto: string | undefined,
  items: RebaseItem[],
  deps: GraphRebaseDeps
): Promise<RebaseResult> {
  const service = new RebaseService(deps.logService.repoRoot);
  const count = items.filter((item) => item.action !== "drop").length;
  const yes = vscode.l10n.t("Start Rebase");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Rewrite history of {0} commit(s)? This cannot be easily undone.",
      count
    ),
    { modal: true },
    yes
  );
  if (choice !== yes) {
    return { status: "failed", message: "cancelled" };
  }

  logInfo("graph rebase starting", {
    repoRoot: deps.logService.repoRoot,
    base,
    root,
    onto,
    items: items.length,
  });
  const result = await service.start(
    base,
    root,
    items,
    editorScriptPath(deps.extensionUri),
    onto
  );
  if (result.status === "completed") {
    await deps.refreshGraph();
    void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason: "graphRebaseCompleted",
    });
    vscode.window.showInformationMessage(vscode.l10n.t("Rebase completed."));
  } else if (result.status === "conflicts") {
    await deps.refreshGraph();
    await focusRebaseConflicts(deps.logService.repoRoot);
  } else if (result.status === "noop") {
    vscode.window.showInformationMessage(vscode.l10n.t("Nothing to rebase."));
  } else if (result.message !== "cancelled") {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Rebase failed: {0}", result.message ?? "")
    );
  }
  return result;
}

/** rebaseEditor.js 헬퍼 스크립트의 파일 시스템 경로를 만든다. */
function editorScriptPath(extensionUri: vscode.Uri): string {
  return vscode.Uri.joinPath(
    extensionUri,
    "media",
    "rebase",
    "rebaseEditor.js"
  ).fsPath;
}

/** rebase 충돌이 발생하면 충돌 뷰로 이동한다. */
async function focusRebaseConflicts(repoRoot: string): Promise<void> {
  const files = await new ConflictService(repoRoot).listConflicts().catch(() => []);
  logInfo("graph rebase conflicts detected", {
    repoRoot,
    conflicts: files.length,
  });
  await vscode.commands.executeCommand("gitSimpleCompare.refreshConflicts");
  await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "graphRebaseConflict",
  });
  vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Rebase paused due to conflicts. Resolve them in the Conflicts view, then Continue."
    )
  );
}
