// 그래프 안에서 만든 interactive rebase 계획을 실행하는 모듈.
// - 웹뷰 패널은 메시지 라우팅만 하고, 기준점 계산/실행/충돌 이동은 이 모듈이 담당한다.
import * as vscode from "vscode";
import { ConflictService } from "../git/conflictService";
import {
  createRebaseEditTempFile,
  listRebaseEditTempPaths,
} from "../git/rebaseEditSession";
import { updateInProgressRebaseTodo } from "../git/rebaseTodoEditor";
import { EMPTY_TREE, GitLogService } from "../git/gitLogService";
import {
  RebaseItem,
  RebasePlanInfo,
  RebasePausedState,
  RebaseResult,
  RebaseService,
} from "../git/rebaseService";
import { openRefVsWorkingDiff } from "../ui/diffPresenter";
import { logInfo } from "../ui/outputLog";

/** 그래프 rebase 실행에 필요한 공유 의존성 */
export interface GraphRebaseDeps {
  extensionUri: vscode.Uri;
  logService: GitLogService;
  refreshGraph: () => Promise<void>;
}

/** paused rebase 의 Continue/Abort UI 처리 결과 */
export interface GraphRebaseControlResult {
  status: "completed" | "conflicts" | "failed" | "paused" | "aborted";
  message?: string;
  paused?: RebasePausedState;
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
  editPath: string | undefined,
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
  } else if (result.status === "paused" && result.paused) {
    await deps.refreshGraph();
    void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason: "graphRebaseEditPaused",
    });
    await openPausedEditFile(deps.logService.repoRoot, result.paused, editPath);
    vscode.window.showInformationMessage(
      vscode.l10n.t(
        "Rebase paused for edit. Change files, then Continue to amend this commit."
      )
    );
  } else if (result.status === "noop") {
    vscode.window.showInformationMessage(vscode.l10n.t("Nothing to rebase."));
  } else if (result.message !== "cancelled") {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Rebase failed: {0}", result.message ?? "")
    );
  }
  return result;
}

/**
 * edit 으로 멈춘 rebase 지점의 특정 파일을 편집 가능한 diff 로 연다.
 * @param relPath 사용자가 drawer 에서 고른 저장소 상대 경로
 * @param deps 그래프 패널 의존성
 */
export async function openPausedRebaseEditFile(
  relPath: string,
  deps: Pick<GraphRebaseDeps, "logService">
): Promise<void> {
  const service = new RebaseService(deps.logService.repoRoot);
  const paused = await service.getPausedEditState();
  if (!paused) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Start the rebase first. The editor opens when Git stops at this edit commit.")
    );
    return;
  }
  await openPausedEditFile(deps.logService.repoRoot, paused, relPath);
}

/**
 * 그래프 rebase bar/drawer 에서 paused rebase 를 계속 진행한다.
 * - 다음 edit 지점이면 drawer 상태를 paused 로 유지하고, 완료되면 clear 신호를 보낸다.
 * @param deps 그래프 패널 의존성
 */
export async function continueGraphRebase(
  deps: Pick<GraphRebaseDeps, "extensionUri" | "logService" | "refreshGraph">,
  items: RebaseItem[] = [],
  changedHashes: string[] = []
): Promise<GraphRebaseControlResult> {
  const repoRoot = deps.logService.repoRoot;
  const conflicts = new ConflictService(repoRoot);
  if (await conflicts.getOperation() !== "rebase") {
    await refreshAfterRebaseControl(deps, "graphRebaseContinueNoop");
    return { status: "completed" };
  }
  const rebase = new RebaseService(repoRoot);
  const paused = await rebase.getPausedEditState();
  if (paused) {
    await saveRebaseEditTempDocuments(repoRoot, paused);
  }
  const todo = await updateInProgressRebaseTodo(
    repoRoot,
    items,
    changedHashes,
    paused,
    { editorScript: editorScriptPath(deps.extensionUri) }
  );
  if (
    todo.missingChangedEditHashes.length > 0 ||
    todo.missingChangedFileHashes.length > 0
  ) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("That commit has already been applied in this rebase. Abort and start a new rebase plan to edit it.")
    );
    return paused ? { status: "paused", paused } : { status: "failed", message: "commit already applied" };
  }
  if (todo.changed) {
    logInfo("graph rebase todo updated before continue", {
      repoRoot,
      changedHashes: changedHashes.length,
      missingFileHashes: todo.missingChangedFileHashes.length,
    });
  }
  if (await rebase.amendPausedEditChanges(paused)) {
    logInfo("graph rebase edit commit amended", {
      repoRoot,
      paused: paused?.hash,
      original: paused?.originalHash,
    });
  }
  try {
    await conflicts.continueOperation("rebase");
  } catch (err) {
    const state = await readRebaseControlState(deps, "");
    if (state.status === "conflicts") {
      return state;
    }
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(vscode.l10n.t("Rebase continue failed: {0}", message));
    if (state.status === "paused") {
      return { ...state, message };
    }
    return { status: "failed", message };
  }
  return readRebaseControlState(deps, "Rebase completed.");
}

