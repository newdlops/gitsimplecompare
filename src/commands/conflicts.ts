// 충돌 해결 명령 핸들러 모듈.
// - 각 핸들러는 ConflictsController(상태/서비스)를 받아 git 작업을 수행한 뒤 새로고침한다.
//   git 세부 동작은 ConflictService 에, UI 갱신은 controller.refresh 에 위임한다.
import * as vscode from "vscode";
import { ConflictService } from "../git/conflictService";
import { PullService } from "../git/pullService";
import { ConflictsController } from "../providers/conflictsController";
import { openMergeEditorUri } from "../ui/mergePresenter";
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
 * 파일을 Git Simple Compare 커스텀 충돌 편집기로 연다.
 * @param controller   충돌 컨트롤러
 * @param extensionUri 확장 루트 URI
 * @param rel          저장소 상대 경로
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
  ConflictPanel.createOrShow(extensionUri, svc, rel, async () => {
    await controller.refresh();
  });
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
  const operation = controller.currentOperation;
  let continued = false;
  try {
    await svc.continueOperation(operation);
    continued = true;
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Could not continue: {0}", errorText(err))
    );
  }
  await controller.refresh();
  if (continued && operation === "merge") {
    await restorePullSnapshotAfterContinue(controller, svc.repoRoot);
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
  try {
    await svc.abortOperation(controller.currentOperation);
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Could not abort: {0}", errorText(err))
    );
  }
  await controller.refresh();
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
  action: (svc: NonNullable<ConflictsController["current"]>) => Promise<void>
): Promise<void> {
  const svc = controller.current;
  if (!svc || !rel) {
    return;
  }
  try {
    await action(svc);
  } catch (err) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Action failed: {0}", errorText(err))
    );
  }
  await controller.refresh();
  await dropPullSnapshotAfterResolvedRestore(controller);
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
