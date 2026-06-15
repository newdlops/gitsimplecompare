// PR preview 에서 연 editable diff 오른쪽 파일에 review comment 를 decoration 으로 표시한다.
// - VS Code comment API thread 를 만들지는 않고, diff 편집 흐름을 방해하지 않는 after decoration 으로 보여준다.
import * as vscode from "vscode";

export interface PullRequestDiffComment {
  author: string;
  body: string;
  line?: number;
  originalLine?: number;
  createdAt?: string;
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
      margin: "0 0 0 0.65rem",
      width: "14px",
      height: "14px",
      color: new vscode.ThemeColor("button.foreground"),
      backgroundColor: new vscode.ThemeColor("button.background"),
      border: "1px solid",
      borderColor: new vscode.ThemeColor("focusBorder"),
      fontWeight: "700",
      textDecoration: "none; display: inline-block; font-family: codicon; font-size: 12px; line-height: 14px; text-align: center; padding: 0 2px; border-radius: 999px; transform: scale(1.35); transform-origin: center",
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
    editor.setDecorations(activeDecoration, groupedComments(comments).map(commentDecoration));
  }
}

/** comment 한 건을 VS Code decoration option 으로 변환한다. */
function commentDecoration(group: { line: number; comments: PullRequestDiffComment[] }): vscode.DecorationOptions {
  return {
    range: new vscode.Range(group.line, Number.MAX_SAFE_INTEGER, group.line, Number.MAX_SAFE_INTEGER),
    hoverMessage: hoverMarkdown(group.comments),
    renderOptions: { after: { contentText: "\ueac7" } },
  };
}

/** 같은 라인의 comment 를 하나의 inlay icon 으로 묶는다. */
function groupedComments(comments: PullRequestDiffComment[]): Array<{ line: number; comments: PullRequestDiffComment[] }> {
  const byLine = new Map<number, PullRequestDiffComment[]>();
  for (const comment of comments) {
    const line = Math.max(0, (comment.line || comment.originalLine || 1) - 1);
    const list = byLine.get(line) || [];
    list.push(comment);
    byLine.set(line, list);
  }
  return Array.from(byLine.entries())
    .sort(([a], [b]) => a - b)
    .map(([line, list]) => ({ line, comments: list }));
}

/** hover 에서 상세 comment 본문을 markdown 으로 보여준다. */
function hoverMarkdown(comments: PullRequestDiffComment[]): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.supportHtml = false;
  markdown.isTrusted = false;
  comments.forEach((comment, index) => {
    if (index) {
      markdown.appendMarkdown("\n\n---\n\n");
    }
    markdown.appendMarkdown(`**${escapeMarkdown(comment.author || "unknown")}**`);
    if (comment.createdAt) {
      markdown.appendMarkdown(`  ${escapeMarkdown(formatDate(comment.createdAt))}`);
    }
    markdown.appendMarkdown("\n\n");
    markdown.appendMarkdown(comment.body?.trim() || "_No comment body._");
  });
  return markdown;
}

/** markdown 제어 문자가 작성자/날짜 표시를 깨지 않도록 escape 한다. */
function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

/** GitHub ISO 날짜를 hover 표시용 문자열로 바꾼다. */
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
