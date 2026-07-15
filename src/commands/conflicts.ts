// 충돌 해결 명령 핸들러 모듈.
// - 각 핸들러는 ConflictsController(상태/서비스)를 받아 git 작업을 수행한 뒤 새로고침한다.
//   git 세부 동작은 ConflictService 에, UI 갱신은 controller.refresh 에 위임한다.
import * as vscode from "vscode";
import { ConflictService } from "../git/conflictService";
import { tryAcquireConflictMutation } from "../git/conflictMutationCoordinator";
import { PullService } from "../git/pullService";
import { listRebaseEditTempPaths } from "../git/rebaseEditSession";
import { RebaseService } from "../git/rebaseService";
import type { RebasePausedState } from "../git/rebaseService";
import {
  dropRebaseStashesAfterResolvedRestore,
  finishDeferredCommitRebaseAfterContinue,
  finishRebaseAfterContinue,
  publishRebaseContinueConflict,
  publishRebaseContinueState,
  restoreDeferredCommitRebaseAfterAbort,
  restoreRebaseAfterAbort,
} from "./rebaseConflictFollowup";
import { ConflictsController } from "../providers/conflictsController";
import { openMergeEditorUri } from "../ui/mergePresenter";
import { logInfo } from "../ui/outputLog";
import { ConflictPanel } from "../webview/conflictPanel";

/**
 * 충돌 목록을 다시 읽어 갱신한다.
 * @param controller 충돌 컨트롤러
 */
export async function refreshConflicts(
  controller: ConflictsController
): Promise<void> {
  await controller.refresh();
}

/**
 * 선택한 파일을 우리쪽(--ours) 버전으로 확정한다.
 * @param controller 충돌 컨트롤러
 * @param rel        트리에서 전달된 저장소 상대 경로
 */
export async function takeOurs(
  controller: ConflictsController,
  rel: string
): Promise<void> {
  await runFileAction(controller, rel, (svc) => svc.takeOurs(rel));
}

/**
 * 선택한 파일을 상대쪽(--theirs) 버전으로 확정한다.
 * @param controller 충돌 컨트롤러
 * @param rel        저장소 상대 경로
 */
export async function takeTheirs(
  controller: ConflictsController,
  rel: string
): Promise<void> {
  await runFileAction(controller, rel, (svc) => svc.takeTheirs(rel));
}

/**
 * 선택한 파일을 Current 버전으로 확정한다.
 * - UI 용어로는 Current 이고, git index stage 로는 ours(stage 2)를 뜻한다.
 * @param controller 충돌 컨트롤러
 * @param rel        저장소 상대 경로
 */
export async function takeCurrent(
  controller: ConflictsController,
  rel: string
): Promise<void> {
  await runFileAction(controller, rel, (svc) => svc.acceptCurrent(rel));
}

/**
 * 선택한 파일을 Incoming 버전으로 확정한다.
 * - UI 용어로는 Incoming 이고, git index stage 로는 theirs(stage 3)를 뜻한다.
 * @param controller 충돌 컨트롤러
 * @param rel        저장소 상대 경로
 */
export async function takeIncoming(
  controller: ConflictsController,
  rel: string
): Promise<void> {
  await runFileAction(controller, rel, (svc) => svc.acceptIncoming(rel));
}

/**
 * 선택한 파일을 Current + Incoming 모두 보존하는 결과로 확정한다.
 * @param controller 충돌 컨트롤러
 * @param rel        저장소 상대 경로
 */
export async function takeBoth(
  controller: ConflictsController,
  rel: string
): Promise<void> {
  await runFileAction(controller, rel, (svc) => svc.acceptBoth(rel));
}

/**
 * 수동 편집으로 해결한 파일을 스테이징해 해결됨으로 표시한다.
 * @param controller 충돌 컨트롤러
 * @param rel        저장소 상대 경로
 */
export async function markResolved(
  controller: ConflictsController,
  rel: string
): Promise<void> {
  await runFileAction(controller, rel, (svc) => svc.markResolved(rel));
}