/**
 * 그래프 rebase bar/drawer 에서 paused rebase 를 중단한다.
 * - 중단이 끝나면 그래프와 changes 를 갱신하고 웹뷰 rebase edit 모드를 정리한다.
 * @param deps 그래프 패널 의존성
 */
export async function abortGraphRebase(
  deps: Pick<GraphRebaseDeps, "logService" | "refreshGraph">
): Promise<GraphRebaseControlResult> {
  const repoRoot = deps.logService.repoRoot;
  const conflicts = new ConflictService(repoRoot);
  if (await conflicts.getOperation() !== "rebase") {
    await refreshAfterRebaseControl(deps, "graphRebaseAbortNoop");
    return { status: "completed" };
  }
  const yes = vscode.l10n.t("Abort Rebase");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("Abort the paused rebase and restore the previous branch state?"),
    { modal: true },
    yes
  );
  if (choice !== yes) {
    return { status: "failed", message: "cancelled" };
  }
  await conflicts.abortOperation("rebase");
  await refreshAfterRebaseControl(deps, "graphRebaseAborted");
  vscode.window.showInformationMessage(vscode.l10n.t("Rebase aborted."));
  return { status: "aborted" };
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

/** continue 뒤 rebase 의 다음 상태를 읽고 필요한 UI 전환을 수행한다. */
async function readRebaseControlState(
  deps: Pick<GraphRebaseDeps, "logService" | "refreshGraph">,
  completedMessage: string
): Promise<GraphRebaseControlResult> {
  const repoRoot = deps.logService.repoRoot;
  const rebase = new RebaseService(repoRoot);
  const paused = await rebase.getPausedEditState();
  if (paused) {
    await refreshAfterRebaseControl(deps, "graphRebaseEditPaused");
    await openPausedEditFile(repoRoot, paused);
    return { status: "paused", paused };
  }
  const conflicts = await new ConflictService(repoRoot).listConflicts().catch(() => []);
  if (conflicts.length > 0) {
    await refreshAfterRebaseControl(deps, "graphRebaseConflict");
    await focusRebaseConflicts(repoRoot);
    return { status: "conflicts" };
  }
  await refreshAfterRebaseControl(deps, "graphRebaseCompleted");
  if (completedMessage) {
    vscode.window.showInformationMessage(vscode.l10n.t(completedMessage));
  }
  return { status: "completed" };
}

/** rebase 제어 후 그래프와 Changes 트리를 같은 타이밍에 갱신한다. */
async function refreshAfterRebaseControl(
  deps: Pick<GraphRebaseDeps, "refreshGraph">,
  reason: string
): Promise<void> {
  await deps.refreshGraph();
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", { reason });
}

/** Continue 직전에 열려 있는 rebase edit 임시 문서의 dirty 내용을 저장한다. */
async function saveRebaseEditTempDocuments(
  repoRoot: string,
  paused: RebasePausedState
): Promise<void> {
  const paths = new Set(listRebaseEditTempPaths(repoRoot, paused));
  const docs = vscode.workspace.textDocuments.filter(
    (doc) => doc.isDirty && doc.uri.scheme === "file" && paths.has(doc.uri.fsPath)
  );
  await Promise.all(docs.map((doc) => doc.save()));
}

/** edit 정지 지점에서 첫 편집 가능 파일 또는 사용자가 고른 파일을 editable diff 로 연다. */
async function openPausedEditFile(
  repoRoot: string,
  paused: RebasePausedState,
  requestedPath?: string
): Promise<void> {
  const file = requestedPath
    ? paused.files.find((entry) => entry.path === requestedPath)
    : paused.files.find((entry) => !entry.status.startsWith("D"));
  if (!file) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("No editable file is available for this paused commit.")
    );
    return;
  }
  if (file.status.startsWith("D")) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Deleted files cannot be opened as editable working-tree diffs.")
    );
    return;
  }
  const base = paused.parent || EMPTY_TREE;
  const editFile = await createRebaseEditTempFile(repoRoot, paused, file);
  await openRefVsWorkingDiff(
    repoRoot,
    base,
    vscode.Uri.file(editFile.tempPath),
    file.path,
    {
      fileLabel: file.path.slice(file.path.lastIndexOf("/") + 1),
      leftRelPath: editFile.leftRelPath,
      rightLabel: vscode.l10n.t("Rebase Edit"),
    }
  );
  logInfo("graph rebase edit file opened", {
    repoRoot,
    path: file.path,
    tempPath: editFile.tempPath,
    paused: paused.hash,
    original: paused.originalHash,
  });
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
