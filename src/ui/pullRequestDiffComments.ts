// PR preview 에서 연 editable diff 오른쪽 파일에 review comment 를 decoration 으로 표시한다.
// - VS Code comment API thread 를 만들지는 않고, diff 편집 흐름을 방해하지 않는 after decoration 으로 보여준다.
import * as vscode from "vscode";

export interface PullRequestDiffComment {
  author: string;
  body: string;
  line?: number;
  originalLine?: number;
}

let activeDecoration: vscode.TextEditorDecorationType | undefined;

/**
 * 현재 열리는 editable diff 의 작업 파일에 PR review comment 를 표시한다.
 * @param fileUri 오른쪽 editable 파일 URI
 * @param comments 파일에 달린 PR review comment 목록
 */
export function showPullRequestDiffComments(
  fileUri: vscode.Uri,
  comments: PullRequestDiffComment[]
): void {
  activeDecoration?.dispose();
  activeDecoration = undefined;
  const visible = comments.filter((comment) => comment.line || comment.originalLine);
  if (!visible.length) {
    return;
  }
  activeDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      margin: "0 0 0 1.25rem",
      color: new vscode.ThemeColor("descriptionForeground"),
      fontStyle: "italic",
    },
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.infoForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  scheduleApply(fileUri, visible, 250);
  scheduleApply(fileUri, visible, 900);
}

/** diff editor 가 열린 뒤 보이는 editor 에 decoration 을 적용한다. */
function scheduleApply(
  fileUri: vscode.Uri,
  comments: PullRequestDiffComment[],
  delay: number
): void {
  setTimeout(() => applyComments(fileUri, comments), delay);
}

/** 현재 visible editor 중 대상 파일에 comment decoration 을 적용한다. */
function applyComments(fileUri: vscode.Uri, comments: PullRequestDiffComment[]): void {
  if (!activeDecoration) {
    return;
  }
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() !== fileUri.toString()) {
      continue;
    }
    editor.setDecorations(activeDecoration, comments.map(commentDecoration));
  }
}

/** comment 한 건을 VS Code decoration option 으로 변환한다. */
function commentDecoration(comment: PullRequestDiffComment): vscode.DecorationOptions {
  const line = Math.max(0, (comment.line || comment.originalLine || 1) - 1);
  const text = `${comment.author}: ${firstLine(comment.body)}`;
  return {
    range: new vscode.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER),
    renderOptions: { after: { contentText: `  [comment] ${text}` } },
  };
}

/** decoration 에 넣을 comment 본문 첫 줄을 만든다. */
function firstLine(text: string): string {
  const line = (text || "").replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