/**
 * 파일을 VS Code 내장 3-way 머지 에디터로 연다.
 * - 내장 Git 확장 명령에 위임하고, 실패하면 일반 편집기로 연다(폴백).
 * @param controller 충돌 컨트롤러
 * @param rel        저장소 상대 경로
 */
export async function openMergeEditor(
  controller: ConflictsController,
  rel: string
): Promise<void> {
  const svc = controller.current;
  if (!svc) {
    return;
  }
  const uri = vscode.Uri.file(svc.absPath(rel));
  await openMergeEditorUri(uri);
}

/**
 * 파일을 commit/rebase 문맥이 보강된 충돌 해결 패널로 연다.
 * - 트리 항목에서 직접 호출될 수 있어 repoRoot 를 받으면 해당 저장소 기준 서비스를 만든다.
 * - 내장 merge editor는 패널 안의 보조 액션과 별도 명령으로 계속 사용할 수 있다.
 * @param controller   충돌 컨트롤러
 * @param extensionUri 확장 루트 URI
 * @param rel          저장소 상대 경로
 * @param repoRoot     명령 인자로 전달된 저장소 루트
 */
export async function openConflictEditor(
  controller: ConflictsController,
  extensionUri: vscode.Uri,
  rel: string,
  repoRoot?: string
): Promise<void> {
  if (!rel) {
    return;
  }
  const svc = repoRoot ? new ConflictService(repoRoot) : controller.current;
  if (!svc) {
    return;
  }
  await ConflictPanel.createOrShow(extensionUri, svc, rel, () => controller.refresh());
}

/**
 * 진행 중인 작업(merge/rebase 등)을 이어서 진행한다.
 * - 아직 충돌이 남아 실패하면 오류를 알리고 목록을 갱신한다.
 * @param controller 충돌 컨트롤러
 */
export async function continueOperation(
  controller: ConflictsController
): Promise<void> {
  const svc = controller.current;
  if (!svc) {
    return;
  }
  const release = acquireConflictMutationOrNotify(svc.repoRoot);
  if (!release) return;
  try {
    const operation = controller.currentOperation;
    let continued = false;
    try {
      if (operation === "rebase") {
        await amendPausedRebaseEditBeforeContinue(svc.repoRoot);
      }
      await svc.continueOperation(operation);
      continued = true;
    } catch (err) {
      if (operation === "rebase" && await publishRebaseContinueConflict(svc.repoRoot)) {
        continued = true;
      } else {
        vscode.window.showErrorMessage(
          vscode.l10n.t("Could not continue: {0}", errorText(err))
        );
      }
    }
    await controller.refresh();
    if (continued && operation === "merge") {
      await restorePullSnapshotAfterContinue(controller, svc.repoRoot);
    } else if (continued && operation === "rebase") {
      await finishRebaseAfterContinue(controller, svc.repoRoot);
      await publishRebaseContinueState(svc.repoRoot);
    } else if (continued && (operation === "cherry-pick" || operation === "revert")) {
      await finishDeferredCommitRebaseAfterContinue(controller, svc.repoRoot);
    }
  } finally {
    release();
  }
}

/**
 * 진행 중인 작업을 취소(abort)한다. 되돌릴 수 없으므로 한 번 확인받는다.
 * @param controller 충돌 컨트롤러
 */
export async function abortOperation(
  controller: ConflictsController
): Promise<void> {
  const svc = controller.current;
  if (!svc) {
    return;
  }
  const yes = vscode.l10n.t("Abort");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("Abort the current {0}? Changes from it will be discarded.", controller.currentOperation),
    { modal: true },
    yes
  );
  if (choice !== yes) {
    return;
  }
  const release = acquireConflictMutationOrNotify(svc.repoRoot);
  if (!release) return;
  try {
    const operation = controller.currentOperation;
    let aborted = false;
    try {
      await svc.abortOperation(operation);
      aborted = true;
    } catch (err) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("Could not abort: {0}", errorText(err))
      );
    }
    if (aborted && operation === "rebase") {
      await restoreRebaseAfterAbort(svc.repoRoot);
    } else if (aborted && (operation === "cherry-pick" || operation === "revert")) {
      await restoreDeferredCommitRebaseAfterAbort(svc.repoRoot);
    }
    await controller.refresh();
  } finally {
    release();
  }
}

