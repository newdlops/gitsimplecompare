// PR review comment 를 VS Code CommentThread 에서 읽기 좋은 markdown 으로 만든다.
// - GitHub comment 본문뿐 아니라 diff hunk 와 suggestion fence 를 함께 보여준다.
import * as vscode from "vscode";

/** CommentThread markdown 을 만들 때 필요한 PR review comment 필드 */
export interface PullRequestCommentMarkdownInput {
  /** GitHub markdown 본문 */
  body?: string;
  /** GitHub review comment 가 달린 diff hunk */
  diffHunk?: string;
  /** 현재 diff 오른쪽 라인 번호 */
  line?: number;
  /** 현재 diff 오른쪽 시작 라인 번호 */
  startLine?: number;
  /** 원본 diff 왼쪽 라인 번호 */
  originalLine?: number;
  /** 원본 diff 왼쪽 시작 라인 번호 */
  originalStartLine?: number;
  /** GitHub diff side 값 */
  side?: string;
  /** GitHub diff start_side 값 */
  startSide?: string;
  /** GitHub comment URL */
  url?: string;
}

/**
 * PR review comment 를 VS Code Comment body 로 변환한다.
 * @param comment GitHub review comment 본문/코드 컨텍스트
 * @returns CommentThread 에 넣을 MarkdownString
 */
export function pullRequestCommentMarkdown(
  comment: PullRequestCommentMarkdownInput
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.supportHtml = false;
  markdown.isTrusted = false;
  appendBody(markdown, comment.body);
  if (comment.url) {
    markdown.appendMarkdown(`\n\n[GitHub comment](${comment.url})`);
  }
  appendDiffHunk(markdown, comment);
  return markdown;
}

/**
 * GitHub diff hunk 에서 PR comment 가 실제로 걸린 라인 범위만 코드 컨텍스트로 붙인다.
 * @param markdown 누적할 MarkdownString
 * @param comment GitHub REST API review comment
 */
function appendDiffHunk(
  markdown: vscode.MarkdownString,
  comment: PullRequestCommentMarkdownInput
): void {
  const value = reviewSnippet(comment);
  if (!value) {
    return;
  }
  markdown.appendMarkdown(`\n\n---\n\n**${vscode.l10n.t("Code context")}**\n\n`);
  markdown.appendMarkdown(codeFence(value, "diff"));
}

/**
 * comment 본문을 붙인다.
 * - GitHub suggestion fence 는 VS Code 에서 의미가 드러나도록 제목과 일반 코드블록으로 바꾼다.
 * @param markdown 누적할 MarkdownString
 * @param body GitHub markdown 본문
 */
function appendBody(markdown: vscode.MarkdownString, body: string | undefined): void {
  const value = body?.trim();
  if (!value) {
    markdown.appendMarkdown(`_${vscode.l10n.t("No comment body.")}_`);
    return;
  }
  markdown.appendMarkdown(renderSuggestionFences(value));
}

/**
 * GitHub 의 ```suggestion fence 를 명시적인 Suggested change 코드블록으로 바꾼다.
 * @param body GitHub markdown 본문
 * @returns VS Code markdown renderer 에서 내용이 보이는 markdown
 */
function renderSuggestionFences(body: string): string {
  return body.replace(
    /```suggestion[^\n]*\n([\s\S]*?)```/g,
    (_match, suggestion: string) =>
      `**${vscode.l10n.t("Suggested change")}**\n\n${codeFence(String(suggestion).trimEnd(), "text")}`
  );
}

/**
 * 전체 diff hunk 에서 GitHub PR 화면의 comment snippet 에 해당하는 줄만 추출한다.
 * @param comment GitHub review comment 와 line metadata
 * @returns comment target line 범위만 담은 diff snippet. 계산할 수 없으면 전체 hunk
 */
function reviewSnippet(comment: PullRequestCommentMarkdownInput): string | undefined {
  const hunk = comment.diffHunk?.trim();
  if (!hunk) {
    return undefined;
  }
  const range = targetRange(comment);
  if (!range) {
    return hunk;
  }
  const selected = parseDiffHunkLines(hunk)
    .filter((line) => isInRange(line, range))
    .map((line) => line.text);
  return selected.length ? selected.join("\n") : hunk;
}

/** diff hunk 에서 추적한 old/new 라인과 원문 한 줄 */
interface ParsedDiffLine {
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** comment snippet 을 추출할 diff side 와 1-base 라인 범위 */
interface TargetRange {
  side: "LEFT" | "RIGHT";
  start: number;
  end: number;
}

/**
 * GitHub comment line metadata 를 snippet 추출 범위로 바꾼다.
 * @param comment GitHub review comment
 * @returns old/new side 와 1-base 라인 범위. line 이 없으면 undefined
 */
function targetRange(comment: PullRequestCommentMarkdownInput): TargetRange | undefined {
  const side = normalizeSide(comment.side || comment.startSide);
  const end = side === "LEFT"
    ? comment.originalLine || comment.line
    : comment.line || comment.originalLine;
  if (!end) {
    return undefined;
  }
  const start = side === "LEFT"
    ? comment.originalStartLine || comment.startLine || end
    : comment.startLine || comment.originalStartLine || end;
  return {
    side,
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
}

/**
 * GitHub diff_hunk 원문을 old/new 라인 번호가 붙은 줄 목록으로 파싱한다.
 * @param hunk GitHub REST API diff_hunk
 * @returns hunk header 를 제외한 diff line 목록
 */
function parseDiffHunkLines(hunk: string): ParsedDiffLine[] {
  const lines: ParsedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of hunk.split(/\r?\n/)) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (raw.startsWith("\\")) {
      continue;
    }
    const prefix = raw[0];
    if (prefix === "+") {
      lines.push({ text: raw, newLine });
      newLine++;
    } else if (prefix === "-") {
      lines.push({ text: raw, oldLine });
      oldLine++;
    } else {
      lines.push({ text: raw, oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }
  return lines;
}

/**
 * diff line 이 comment target range 에 포함되는지 확인한다.
 * @param line 파싱된 diff line
 * @param range comment target range
 */
function isInRange(line: ParsedDiffLine, range: TargetRange): boolean {
  const value = range.side === "LEFT" ? line.oldLine : line.newLine;
  return typeof value === "number" && value >= range.start && value <= range.end;
}

/** GitHub side 문자열을 RIGHT/LEFT 로 정규화한다. */
function normalizeSide(value: string | undefined): "LEFT" | "RIGHT" {
  return String(value || "").toUpperCase() === "LEFT" ? "LEFT" : "RIGHT";
}

/**
 * 내용 안의 backtick 길이에 맞춰 안전한 fenced code block 을 만든다.
 * @param value 코드블록에 넣을 원문
 * @param language markdown 코드블록 언어
 * @returns fence 충돌이 나지 않는 markdown 코드블록
 */
function codeFence(value: string, language: string): string {
  const maxRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, maxRun + 1));
  return `${fence}${language}\n${value.trimEnd()}\n${fence}`;
}
