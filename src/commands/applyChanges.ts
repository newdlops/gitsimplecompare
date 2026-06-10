// 기능: diff 창에서 좌측(브랜치 버전)의 내용을 우측(작업파일)에 한 번에 반영한다.
// - WorkspaceEdit 로 전체 내용을 교체하므로 저장 전까지 검토/실행취소(Undo)가 가능하다.
//   (디스크에 직접 쓰지 않아 "비교하면서 편집" 흐름을 깨지 않는다.)
import * as vscode from "vscode";
import { COMPARE_SCHEME } from "../utils/uri";

/**
 * 활성 diff 의 좌측 내용을 우측 작업파일에 통째로 적용한다.
 * - 활성 탭이 우리 파일↔브랜치 diff 가 아니면 안내 후 종료한다.
 * - 차이가 없으면 알리고 종료, 있으면 모달로 한 번 확인받은 뒤 교체한다.
 */
export async function applyLeftToRight(): Promise<void> {
  const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input;
  if (!(input instanceof vscode.TabInputTextDiff)) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Open a Git Simple Compare diff first.")
    );
    return;
  }

  const { original, modified } = input;
  // 좌측이 가상 문서(브랜치)이고 우측이 실제 파일일 때만 의미가 있다.
  if (original.scheme !== COMPARE_SCHEME || modified.scheme !== "file") {
    vscode.window.showWarningMessage(
      vscode.l10n.t("This action only works on a file-vs-branch comparison.")
    );
    return;
  }

  const leftDoc = await vscode.workspace.openTextDocument(original);
  const rightDoc = await vscode.workspace.openTextDocument(modified);
  const leftText = leftDoc.getText();
  if (rightDoc.getText() === leftText) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("No differences to apply.")
    );
    return;
  }

  const applyLabel = vscode.l10n.t("Apply");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Replace the entire working file with the branch version? You can still undo or review before saving."
    ),
    { modal: true },
    applyLabel
  );
  if (choice !== applyLabel) {
    return;
  }

  // 우측 문서 전체 범위를 좌측 내용으로 교체한다.
  const edit = new vscode.WorkspaceEdit();
  const lastLine = Math.max(rightDoc.lineCount - 1, 0);
  const fullRange = new vscode.Range(
    new vscode.Position(0, 0),
    rightDoc.lineAt(lastLine).range.end
  );
  edit.replace(modified, fullRange, leftText);
  await vscode.workspace.applyEdit(edit);

  vscode.window.showInformationMessage(
    vscode.l10n.t("Applied. Review and save the file to keep the changes.")
  );
}
