// Changes의 보기 상태(트리/리스트, 정렬)와 내장 Git 사용 설정을 바꾸는 명령 모듈.
// - 보기 상태는 ChangesViewProvider(웹뷰)가, 토글 버튼 노출은 컨텍스트 키가 담당한다.
//   이 모듈은 둘을 함께 갱신해 둘의 상태를 일치시킨다.
import * as vscode from "vscode";
import { CommandDeps } from "./shared";
import { logInfo, showErrorWithOutput } from "../ui/outputLog";
import { SortKey, ViewMode } from "../providers/changesTreeModel";
import {
  TreeSection,
  VISIBLE_SECTIONS,
  VisibleSection,
} from "../webview/changesViewProvider";

/** 현재(대표) 보기 모드를 when 절에서 쓰기 위한 컨텍스트 키 이름 */
export const VIEW_MODE_CONTEXT = "gitSimpleCompare.viewMode";
const SECTION_VISIBLE_CONTEXT_PREFIX = "gitSimpleCompare.section";
let builtinGitUpdatePending = false;

/**
 * 현재 워크스페이스의 VS Code 내장 Git 사용 여부를 반전한다.
 * - git.enabled를 직접 저장해 내장 Git의 감시·자동 조회를 함께 중단하거나 재개한다.
 * - 사용자 전역 설정은 건드리지 않으며, 폴더별 명시적 override도 같은 값으로 맞춘다.
 * - 저장 중 중복 호출은 무시해 클릭 연타가 재개로 뒤집히지 않게 한다.
 * - 설정 변경 이벤트가 Changes를 자체 CLI 조회로 전환하므로 화면을 숨기는 토글과 구분된다.
 * @returns 설정 저장 또는 오류 알림 처리가 끝나면 완료되는 Promise
 */
export async function toggleBuiltinGit(): Promise<void> {
  if (builtinGitUpdatePending) {
    logInfo("vscode git setting update skipped", { reason: "update-pending" });
    return;
  }
  if (!vscode.workspace.workspaceFolders?.length) {
    logInfo("vscode git setting update skipped", { reason: "no-workspace" });
    void vscode.window.showInformationMessage(
      vscode.l10n.t("Open a folder or workspace to control VS Code built-in Git.")
    );
    return;
  }

  const config = vscode.workspace.getConfiguration("git");
  const enabled = !builtinGitEnabledInWorkspace();
  const folderConfigs = vscode.workspace.workspaceFolders
    .map((folder) => vscode.workspace.getConfiguration("git", folder.uri))
    .filter((folderConfig) =>
      folderConfig.inspect<boolean>("enabled")?.workspaceFolderValue !== undefined
    );
  builtinGitUpdatePending = true;
  try {
    await vscode.commands.executeCommand("setContext", "gitSimpleCompare.builtinGit.busy", true);
    await config.update("enabled", enabled, vscode.ConfigurationTarget.Workspace);
    for (const folderConfig of folderConfigs) {
      await folderConfig.update("enabled", enabled, vscode.ConfigurationTarget.WorkspaceFolder);
    }
    logInfo("vscode git setting updated", {
      enabled, scope: "workspace", folderOverrides: folderConfigs.length,
    });
    void vscode.window.showInformationMessage(
      enabled
        ? vscode.l10n.t("VS Code built-in Git started for this workspace.")
        : vscode.l10n.t("VS Code built-in Git stopped for this workspace. Git Simple Compare remains active.")
    );
  } catch (error) {
    showErrorWithOutput(
      "vscode git setting update failed", error,
      vscode.l10n.t("Could not change VS Code built-in Git. See Git Simple Compare Output for details."),
      { enabled, scope: "workspace" }
    );
  } finally {
    builtinGitUpdatePending = false;
    syncBuiltinGitContext();
    await vscode.commands.executeCommand("setContext", "gitSimpleCompare.builtinGit.busy", false);
  }
}

/**
 * 워크스페이스 또는 일부 폴더에서 실행 중인 내장 Git을 하나의 체크 상태로 표시한다.
 * - 폴더 override가 켜져 있으면 워크스페이스 값이 false여도 중단 액션을 제공한다.
 * @returns 반환값 없이 native Changes 메뉴의 context key를 최신 설정에 맞춘다.
 */
