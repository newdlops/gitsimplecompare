// 현재 활성 탭이 "이 확장이 연 파일↔브랜치 diff"인지 추적해 컨텍스트 키를 갱신하는 모듈.
// - editor/title 의 "좌→우 반영" 버튼은 이 컨텍스트 키(gitSimpleCompare.activeDiff)가
//   true 일 때만 보이도록 한다(브랜치↔브랜치 읽기전용 diff 에서는 숨김).
import * as vscode from "vscode";
import { COMPARE_SCHEME } from "../utils/uri";
import { hunkDiffTargetFromTab, isHunkDiffTab } from "./hunkDiffContext";

/** "좌→우 반영"이 가능한 diff 가 활성화됐는지 나타내는 컨텍스트 키 이름 */
export const ACTIVE_DIFF_CONTEXT = "gitSimpleCompare.activeDiff";
/** hunk stage/discard 가 working tree diff 에서 동작할 수 있는지 나타낸다. */
export const ACTIVE_HEAD_WORKING_DIFF_CONTEXT =
  "gitSimpleCompare.activeHeadWorkingDiff";
/** unstaged hunk diff 가 활성화됐는지 나타낸다. */
export const ACTIVE_UNSTAGED_HUNK_DIFF_CONTEXT =
  "gitSimpleCompare.activeUnstagedHunkDiff";
/** staged hunk diff 가 활성화됐는지 나타낸다. */
export const ACTIVE_STAGED_HUNK_DIFF_CONTEXT =
  "gitSimpleCompare.activeStagedHunkDiff";

/**
 * 활성 탭 변화를 감지해 ACTIVE_DIFF_CONTEXT 컨텍스트 키를 갱신한다.
 * - 좌측이 우리 가상 문서(COMPARE_SCHEME)이고 우측이 실제 파일(file)일 때만 true.
 *   즉 "편집 가능한 작업파일" 쪽이 있는 비교에서만 반영 버튼을 노출한다.
 * @returns 등록된 리스너들을 정리하는 Disposable
 */
export function registerActiveDiffTracker(): vscode.Disposable {
  const update = (): void => {
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const hunkTarget = hunkDiffTargetFromTab(tab);
    void vscode.commands.executeCommand(
      "setContext",
      ACTIVE_DIFF_CONTEXT,
      isApplicableDiff(tab)
    );
    void vscode.commands.executeCommand(
      "setContext",
      ACTIVE_HEAD_WORKING_DIFF_CONTEXT,
      isHunkDiffTab(tab)
    );
    void vscode.commands.executeCommand(
      "setContext",
      ACTIVE_UNSTAGED_HUNK_DIFF_CONTEXT,
      hunkTarget?.stage === "unstaged"
    );
    void vscode.commands.executeCommand(
      "setContext",
      ACTIVE_STAGED_HUNK_DIFF_CONTEXT,
      hunkTarget?.stage === "staged"
    );
  };

  update(); // 활성화 직후 현재 상태를 한 번 반영
  return vscode.Disposable.from(
    vscode.window.tabGroups.onDidChangeTabs(update),
    vscode.window.tabGroups.onDidChangeTabGroups(update),
    vscode.window.onDidChangeActiveTextEditor(update)
  );
}

/**
 * 주어진 탭이 "좌=가상문서, 우=실제 파일"인 diff 인지 판별한다.
 * @param tab 검사할 탭(없을 수 있음)
 */
function isApplicableDiff(tab: vscode.Tab | undefined): boolean {
  const input = tab?.input;
  return (
    input instanceof vscode.TabInputTextDiff &&
    input.original.scheme === COMPARE_SCHEME &&
    input.modified.scheme === "file"
  );
}
