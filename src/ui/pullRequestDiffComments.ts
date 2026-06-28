// PR preview 에서 연 editable diff 오른쪽 파일에 review comment 를 decoration 으로 표시한다.
// - 본문 뒤 여백을 만들지 않고, VS Code CommentThread marker 로 접고 펼칠 수 있게 보여준다.
import * as vscode from "vscode";
import { pullRequestCommentMarkdown } from "./pullRequestCommentMarkdown";
import {
  groupPullRequestThreadComments,
  PullRequestThreadGroup,
} from "./pullRequestCommentThreads";

export interface PullRequestDiffComment {
  id?: number | string;
  parentId?: string;
  author: string;
  body: string;
  bodyText?: string;
  bodyHtml?: string;
  suggestedChangesets?: string[];
  diffHunk?: string;
  line?: number;
  startLine?: number;
  originalLine?: number;
  originalStartLine?: number;
  side?: string;
  startSide?: string;
  createdAt?: string;
  url?: string;
}

const COMMENT_CONTROLLER_ID = "gitSimpleComparePrPreviewComments";

let activeDecoration: vscode.TextEditorDecorationType | undefined;
let activeTarget: { uri: vscode.Uri; comments: PullRequestDiffComment[] } | undefined;
let activeCommentController: vscode.CommentController | undefined;
let activeThreads = new Map<string, vscode.CommentThread>();
let visibleEditorsListener: vscode.Disposable | undefined;

type PullRequestDiffCommentGroup = PullRequestThreadGroup<PullRequestDiffComment>;

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
  activeTarget = undefined;
  clearActiveThreads();
  if (!comments.length) {
    return;
  }
  activeDecoration = createOverviewDecorationType();
  ensureCommentController();
  activeTarget = { uri: fileUri, comments };
  ensureVisibleEditorsListener();
  scheduleApply(fileUri, comments, 250);
  scheduleApply(fileUri, comments, 900);
  scheduleApply(fileUri, comments, 1600);
}

/** 확장 비활성화 시 PR preview comment 표시 리소스를 모두 정리한다. */
export function disposePullRequestDiffComments(): void {
  activeDecoration?.dispose();
  activeDecoration = undefined;
  activeTarget = undefined;
  clearActiveThreads();
  activeCommentController?.dispose();
  activeCommentController = undefined;
  visibleEditorsListener?.dispose();
  visibleEditorsListener = undefined;
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
    const groups = groupedComments(editor.document.lineCount, comments);
    editor.setDecorations(activeDecoration, groups.map(overviewDecoration));
    for (const group of groups) {
      createCollapsedThread(editor, group);
    }
  }
}

/** 본문 뒤 여백 없는 overview ruler 전용 decoration type 을 만든다. */
function createOverviewDecorationType(): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.infoForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
}

/** comment group 을 overview ruler decoration option 으로 변환한다. */
function overviewDecoration(group: PullRequestDiffCommentGroup): vscode.DecorationOptions {
  return {
    range: new vscode.Range(group.line, Number.MAX_SAFE_INTEGER, group.line, Number.MAX_SAFE_INTEGER),
  };
}

/** 같은 라인의 comment 를 하나의 inlay icon 으로 묶는다. */
function groupedComments(lineCount: number, comments: PullRequestDiffComment[]): PullRequestDiffCommentGroup[] {
  return groupPullRequestThreadComments(lineCount, comments);
}

/** visible editor 변경 뒤에도 현재 PR comment decoration 을 다시 적용한다. */
function ensureVisibleEditorsListener(): void {
  if (visibleEditorsListener) {
    return;
  }
  visibleEditorsListener = vscode.window.onDidChangeVisibleTextEditors(() => {
    if (activeTarget) {
      applyComments(activeTarget.uri, activeTarget.comments);
    }
  });
}

/** PR preview diff comment 용 VS Code CommentController 를 필요할 때 만든다. */
function ensureCommentController(): vscode.CommentController {
  if (!activeCommentController) {
    activeCommentController = vscode.comments.createCommentController(
      COMMENT_CONTROLLER_ID,
      vscode.l10n.t("GitHub PR Preview Comments")
    );
  }
  return activeCommentController;
}

/** 같은 라인의 review comment 묶음을 접힌 CommentThread 로 만든다. */
function createCollapsedThread(
  editor: vscode.TextEditor,
  group: PullRequestDiffCommentGroup
): void {
  const key = groupKey(editor.document.uri.toString(), group.line);
  if (activeThreads.has(key)) {
    return;
  }
  const thread = ensureCommentController().createCommentThread(
    editor.document.uri,
    editor.document.lineAt(group.line).range,
    group.comments.map(toVsCodeComment)
  );
  thread.label = vscode.l10n.t("PR review comments");
  thread.contextValue = "gitSimpleCompare.prPreviewReviewComments";
  thread.canReply = false;
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
  activeThreads.set(key, thread);
}

/** 열린 PR preview diff comment thread 를 모두 닫고 정리한다. */
function clearActiveThreads(): void {
  for (const thread of activeThreads.values()) {
    thread.dispose();
  }
  activeThreads = new Map<string, vscode.CommentThread>();
}

/** GitHub review comment 를 VS Code Comment API 객체로 바꾼다. */
function toVsCodeComment(comment: PullRequestDiffComment): vscode.Comment {
  return {
    author: { name: comment.author || "unknown" },
    body: pullRequestCommentMarkdown(comment),
    contextValue: "gitSimpleCompare.prPreviewReviewComment",
    mode: vscode.CommentMode.Preview,
    timestamp: parseDate(comment.createdAt),
  };
}

/** GitHub ISO 날짜를 Comment API timestamp 로 바꾼다. */
function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** CommentThread 를 파일 URI 와 line 으로 중복 없이 찾기 위한 key 를 만든다. */
function groupKey(uri: string, line: number): string {
  return `${uri}\0${line}`;
}