export function syncBuiltinGitContext(): void {
  void vscode.commands.executeCommand(
    "setContext", "gitSimpleCompare.builtinGit.enabled", builtinGitEnabledInWorkspace()
  );
}

/**
 * 현재 워크스페이스 범위 중 하나라도 내장 Git이 켜져 있는지 확인한다.
 * @returns 워크스페이스 기본값 또는 폴더별 유효 설정이 true이면 true
 */
function builtinGitEnabledInWorkspace(): boolean {
  return vscode.workspace.getConfiguration("git").get<boolean>("enabled", true) ||
    !!vscode.workspace.workspaceFolders?.some((folder) =>
      vscode.workspace.getConfiguration("git", folder.uri).get<boolean>("enabled", true)
    );
}

/**
 * 상단 툴바의 전역 토글 — 모든 트리 섹션을 같은 보기 모드로 맞추고 컨텍스트 키도 갱신한다.
 * - view/title 의 "트리로 보기 / 목록으로 보기" 버튼 노출이 컨텍스트 키로 토글된다.
 * - 섹션별 토글과 달리, 이 버튼은 Compare/Changes 를 한꺼번에 바꾼다.
 * @param deps 공유 의존성
 * @param mode 적용할 보기 모드
 */
export function setViewMode(deps: CommandDeps, mode: ViewMode): void {
  deps.changesView.setAllViewModes(mode);
  void vscode.commands.executeCommand("setContext", VIEW_MODE_CONTEXT, mode);
}

/**
 * 특정 섹션의 보기 모드만 토글한다(웹뷰 섹션 헤더의 트리/리스트 버튼).
 * - 토글 후 대표 모드를 컨텍스트 키에 다시 동기화해 툴바 아이콘이 어긋나지 않게 한다.
 * @param deps    공유 의존성
 * @param section 토글할 섹션("compare" | "changes")
 */
export function toggleSectionViewMode(
  deps: CommandDeps,
  section: TreeSection
): void {
  const next = deps.changesView.getViewMode(section) === "tree" ? "list" : "tree";
  deps.changesView.setViewMode(section, next);
  syncViewContext(deps);
}

/** 최상위 view/title 메뉴에서 아코디언 섹션 표시 여부를 토글한다. */
export function toggleVisibleSection(
  deps: CommandDeps,
  section: VisibleSection
): void {
  deps.changesView.toggleVisibleSection(section);
  syncSectionVisibilityContext(deps);
}

/**
 * 대표 보기 모드를 컨텍스트 키에 한 번 동기화한다(활성화 시 + 섹션 토글 후).
 * @param deps 공유 의존성
 */
export function syncViewContext(deps: CommandDeps): void {
  void vscode.commands.executeCommand(
    "setContext",
    VIEW_MODE_CONTEXT,
    deps.changesView.getRepresentativeViewMode()
  );
  syncSectionVisibilityContext(deps);
  syncBuiltinGitContext();
}

/** 아코디언 섹션 표시 상태를 view/title 메뉴 when 절에 맞춰 동기화한다. */
function syncSectionVisibilityContext(deps: CommandDeps): void {
  const visible = deps.changesView.getVisibleSections();
  for (const section of VISIBLE_SECTIONS) {
    void vscode.commands.executeCommand(
      "setContext",
      `${SECTION_VISIBLE_CONTEXT_PREFIX}.${section}.visible`,
      visible[section]
    );
  }
}

/**
 * 정렬 기준을 고르는 QuickPick 을 띄우고 선택을 적용한다.
 * - 현재 적용 중인 기준에는 "current" 표시를 붙인다.
 * @param deps 공유 의존성
 */
export async function changeSortOrder(deps: CommandDeps): Promise<void> {
  const current = deps.changesView.getSortKey();
  const options: { key: SortKey; label: string }[] = [
    { key: "name", label: vscode.l10n.t("Sort by Name") },
    { key: "path", label: vscode.l10n.t("Sort by Path") },
    { key: "status", label: vscode.l10n.t("Sort by Status") },
  ];

  const picked = await vscode.window.showQuickPick(
    options.map((o) => ({
      label: o.label,
      description: o.key === current ? vscode.l10n.t("current") : undefined,
      key: o.key,
    })),
    { placeHolder: vscode.l10n.t("Select sort order") }
  );
  if (picked) {
    deps.changesView.setSortKey(picked.key);
  }
}