/**
 * 진행 중인 rebase 의 현재 todo 항목을 건너뛴다.
 * - Git 이 만든 rebase 상태를 그대로 유지하고, skip 뒤 다음 정지/완료 상태를 그래프 UI 에 다시 게시한다.
 * @param controller 충돌 컨트롤러
 */
export async function skipOperation(
  controller: ConflictsController
): Promise<void> {
  const svc = controller.current;
  if (!svc) {
    return;
  }
  const operation = controller.currentOperation;
  if (operation !== "rebase") {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Skip is only available while a rebase is in progress.")
    );
    return;
  }
  const yes = vscode.l10n.t("Skip");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("Skip the current rebase todo item?"),
    { modal: true },
    yes
  );
  if (choice !== yes) {
    return;
  }
  const release = acquireConflictMutationOrNotify(svc.repoRoot);
  if (!release) return;
  try {
    let skipped = false;
    try {
      await svc.skipOperation(operation);
      skipped = true;
    } catch (err) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("Could not skip: {0}", errorText(err))
      );
    }
    await controller.refresh();
    if (skipped) {
      await finishRebaseAfterContinue(controller, svc.repoRoot);
      await publishRebaseContinueState(svc.repoRoot);
    }
  } finally {
    release();
  }
}

/**
 * 충돌이 난 pull 을 pull 직전 HEAD/작업트리 상태로 되돌린다.
 * @param controller 충돌 컨트롤러
 */
export async function rollbackPull(
  controller: ConflictsController
): Promise<void> {
  const svc = controller.current;
  if (!svc) {
    return;
  }
  const service = new PullService(svc.repoRoot);
  const snapshot = await service.findLatestPullRollbackSnapshot();
  if (!snapshot) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("No pull rollback snapshot found.")
    );
    return;
  }
  const yes = vscode.l10n.t("Rollback Pull");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Rollback pull and restore local changes from before pull? Current conflict-resolution edits will be discarded."
    ),
    { modal: true },
    yes
  );
  if (choice !== yes) {
    return;
  }
  const release = acquireConflictMutationOrNotify(svc.repoRoot);
  if (!release) return;
  try {
    try {
      await service.rollbackLatestPull();
      vscode.window.showInformationMessage(
        vscode.l10n.t("Pull was rolled back to the pre-pull state.")
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("Could not rollback pull: {0}", errorText(err))
      );
    }
    await controller.refresh();
    void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason: "pullRollback",
    });
  } finally {
    release();
  }
}

/**
 * 파일 단위 동작을 실행한 뒤 목록을 새로고침하는 공통 래퍼.
 * @param controller 충돌 컨트롤러
 * @param rel        대상 경로(로깅/가드용)
 * @param action     ConflictService 로 수행할 동작
 */
async function runFileAction(
  controller: ConflictsController,
  rel: string,
  action: (svc: NonNullable<ConflictsController["current"]>) => Promise<void | string | undefined>
): Promise<void> {
  const svc = controller.current;
  if (!svc || !rel) {
    return;
  }
  const release = acquireConflictMutationOrNotify(svc.repoRoot);
  if (!release) return;
  try {
    try {
      const recoveryPath = await action(svc);
      if (recoveryPath) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            "Conflict Result was applied, but a concurrent edit to the previous file was preserved at {0}. Review it before continuing.",
            recoveryPath
          )
        );
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        vscode.l10n.t("Action failed: {0}", errorText(err))
      );
    }
    await controller.refresh();
    await vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
      reason: "conflictFileAction",
    });
    await dropPullSnapshotAfterResolvedRestore(controller);
    await dropRebaseStashesAfterResolvedRestore(controller);
  } finally {
    release();
  }
}

