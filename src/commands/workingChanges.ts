// Changes 섹션(작업트리 변경) 관련 명령 — 조회/열기 + 스테이징/커밋 쓰기 작업.
// - 활성 저장소의 상태를 staged/unstaged 로 읽어 CHANGES 뷰에 채우고,
//   파일 클릭 시 staged 는 HEAD ↔ index, unstaged 는 HEAD ↔ 실제 작업 파일 diff 를 연다.
// - Stage/Unstage/Discard/Commit 은 GitService 쓰기 작업에 위임하고, 끝나면 뷰를 새로고친다.
//   로직은 GitService 에 두고 여기서는 "조립 + 사용자 확인/알림"만 담당한다(경계 분리).
import * as vscode from "vscode";
import {
  openHeadVsIndexDiff,
  openHeadVsWorkingTreeDiff,
} from "../ui/diffPresenter";
import { CommandDeps } from "./shared";
import { GitService } from "../git/gitService";

/** 활성 저장소의 GitService 를 반환한다(없으면 undefined). */
function activeService(deps: CommandDeps): GitService | undefined {
  const root = deps.changesView.getActiveRepo();
  return root ? deps.registry.get(root) : undefined;
}

/** 짧은 에러 메시지 추출. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 활성 저장소의 작업트리 변경을 staged/unstaged 로 다시 읽어 Changes 섹션을 갱신한다.
 * @param deps 공유 의존성
 */
export async function refreshWorkingChanges(deps: CommandDeps): Promise<void> {
  const svc = activeService(deps);
  if (!svc) {
    deps.changesView.setStatusGroups({ staged: [], unstaged: [] });
    return;
  }
  try {
    deps.changesView.setStatusGroups(await svc.getStatusGroups());
  } catch {
    deps.changesView.setStatusGroups({ staged: [], unstaged: [] });
  }
}

/**
 * Changes 항목 클릭 시 staged/unstaged 상태에 맞는 비교를 연다.
 * @param arg { root, path, stage } 저장소 루트와 상대 경로, staged/unstaged 구분
 */
export async function openWorkingChange(arg: {
  root: string;
  path: string;
  stage?: "staged" | "unstaged";
  hasStaged?: boolean;
}): Promise<void> {
  if (!arg?.root || !arg?.path) {
    return;
  }
  if (arg.stage === "staged") {
    await openHeadVsIndexDiff(arg.root, arg.path);
    return;
  }
  await openHeadVsWorkingTreeDiff(arg.root, arg.path);
}

/**
 * 작업 파일 자체를 일반 편집기로 연다(비교가 아니라 편집 화면).
 * @param arg { root, path } 저장소 루트와 상대 경로
 */
export async function openFile(arg: {
  root: string;
  path: string;
}): Promise<void> {
  if (!arg?.root || !arg?.path) {
    return;
  }
  const fileUri = vscode.Uri.file(`${arg.root}/${arg.path}`);
  await vscode.commands.executeCommand("vscode.open", fileUri);
}

/**
 * 지정 경로(없으면 전체)를 스테이징한다.
 * @param deps  공유 의존성
 * @param paths 저장소 상대 경로 목록(undefined/빈 배열이면 전체 스테이징)
 */
export async function stageChanges(
  deps: CommandDeps,
  paths?: string[]
): Promise<void> {
  const svc = activeService(deps);
  if (!svc) {
    return;
  }
  try {
    if (paths && paths.length) {
      await svc.stage(paths);
    } else {
      await svc.stageAll();
    }
  } catch (e) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Action failed: {0}", errText(e))
    );
  }
  void refreshWorkingChanges(deps);
}

/**
 * 지정 경로(없으면 전체)의 스테이징을 해제한다.
 * @param deps  공유 의존성
 * @param paths 저장소 상대 경로 목록(undefined/빈 배열이면 전체 해제)
 */
export async function unstageChanges(
  deps: CommandDeps,
  paths?: string[]
): Promise<void> {
  const svc = activeService(deps);
  if (!svc) {
    return;
  }
  try {
    if (paths && paths.length) {
      await svc.unstage(paths);
    } else {
      await svc.unstageAll();
    }
  } catch (e) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Action failed: {0}", errText(e))
    );
  }
  void refreshWorkingChanges(deps);
}

/**
 * 미스테이징 변경을 버린다(되돌리기/삭제). 파괴적이므로 모달로 확인받는다.
 * @param deps  공유 의존성
 * @param paths 버릴 경로 목록(undefined/빈 배열이면 미스테이징 전체)
 */
export async function discardChanges(
  deps: CommandDeps,
  paths?: string[]
): Promise<void> {
  const svc = activeService(deps);
  if (!svc) {
    return;
  }
  let targets = paths;
  if (!targets || !targets.length) {
    const { unstaged } = await svc.getStatusGroups();
    targets = unstaged.map((c) => c.path);
  }
  if (!targets.length) {
    return;
  }
  const confirm =
    targets.length === 1
      ? vscode.l10n.t(
          "Discard changes in '{0}'? This is irreversible.",
          targets[0]
        )
      : vscode.l10n.t(
          "Discard changes in {0} file(s)? This is irreversible.",
          targets.length
        );
  const choice = await vscode.window.showWarningMessage(
    confirm,
    { modal: true },
    vscode.l10n.t("Discard Changes")
  );
  if (!choice) {
    return;
  }
  try {
    await svc.discard(targets);
  } catch (e) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Action failed: {0}", errText(e))
    );
  }
  void refreshWorkingChanges(deps);
}

/**
 * 커밋한다. 스마트 커밋: 스테이징된 변경이 없으면 추적 변경 전체를 스테이징해 커밋한다.
 * @param deps 공유 의존성
 * @param op   커밋 종류:
 *   - commit       스마트 커밋(스테이징 없으면 전체 스테이징 후 커밋)
 *   - staged       스테이징된 것만 커밋
 *   - all          전체 스테이징 후 커밋
 *   - amend*       위와 동일하되 마지막 커밋을 수정(--amend)
 */
export async function commitChanges(
  deps: CommandDeps,
  op:
    | "commit"
    | "staged"
    | "all"
    | "amend"
    | "amendStaged"
    | "amendAll" = "commit"
): Promise<void> {
  const svc = activeService(deps);
  if (!svc) {
    return;
  }
  const amend = op.startsWith("amend");
  const message = deps.changesView.getCommitMessage().trim();
  if (!message && !amend) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Please enter a commit message first.")
    );
    return;
  }
  try {
    const { staged } = await svc.getStatusGroups();
    if ((op === "staged" || op === "amendStaged") && staged.length === 0) {
      vscode.window.showWarningMessage(
        vscode.l10n.t("There are no staged changes to commit.")
      );
      return;
    }
    const stageAllFirst =
      op === "all" ||
      op === "amendAll" ||
      ((op === "commit" || op === "amend") && staged.length === 0);
    if (stageAllFirst) {
      await svc.stageAll();
    }
    await svc.commit(message, { amend });
    deps.changesView.setCommitMessage("");
  } catch (e) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Commit failed: {0}", errText(e))
    );
  }
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges");
}
