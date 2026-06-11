// 변경 트리뷰의 보기 상태(트리/리스트, 정렬)를 바꾸는 명령 모듈.
// - 보기 상태는 ChangesViewProvider(웹뷰)가, 토글 버튼 노출은 컨텍스트 키가 담당한다.
//   이 모듈은 둘을 함께 갱신해 둘의 상태를 일치시킨다.
import * as vscode from "vscode";
import { CommandDeps } from "./shared";
import { SortKey, ViewMode } from "../providers/changesTreeModel";
import { TreeSection } from "../webview/changesViewProvider";

/** 현재(대표) 보기 모드를 when 절에서 쓰기 위한 컨텍스트 키 이름 */
export const VIEW_MODE_CONTEXT = "gitSimpleCompare.viewMode";

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