/**
 * 충돌 mutation 공용 lease를 얻고 이미 사용 중이면 사용자에게 재시도를 안내한다.
 * @param repoRoot 대상 저장소 루트
 * @returns 성공 시 finally에서 호출할 release 함수
 */
function acquireConflictMutationOrNotify(repoRoot: string): (() => void) | undefined {
  const release = tryAcquireConflictMutation(repoRoot);
  if (!release) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t("A conflict action is still running. Try again when it finishes.")
    );
  }
  return release;
}

/**
 * rebase edit 정지 상태에서 일반 Continue 버튼을 눌렀을 때도 그래프 rebase 편집 내용을 amend 한다.
 * - 그래프 전용 Continue 경로와 달리 Conflicts 뷰/명령 팔레트의 Continue 는 git continue 만 실행하므로
 *   여기서 dirty 임시 문서를 저장하고 paused commit 을 먼저 갱신한다.
 * @param repoRoot 대상 저장소 루트
 * @returns amend 로 커밋이 실제 갱신되었으면 true
 */
async function amendPausedRebaseEditBeforeContinue(
  repoRoot: string
): Promise<boolean> {
  const service = new RebaseService(repoRoot);
  const paused = await service.getPausedEditState();
  if (!paused) {
    logInfo("conflicts rebase paused edit amend skipped", {
      repoRoot,
      reason: "noPausedEdit",
    });
    return false;
  }
  const savedDocs = await saveRebaseEditTempDocuments(repoRoot, paused);
  const amended = await service.amendPausedEditChanges(paused);
  logInfo("conflicts rebase paused edit continue prepared", {
    repoRoot,
    paused: paused.hash,
    original: paused.originalHash,
    savedDocs,
    amended,
  });
  return amended;
}

/**
 * Continue 직전에 VS Code 에 열려 있는 rebase edit 임시 문서의 dirty 내용을 저장한다.
 * @param repoRoot 대상 저장소 루트
 * @param paused 현재 rebase edit 정지 상태
 * @returns 저장한 dirty 문서 수
 */
async function saveRebaseEditTempDocuments(
  repoRoot: string,
  paused: RebasePausedState
): Promise<number> {
  const paths = new Set(listRebaseEditTempPaths(repoRoot, paused));
  const docs = vscode.workspace.textDocuments.filter(
    (doc) => doc.isDirty && doc.uri.scheme === "file" && paths.has(doc.uri.fsPath)
  );
  await Promise.all(docs.map((doc) => doc.save()));
  return docs.length;
}

/**
 * pull merge 충돌이 continue 로 해결된 뒤 임시 stash 를 복원하고 정리한다.
 * @param controller 충돌 컨트롤러
 * @param repoRoot   대상 저장소 루트
 */
async function restorePullSnapshotAfterContinue(
  controller: ConflictsController,
  repoRoot: string
): Promise<void> {
  const result = await new PullService(repoRoot).restoreSnapshotAfterResolvedPull();
  if (result.status === "none") {
    return;
  }
  if (result.status === "restored") {
    vscode.window.showInformationMessage(
      vscode.l10n.t("Local changes restored after pull.")
    );
  } else if (result.status === "conflicts") {
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Pull conflicts were resolved, but restoring local changes caused conflicts."
      )
    );
    await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
  }
  await controller.refresh();
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "pullSnapshotCleanup",
  });
}

/**
 * stash apply 충돌 해결이 끝났으면 이미 반영된 rollback stash 를 제거한다.
 * @param controller 충돌 컨트롤러
 */
async function dropPullSnapshotAfterResolvedRestore(
  controller: ConflictsController
): Promise<void> {
  const svc = controller.current;
  if (!svc) {
    return;
  }
  const result = await new PullService(
    svc.repoRoot
  ).dropSnapshotAfterResolvedRestore();
  if (result.status !== "dropped") {
    return;
  }
  vscode.window.showInformationMessage(
    vscode.l10n.t("Pull rollback snapshot cleaned.")
  );
  await controller.refresh();
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: "pullSnapshotCleanup",
  });
}

/** 오류 객체에서 사람이 읽을 메시지를 뽑는다. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
