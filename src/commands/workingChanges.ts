// Changes 섹션(작업트리 변경) 관련 명령 — 조회/열기 + 스테이징/커밋 쓰기 작업.
// - 활성 저장소의 상태를 staged/unstaged 로 읽어 CHANGES 뷰에 채우고,
//   파일 클릭 시 staged 는 HEAD ↔ index, unstaged 는 HEAD ↔ 남은 unstaged diff 를 연다.
// - Stage/Unstage/Discard/Commit 은 GitService 쓰기 작업에 위임하고, 끝나면 뷰를 새로고친다.
//   로직은 GitService 에 두고 여기서는 "조립 + 사용자 확인/알림"만 담당한다(경계 분리).
import * as vscode from "vscode";
import {
  openHeadVsIndexDiff,
  openHeadVsRemainingUnstagedDiff,
} from "../ui/diffPresenter";
import { CommandDeps } from "./shared";
import { GitService, IgnoreTarget } from "../git/gitService";
import { GitGraphPanel } from "../webview/graphPanel";
import { openConflictEditor } from "./conflicts";
import { logError, logInfo, logWarn } from "../ui/outputLog";

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
 * @param deps 공유 의존성
 * @param arg  { root, path, stage, status } 저장소 루트와 상대 경로, staged/unstaged/충돌 구분
 */
export async function openWorkingChange(deps: CommandDeps, arg: {
  root: string;
  path: string;
  stage?: "staged" | "unstaged";
  hasStaged?: boolean;
  status?: string;
}): Promise<void> {
  if (!arg?.root || !arg?.path) {
    return;
  }
  if (arg.status === "U") {
    await openConflictEditor(
      deps.conflicts,
      deps.extensionUri,
      arg.path,
      arg.root
    );
    return;
  }
  if (arg.stage === "staged") {
    await openHeadVsIndexDiff(arg.root, arg.path);
    return;
  }
  await openHeadVsRemainingUnstagedDiff(arg.root, arg.path);
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
 * 선택 경로를 .gitignore 에 추가한다.
 * - 이미 Git 이 추적 중인 파일은 ignore 만으로 제외되지 않으므로 사용자 확인 뒤
 *   `git rm --cached` 로 다음 커밋부터 빠지게 할 수 있다.
 * @param deps 공유 의존성
 * @param paths ignore 에 추가할 저장소 상대 경로 목록
 */
export async function addToGitignore(
  deps: CommandDeps,
  paths?: string[]
): Promise<void> {
  await addIgnoreRules(deps, "gitignore", paths);
}

/**
 * 선택 경로를 저장소 로컬 exclude(.git/info/exclude)에 추가한다.
 * - exclude 는 커밋되지 않는 로컬 ignore 규칙이므로 개인 작업 파일 제외에 사용한다.
 * @param deps 공유 의존성
 * @param paths exclude 에 추가할 저장소 상대 경로 목록
 */
export async function addToExclude(
  deps: CommandDeps,
  paths?: string[]
): Promise<void> {
  await addIgnoreRules(deps, "exclude", paths);
}

/**
 * ignore/exclude 규칙 추가와 선택적 추적 해제를 조립한다.
 * @param deps 공유 의존성
 * @param target 규칙을 추가할 대상 파일
 * @param paths 대상 경로 목록
 */
async function addIgnoreRules(
  deps: CommandDeps,
  target: IgnoreTarget,
  paths?: string[]
): Promise<void> {
  const svc = activeService(deps);
  if (!svc) {
    return;
  }
  const targets = uniqueNonEmpty(paths ?? []);
  if (!targets.length) {
    return;
  }
  const targetLabel = target === "gitignore" ? ".gitignore" : ".git/info/exclude";
  try {
    const added = await svc.addIgnoreEntries(target, targets);
    logInfo("ignore rules updated", {
      root: svc.repoRoot,
      target,
      requested: targets.length,
      added: added.length,
    });

    const tracked = await svc.trackedPaths(targets);
    if (tracked.length) {
      await confirmAndUntrackIgnoredPaths(svc, targetLabel, tracked);
    } else {
      vscode.window.showInformationMessage(
        added.length
          ? vscode.l10n.t("Added {0} ignore rule(s) to {1}.", added.length, targetLabel)
          : vscode.l10n.t("No new ignore rules were needed in {0}.", targetLabel)
      );
    }
  } catch (e) {
    logError("ignore rules update failed", e, {
      root: svc.repoRoot,
      target,
      requested: targets.length,
    });
    vscode.window.showErrorMessage(
      vscode.l10n.t("Action failed: {0}", errText(e))
    );
  }
  void refreshWorkingChanges(deps);
}

/**
 * 이미 추적 중인 ignore 대상 파일을 인덱스에서 제거할지 사용자에게 확인한다.
 * @param svc 활성 저장소 GitService
 * @param targetLabel 사용자에게 표시할 ignore 파일 이름
 * @param tracked Git 이 이미 추적 중인 경로 목록
 */
async function confirmAndUntrackIgnoredPaths(
  svc: GitService,
  targetLabel: string,
  tracked: string[]
): Promise<void> {
  const stopTracking = vscode.l10n.t("Stop Tracking");
  const keepTracking = vscode.l10n.t("Keep Tracking");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("Exclude {0} already tracked file(s) from future commits?", tracked.length),
    {
      modal: true,
      detail: vscode.l10n.t(
        "Rules in {0} do not affect files Git already tracks. Stop tracking runs git rm --cached and does not rewrite existing commit history.",
        targetLabel
      ),
    },
    stopTracking,
    keepTracking
  );
  if (choice !== stopTracking) {
    logInfo("ignore tracked files kept", {
      root: svc.repoRoot,
      tracked: tracked.length,
    });
    return;
  }

  const result = await svc.untrackPaths(tracked);
  logInfo("ignore tracked files untracked", {
    root: svc.repoRoot,
    removed: result.removed.length,
    skipped: result.skipped.length,
  });
  if (result.skipped.length) {
    logWarn("ignore tracked files skipped because they are conflicted", {
      root: svc.repoRoot,
      skipped: result.skipped,
    });
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Stopped tracking {0} file(s). Skipped {1} conflicted file(s).",
        result.removed.length,
        result.skipped.length
      )
    );
    return;
  }
  vscode.window.showInformationMessage(
    vscode.l10n.t("Stopped tracking {0} file(s).", result.removed.length)
  );
}

/**
 * 빈 문자열을 제거하고 순서를 유지한 고유 경로 목록을 만든다.
 * @param paths 후보 경로 목록
 */
function uniqueNonEmpty(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    out.push(path);
  }
  return out;
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
  let committed = false;
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
    committed = true;
    deps.changesView.setCommitMessage("");
  } catch (e) {
    vscode.window.showErrorMessage(
      vscode.l10n.t("Commit failed: {0}", errText(e))
    );
  }
  if (committed) {
    GitGraphPanel.refreshOpen(svc.repoRoot, "commit");
  }
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", {
    reason: committed ? "commit" : "commitAttempt",
  });
}
