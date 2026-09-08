// 그래프 안에서 만든 interactive rebase 계획을 실행하는 모듈.
// - 웹뷰 패널은 메시지 라우팅만 하고, 기준점 계산/실행/충돌 이동은 이 모듈이 담당한다.
import * as vscode from "vscode";
import { readRebaseControlState, openPausedEditFile } from "./graphRebaseControlState";
import { saveRebaseEditTempDocuments } from "../ui/rebaseEditDocuments";
import { assertRebaseEditIdentity } from "../git/rebaseEditIdentity";
import { finishGraphRebaseControl } from "./graphRebaseFollowup";
import { ConflictService } from "../git/conflictService";
import { assertGitOperation, captureGitOperation } from "../git/operationControl";
import { assertRebaseCheckout, type RebaseCheckoutIdentity } from "../git/rebasePlanSafety";
import { runConflictMutation } from "../git/conflictMutationCoordinator";
import { readRebaseContinueDiagnostics } from "../git/rebaseContinueDiagnostics";
import { updateInProgressRebaseTodo } from "../git/rebaseTodoEditor";
import { refreshRebaseMessageQueueForContinue } from "../git/rebaseMessageQueue";
import { GitLogService } from "../git/gitLogService";
import {
  RebaseItem,
  RebasePlanInfo,
  RebasePausedState,
  RebaseResult,
  RebaseStoppedState,
  RebaseService,
} from "../git/rebaseService";
import { logError, logInfo } from "../ui/outputLog";
import { focusRebaseConflicts } from "./graphRebaseConflictFocus";
import {
  rebaseDiagnosticDetail,
  rebaseDiagnosticGuidance,
  rebaseDiagnosticLogDetail,
} from "./graphRebaseDiagnostics";
import { rebaseProgressLogDetail } from "./graphRebaseProgressLog";
import { editorScriptPath, refreshAfterRebaseControl } from "./graphRebaseUtils";

/** 그래프 rebase 실행에 필요한 공유 의존성 */
export interface GraphRebaseDeps {
  extensionUri: vscode.Uri;
  logService: GitLogService;
  refreshGraph: () => Promise<void>;
}

