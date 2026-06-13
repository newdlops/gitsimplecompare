// git graph 헤더의 fetch/pull/push 동작을 처리하는 웹뷰 액션 모듈.
// - graphActions.ts 의 checkout/branch/tag 액션과 분리해 파일 크기와 책임을 유지한다.
import * as vscode from "vscode";
import { PullCurrentResult, PullService } from "../git/pullService";
import { GitLogService } from "../git/gitLogService";
import { gitErrorText, isForcePushRequiredError } from "../git/pushErrors";
import { RemoteBranchService } from "../git/remoteBranchService";
import { logInfo } from "../ui/outputLog";

interface GraphSyncActionDeps {
  logService: GitLogService;
  refreshGraph: () => Promise<void>;
}

/** 원격 branch ref 를 가져오고 그래프를 다시 읽는다. tag 는 별도 액션에서 처리한다. */
export async function fetchAll(deps: GraphSyncActionDeps): Promise<void> {
  await withGraphProgress(vscode.l10n.t("Fetching..."), () =>
    deps.logService.fetchAll()
  );
  await deps.refreshGraph();
  vscode.window.showInformationMessage(vscode.l10n.t("Fetch completed."));
}

/** tag 목록만 원격에서 가져오고 그래프를 갱신한다. */
export async function fetchTags(deps: GraphSyncActionDeps): Promise<void> {
  await withGraphProgress(vscode.l10n.t("Fetching tags..."), () =>
    deps.logService.fetchTags()
  );
  await deps.refreshGraph();
  vscode.window.showInformationMessage(vscode.l10n.t("Tags fetched."));
}

/**
 * 현재 브랜치를 pull 한다. 일반 pull 을 먼저 시도하고, 로컬 변경 충돌 시 rollback 선택지를 제공한다.
 */
export async function pullCurrent(deps: GraphSyncActionDeps): Promise<void> {
  const service = new PullService(deps.logService.repoRoot);
  logInfo("graph pull started", { repoRoot: deps.logService.repoRoot });
  const result = await withGraphProgress(vscode.l10n.t("Pulling..."), () =>
    service.pullCurrent()
  );
  await deps.refreshGraph();
  await refreshSideViews("graphPull");
  if (result.status === "conflicts") {
    await showPullConflictActions(result);
    return;
  }
  logInfo("graph pull completed", {
    repoRoot: deps.logService.repoRoot,
    hadLocalChanges: result.hadLocalChanges,
  });
  vscode.window.showInformationMessage(vscode.l10n.t("Pull completed."));
}

/** 현재 브랜치를 upstream 으로 push 한 뒤 그래프를 갱신한다. */
export async function pushCurrent(deps: GraphSyncActionDeps): Promise<void> {
  try {
    await withGraphProgress(vscode.l10n.t("Pushing..."), () =>
      deps.logService.pushCurrent()
    );
  } catch (err) {
    if (isForcePushRequiredError(err)) {
      await showForcePushRequiredMessage(err);
      return;
    }
    throw err;
  }
  await deps.refreshGraph();
  vscode.window.showInformationMessage(vscode.l10n.t("Push completed."));
}

/** 현재 브랜치에 연결된 upstream remote branch 페이지를 브라우저로 연다. */
export async function openRemoteBranch(
  deps: GraphSyncActionDeps
): Promise<void> {
  const link = await new RemoteBranchService(
    deps.logService.repoRoot
  ).getCurrentBranchLink();
  if (!link) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("No remote branch is connected to the current branch.")
    );
    return;
  }
  if (link.kind === "unsupported") {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Could not open remote branch page for '{0}'.", link.upstream),
      { modal: true, detail: link.remoteUrl }
    );
    return;
  }
  logInfo("graph remote branch page opened", {
    repoRoot: deps.logService.repoRoot,
    upstream: link.upstream,
    url: link.url,
  });
  await vscode.env.openExternal(vscode.Uri.parse(link.url));
}

/**
 * force push 가 필요할 수 있는 push 거절을 안내한다.
 * - 이 확장은 실수로 원격 기록을 덮어쓰지 않도록 force push 버튼/액션을 제공하지 않는다.
 * @param err git push 오류
 */
async function showForcePushRequiredMessage(err: unknown): Promise<void> {
  await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Push was rejected because the remote branch is not a fast-forward update. Git Simple Compare does not provide force push."
    ),
    { modal: true, detail: gitErrorText(err) }
  );
}

/** Pull 충돌을 사용자에게 알리고 충돌 뷰 열기 또는 pull rollback 을 실행한다. */
async function showPullConflictActions(result: Extract<PullCurrentResult, { status: "conflicts" }>): Promise<void> {
  logInfo("graph pull conflicts detected", {
    stage: result.stage,
    hadLocalChanges: result.hadLocalChanges,
    hasRollbackSnapshot: Boolean(result.snapshot),
  });
  await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
  const open = vscode.l10n.t("Open Conflicts");
  const rollback = vscode.l10n.t("Rollback Pull");
  const message =
    result.stage === "restoreLocalChanges"
      ? vscode.l10n.t(
          "Pull completed, but restoring local changes caused conflicts. Resolve them in the Conflicts view, or rollback to the state before pull."
        )
      : vscode.l10n.t(
          "Pull stopped with conflicts. Resolve them in the Conflicts view, or rollback to the state before pull."
        );
  const actions = result.snapshot ? [open, rollback] : [open];
  const choice = await vscode.window.showWarningMessage(message, ...actions);
  if (choice === rollback) {
    await vscode.commands.executeCommand("gitSimpleCompare.rollbackPull");
  } else if (choice === open) {
    await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
  }
}

/** 진행 표시와 함께 graph git 작업을 실행한다. */
function withGraphProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
  return Promise.resolve(
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      task
    )
  );
}

/** graph 동기화 액션 뒤 Changes/Stashes/Conflicts 뷰를 새로고침한다. */
async function refreshSideViews(reason: string): Promise<void> {
  await vscode.commands.executeCommand("gitSimpleCompare.refreshConflicts");
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", { reason });
}