/** paused rebase 의 Continue/Abort UI 처리 결과 */
export interface GraphRebaseControlResult {
  status: "completed" | "conflicts" | "failed" | "paused" | "aborted" | "stopped";
  message?: string;
  guidance?: string[];
  paused?: RebasePausedState;
  stopped?: RebaseStoppedState;
  restoringLocalChanges?: boolean;
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
  const started = Date.now();
  const plan = await service.prepareCurrentBranchPlan(hash, onto);
  logInfo("graph rebase plan prepared", {
    repoRoot: deps.logService.repoRoot,
    startHash: hash,
    requestedOnto: onto,
    base: plan.base,
    root: Boolean(plan.root),
    onto: plan.onto,
    commits: plan.commits.length,
    elapsedMs: Date.now() - started,
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
  deps: GraphRebaseDeps,
  checkout?: RebaseCheckoutIdentity
): Promise<RebaseResult | GraphRebaseControlResult> {
  const repoRoot = deps.logService.repoRoot;
  if (!checkout) throw new Error("Prepare a new rebase plan before starting.");
  await assertRebaseCheckout(repoRoot, checkout);
  const conflicts = new ConflictService(repoRoot);
  const operation = await conflicts.getOperation();
  if (operation === "rebase") {
    logInfo("graph rebase start adopted existing rebase", {
      repoRoot,
      ...(await rebaseProgressLogDetail(repoRoot)),
    });
    return readRebaseControlState(deps, "");
  }
  if (operation !== "none") {
    return {
      status: "failed",
      message: `Cannot start rebase while ${operation} is in progress.`,
    };
  }
  const service = new RebaseService(repoRoot);
  const count = items.length;
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
  return runConflictMutation(repoRoot, async () => {
    const latestOperation = await conflicts.getOperation();
    if (latestOperation !== "none") {
      return { status: "failed", message: `Cannot start rebase while ${latestOperation} is in progress.` };
    }
    logInfo("graph rebase starting", {
      repoRoot,
      base,
      root,
      onto,
      items: items.length,
    });
    const started = Date.now();
    const result = await service.start(
      base,
      root,
      items,
      editorScriptPath(deps.extensionUri),
      onto,
      checkout
    );
    logInfo("graph rebase execution finished", { repoRoot, status: result.status, elapsedMs: Date.now() - started });
    if (result.status === "completed") {
      refreshAfterRebaseControl(deps, "graphRebaseCompleted");
      vscode.window.showInformationMessage(vscode.l10n.t("Rebase completed."));
    } else if (result.status === "conflicts") {
      if (result.restoringLocalChanges && result.message) vscode.window.showWarningMessage(vscode.l10n.t(result.message));
      refreshAfterRebaseControl(deps, "graphRebaseConflict");
      await focusRebaseConflicts(deps.logService.repoRoot);
    } else if (result.status === "paused" && result.paused) {
      refreshAfterRebaseControl(deps, "graphRebaseEditPaused");
      await openPausedEditFile(deps.logService.repoRoot, result.paused, editPath);
      vscode.window.showInformationMessage(
        vscode.l10n.t(
          "Rebase paused for edit. Change files, then Continue to amend this commit."
        )
      );
    } else if (result.status === "stopped") {
      refreshAfterRebaseControl(deps, "graphRebaseStopped");
      logInfo("graph rebase stopped at todo", {
        repoRoot: deps.logService.repoRoot,
        stopped: result.stopped?.hash,
        original: result.stopped?.originalHash,
        message: result.message,
        ...(await rebaseProgressLogDetail(deps.logService.repoRoot)),
      });
    } else if (result.status === "noop") {
      vscode.window.showInformationMessage(vscode.l10n.t("Nothing to rebase."));
    } else if (result.message !== "cancelled") {
      logInfo("graph rebase failed", {
        repoRoot,
        status: result.status,
        message: result.message,
      });
      vscode.window.showErrorMessage(
        vscode.l10n.t("Rebase failed: {0}", result.message ?? "")
      );
    }
    return result;
  });
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
  return runConflictMutation(deps.logService.repoRoot, () =>
    continueGraphRebaseLocked(deps, items, changedHashes)
  );
}

/** 공용 저장소 lease 안에서 graph rebase continue의 전체 준비/실행 단계를 수행한다. */
async function continueGraphRebaseLocked(
  deps: Pick<GraphRebaseDeps, "extensionUri" | "logService" | "refreshGraph">,
  items: RebaseItem[],
  changedHashes: string[]
): Promise<GraphRebaseControlResult> {
  const repoRoot = deps.logService.repoRoot;
  const conflicts = new ConflictService(repoRoot);
  const operation = await conflicts.getOperation();
  const expected = await captureGitOperation(repoRoot);
  logInfo("graph rebase continue requested", {
    repoRoot,
    operation,
    items: items.length,
    changedHashes: changedHashes.length,
    ...(await rebaseProgressLogDetail(repoRoot)),
  });
  if (operation !== "rebase") {
    logInfo("graph rebase continue skipped", {
      repoRoot,
      reason: "noRebaseOperation",
      operation,
    });
    return finishGraphRebaseControl(deps, "continue", false);
  }
  const rebase = new RebaseService(repoRoot);
  const paused = await rebase.getPausedEditState();
  if (paused) {
    logInfo("graph rebase continue paused edit detected", {
      repoRoot,
      paused: paused.hash,
      original: paused.originalHash,
      files: paused.files.length,
    });
    await saveRebaseEditTempDocuments(repoRoot, paused);
  } else {
    logInfo("graph rebase continue paused edit missing", {
      repoRoot,
      ...(await rebaseProgressLogDetail(repoRoot)),
    });
  }
  await assertGitOperation(repoRoot, expected);
  const todo = await updateInProgressRebaseTodo(
    repoRoot,
    items,
    changedHashes,
    paused,
    { editorScript: editorScriptPath(deps.extensionUri) }
  );
  logInfo("graph rebase todo checked before continue", {
    repoRoot,
    changed: todo.changed,
    changedHashes: changedHashes.length,
    missingChangedEditHashes: todo.missingChangedEditHashes.length,
    missingChangedFileHashes: todo.missingChangedFileHashes.length,
    ...(await rebaseProgressLogDetail(repoRoot)),
  });
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
  const messageQueue = await refreshRebaseMessageQueueForContinue(repoRoot, items, {
    includeCurrent: true,
  });
  logInfo("graph rebase message queue refreshed", {
    repoRoot,
    action: "continue",
    active: Boolean(messageQueue),
    queueLength: messageQueue?.queueLength,
    items: items.length,
  });
  const amended = await rebase.amendPausedEditChanges(paused);
  if (amended) {
    logInfo("graph rebase edit commit amended", {
      repoRoot,
      paused: paused?.hash,
      original: paused?.originalHash,
      ...(await rebaseProgressLogDetail(repoRoot)),
    });
  } else {
    logInfo("graph rebase edit commit amend skipped", {
      repoRoot,
      reason: paused ? "noChanges" : "noPausedEdit",
      paused: paused?.hash,
      original: paused?.originalHash,
    });
  }
  try {
    logInfo("graph rebase continue running", {
      repoRoot,
      ...(await rebaseProgressLogDetail(repoRoot)),
    });
    const current = paused ? await assertRebaseEditIdentity(repoRoot, paused, amended) : await captureGitOperation(repoRoot);
    if (!paused) {
      if (!todo.changed || current.generation !== expected.generation || current.head !== expected.head || current.gitDir !== expected.gitDir) {
        await assertGitOperation(repoRoot, expected);
      }
    }
    await conflicts.continueOperation("rebase", current);
  } catch (err) {
    const diagnostics = await readRebaseContinueDiagnostics(repoRoot).catch(() => undefined);
    logError("graph rebase continue failed", err, {
      repoRoot,
      ...(await rebaseProgressLogDetail(repoRoot)),
      ...rebaseDiagnosticLogDetail(diagnostics),
    });
    const state = await readRebaseControlState(deps, "", diagnostics);
    if (state.status === "conflicts") {
      return state;
    }
    if (state.status === "stopped") {
      return state;
    }
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(vscode.l10n.t("Rebase continue failed: {0}", message));
    if (state.status === "paused") {
      return {
        ...state,
        message: state.message || message,
        guidance: state.guidance || rebaseDiagnosticGuidance(diagnostics),
      };
    }
    return {
      status: "failed",
      message: rebaseDiagnosticDetail(diagnostics) || message,
      guidance: rebaseDiagnosticGuidance(diagnostics),
    };
  }
  return finishGraphRebaseControl(deps, "continue");
}

/**
 * 그래프 rebase bar/drawer 에서 현재 rebase todo 항목을 건너뛴다.
 * - skip 뒤에도 Git 이 만든 done/todo 를 다시 읽어 다음 정지 위치나 완료 상태를 UI 에 게시한다.
 * @param deps 그래프 패널 의존성
 */
export async function skipGraphRebase(
  deps: Pick<GraphRebaseDeps, "logService" | "refreshGraph">,
  items: RebaseItem[] = []
): Promise<GraphRebaseControlResult> {
  return runConflictMutation(deps.logService.repoRoot, () =>
    skipGraphRebaseLocked(deps, items)
  );
}

/** 공용 저장소 lease 안에서 graph rebase skip의 확인/queue/실행 단계를 수행한다. */
async function skipGraphRebaseLocked(
  deps: Pick<GraphRebaseDeps, "logService" | "refreshGraph">,
  items: RebaseItem[]
): Promise<GraphRebaseControlResult> {
  const repoRoot = deps.logService.repoRoot;
  const conflicts = new ConflictService(repoRoot);
  if (await conflicts.getOperation() !== "rebase") {
    refreshAfterRebaseControl(deps, "graphRebaseSkipNoop");
    return { status: "completed" };
  }
  const yes = vscode.l10n.t("Skip");
  const expected = await captureGitOperation(repoRoot);
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("Skip the current rebase todo item?"),
    { modal: true },
    yes
  );
  if (choice !== yes) {
    return { status: "failed", message: "cancelled" };
  }
  logInfo("graph rebase skip running", {
    repoRoot,
    ...(await rebaseProgressLogDetail(repoRoot)),
  });
  try {
    await assertGitOperation(repoRoot, expected);
    const messageQueue = await refreshRebaseMessageQueueForContinue(repoRoot, items, {
      includeCurrent: false,
    });
    logInfo("graph rebase message queue refreshed", {
      repoRoot,
      action: "skip",
      active: Boolean(messageQueue),
      queueLength: messageQueue?.queueLength,
      items: items.length,
    });
    await conflicts.skipOperation("rebase", expected);
  } catch (err) {
    logError("graph rebase skip failed", err, {
      repoRoot,
      ...(await rebaseProgressLogDetail(repoRoot)),
    });
    const state = await readRebaseControlState(deps, "");
    if (state.status === "conflicts" || state.status === "paused" || state.status === "stopped") {
      return state;
    }
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(vscode.l10n.t("Rebase skip failed: {0}", message));
    return { status: "failed", message };
  }
  return finishGraphRebaseControl(deps, "continue");
}

/**
 * 그래프 rebase bar/drawer 에서 paused rebase 를 중단한다.
 * - 중단이 끝나면 그래프와 changes 를 갱신하고 웹뷰 rebase edit 모드를 정리한다.
 * @param deps 그래프 패널 의존성
 */
export async function abortGraphRebase(
  deps: Pick<GraphRebaseDeps, "logService" | "refreshGraph">
): Promise<GraphRebaseControlResult> {
  return runConflictMutation(deps.logService.repoRoot, () =>
    abortGraphRebaseLocked(deps)
  );
}

/** 공용 저장소 lease 안에서 graph rebase abort 확인과 복구를 끝까지 수행한다. */
async function abortGraphRebaseLocked(
  deps: Pick<GraphRebaseDeps, "logService" | "refreshGraph">
): Promise<GraphRebaseControlResult> {
  const repoRoot = deps.logService.repoRoot;
  const conflicts = new ConflictService(repoRoot);
  if (await conflicts.getOperation() !== "rebase") {
    return finishGraphRebaseControl(deps, "abort", false);
  }
  const yes = vscode.l10n.t("Abort Rebase");
  const expected = await captureGitOperation(repoRoot);
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("Abort the paused rebase and restore the previous branch state?"),
    { modal: true },
    yes
  );
  if (choice !== yes) {
    return { status: "failed", message: "cancelled" };
  }
  await conflicts.abortOperation("rebase", expected);
  return finishGraphRebaseControl(deps, "abort");
}
