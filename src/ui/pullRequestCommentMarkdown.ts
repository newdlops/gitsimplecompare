// PR review comment 를 VS Code CommentThread 에서 읽기 좋은 markdown 으로 만든다.
// - GitHub comment 본문과 suggested changeset fence 를 간결하게 보여준다.
import * as vscode from "vscode";
import { suggestedChangeCodeBlock } from "./pullRequestSuggestionDiff";

/** CommentThread markdown 을 만들 때 필요한 PR review comment 필드 */
export interface PullRequestCommentMarkdownInput {
  /** GitHub markdown 본문 */
  body?: string;
  /** GitHub plain text 본문. markdown 본문이 없을 때 fallback 으로 사용한다. */
  bodyText?: string;
  /** GitHub 렌더링 HTML 본문 */
  bodyHtml?: string;
  /** GitHub PR files 웹 HTML 에서 읽은 apply 가능한 suggested changeset 코드 */
  suggestedChangesets?: string[];
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
 * @param comment GitHub review comment 본문과 라인 위치
 * @returns CommentThread 에 넣을 MarkdownString
 */
export function pullRequestCommentMarkdown(
  comment: PullRequestCommentMarkdownInput
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.supportHtml = false;
  markdown.isTrusted = false;
  appendBody(markdown, comment);
  appendSuggestedChangesets(markdown, comment);
  if (comment.url) {
    markdown.appendMarkdown(`\n\n[GitHub comment](${comment.url})`);
  }
  return markdown;
}

/**
 * comment 본문을 붙인다.
 * - GitHub suggestion fence 는 VS Code 에서 의미가 드러나도록 제목과 일반 코드블록으로 바꾼다.
 * @param markdown 누적할 MarkdownString
 * @param comment GitHub markdown 본문과 라인 위치
 */
function appendBody(
  markdown: vscode.MarkdownString,
  comment: PullRequestCommentMarkdownInput
): void {
  const value = (comment.body || comment.bodyText)?.trim();
  if (!value) {
    const suggestions = suggestionsFromHtml(comment.bodyHtml);
    if (suggestions.length) {
      for (const suggestion of suggestions) {
        appendSuggestedChange(markdown, suggestion, rangeLabel(comment), comment);
      }
      return;
    }
    markdown.appendMarkdown(`_${vscode.l10n.t("No comment body.")}_`);
    return;
  }
  markdown.appendMarkdown(
    renderCommentFences(value, rangeLabel(comment), comment).value
  );
}

/**
 * GitHub 웹 HTML 이나 별도 수집 경로에서 읽은 suggested changeset 들을 붙인다.
 * @param markdown 누적할 MarkdownString
 * @param comment GitHub review comment 본문과 suggested changeset 후보
 */
function appendSuggestedChangesets(
  markdown: vscode.MarkdownString,
  comment: PullRequestCommentMarkdownInput
): void {
  for (const suggestion of comment.suggestedChangesets || []) {
    appendSuggestedChange(markdown, suggestion, rangeLabel(comment), comment);
  }
}

/**
 * GitHub comment 의 fenced code 를 안전한 코드블록으로 붙인다.
 * - raw markdown fence 를 그대로 넘기면 CommentThread 에서 뒤 내용이 fence 에 빨려 들어갈 수 있다.
 * - suggestion fence 는 제목을 붙이고, 일반 code fence 는 언어 정보를 보존해 코드블록으로 표시한다.
 * @param body GitHub markdown 본문
 * @param label suggestion 이 적용되는 라인 범위 표시
 * @param comment GitHub review comment 의 diff/line metadata
 * @returns VS Code markdown renderer 에서 내용이 보이는 MarkdownString
 */
function renderCommentFences(
  body: string,
  label: string | undefined,
  comment: PullRequestCommentMarkdownInput
): vscode.MarkdownString {
  const rendered = new vscode.MarkdownString(undefined, true);
  rendered.supportHtml = false;
  rendered.isTrusted = false;
  const segments = splitCommentFences(body);
  if (segments.length === 1 && segments[0].kind === "markdown") {
    rendered.appendMarkdown(body);
    for (const suggestion of suggestionsFromHtml(comment.bodyHtml)) {
      appendSuggestedChange(rendered, suggestion, label, comment);
    }
    return rendered;
  }
  for (const segment of segments) {
    if (segment.kind === "suggestion") {
      appendSuggestedChange(rendered, segment.value, label, comment);
    } else if (segment.kind === "code") {
      appendCodeChunk(rendered, segment.value, segment.language);
    } else {
      appendMarkdownChunk(rendered, segment.value);
    }
  }
  return rendered;
}

/** GitHub comment 본문을 일반 markdown/code/suggestion 블록으로 나눈 결과 */
interface BodySegment {
  /** segment 종류 */
  kind: "markdown" | "suggestion" | "code";
  /** 원문 일부 */
  value: string;
  /** 일반 code fence 의 언어 식별자 */
  language?: string;
}

/** fenced code 블록을 닫는 데 필요한 fence 정보 */
interface FenceInfo {
  /** backtick 또는 tilde fence 문자 */
  char: "`" | "~";
  /** opening fence 길이 */
  length: number;
  /** opening fence 뒤 info string */
  info: string;
}

/**
 * GitHub fenced code 를 라인 단위로 파싱한다.
 * - 정규식 하나로 전체를 잡으면 코드 안의 fence 유사 문자열에서 잘릴 수 있다.
 * - 닫는 fence 는 CommonMark 규칙처럼 같은 문자이면서 opening 이상 길이면 인정한다.
 * @param body GitHub markdown 본문
 * @returns 일반 markdown/code/suggestion segment 배열
 */
function splitCommentFences(body: string): BodySegment[] {
  const lines = splitLinesKeepingEndings(body);
  const segments: BodySegment[] = [];
  let markdown = "";
  for (let index = 0; index < lines.length; index++) {
    const opening = parseOpeningFence(lines[index]);
    if (!opening) {
      markdown += lines[index];
      continue;
    }
    if (markdown) {
      segments.push({ kind: "markdown", value: markdown });
      markdown = "";
    }
    const closingIndex = findClosingFence(lines, index + 1, opening);
    const end = closingIndex >= 0 ? closingIndex : lines.length;
    const value = stripTrailingLineBreaks(lines.slice(index + 1, end).join(""));
    const kind = isSuggestionInfo(opening.info) ? "suggestion" : "code";
    segments.push({
      kind,
      value,
      language: kind === "code" ? codeLanguage(opening.info) : undefined,
    });
    index = closingIndex >= 0 ? closingIndex : lines.length;
  }
  if (markdown) {
    segments.push({ kind: "markdown", value: markdown });
  }
  return segments.length ? segments : [{ kind: "markdown", value: body }];
}

/**
 * 문자열을 줄바꿈 문자까지 보존하며 라인 배열로 나눈다.
 * @param value 나눌 문자열
 * @returns 각 원소가 기존 줄바꿈을 포함하는 line 배열
 */
function splitLinesKeepingEndings(value: string): string[] {
  return value.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) || [];
}

/**
 * 한 줄이 fenced code opening 인지 확인한다.
 * @param line 줄바꿈을 포함할 수 있는 한 줄
 * @returns opening fence 정보. 아니면 undefined
 */
function parseOpeningFence(line: string): FenceInfo | undefined {
  const match = /^[ \t]*(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|\r)?$/i.exec(line);
  if (!match) {
    return undefined;
  }
  const fence = match[1];
  return {
    char: fence[0] as "`" | "~",
    length: fence.length,
    info: match[2].trim(),
  };
}

/**
 * suggestion opening 에 대응하는 closing fence 줄을 찾는다.
 * @param lines 전체 line 배열
 * @param start 검색 시작 index
 * @param opening opening fence 정보
 * @returns closing fence line index. 없으면 -1
 */
function findClosingFence(lines: string[], start: number, opening: FenceInfo): number {
  for (let index = start; index < lines.length; index++) {
    const closing = parseClosingFence(lines[index]);
    if (closing && closing.char === opening.char && closing.length >= opening.length) {
      return index;
    }
  }
  return -1;
}

/**
 * 한 줄이 fenced code closing 줄인지 확인한다.
 * @param line 줄바꿈을 포함할 수 있는 한 줄
 * @returns closing fence 정보. 아니면 undefined
 */
function parseClosingFence(line: string): FenceInfo | undefined {
  const match = /^[ \t]*(`{3,}|~{3,})[ \t]*(?:\r?\n|\r)?$/.exec(line);
  if (!match) {
    return undefined;
  }
  const fence = match[1];
  return {
    char: fence[0] as "`" | "~",
    length: fence.length,
    info: "",
  };
}

/**
 * suggestion 내용 끝의 줄바꿈만 제거하고 코드 공백은 보존한다.
 * @param value suggestion fence 내부 원문
 * @returns 끝 줄바꿈을 제거한 문자열
 */
function stripTrailingLineBreaks(value: string): string {
  return value.replace(/(?:\r?\n|\r)+$/g, "");
}

/**
 * suggestion 앞뒤의 일반 markdown 본문을 간격이 깨지지 않도록 붙인다.
 * @param markdown 누적할 MarkdownString
 * @param value GitHub comment markdown 일부
 */
function appendMarkdownChunk(markdown: vscode.MarkdownString, value: string): void {
  const chunk = value.trim();
  if (!chunk) {
    return;
  }
  if (markdown.value) {
    markdown.appendMarkdown("\n\n");
  }
  markdown.appendMarkdown(chunk);
}

/**
 * GitHub suggested changeset 내용을 CommentThread 에 코드블록으로 붙인다.
 * @param markdown 누적할 MarkdownString
 * @param suggestion suggestion fence 안의 코드
 * @param label suggestion 이 적용되는 라인 범위 표시
 */
function appendSuggestedChange(
  markdown: vscode.MarkdownString,
  suggestion: string,
  label: string | undefined,
  comment: PullRequestCommentMarkdownInput | undefined
): void {
  if (markdown.value) {
    markdown.appendMarkdown("\n\n");
  }
  markdown.appendMarkdown(
    `**${vscode.l10n.t("Suggested changeset")}${label ? ` · ${label}` : ""}**\n\n`
  );
  const codeBlock = suggestedChangeCodeBlock(suggestion, comment || {});
  markdown.appendCodeblock(
    codeBlock.code || vscode.l10n.t("Delete selected lines"),
    codeBlock.language
  );
}

/**
 * 일반 fenced code block 을 CommentThread 에 안전하게 붙인다.
 * @param markdown 누적할 MarkdownString
 * @param code fenced code 내부 원문
 * @param language GitHub markdown info string 에서 얻은 언어 식별자
 */
function appendCodeChunk(
  markdown: vscode.MarkdownString,
  code: string,
  language: string | undefined
): void {
  if (markdown.value) {
    markdown.appendMarkdown("\n\n");
  }
  markdown.appendCodeblock(code, language || "text");
}

/** fence info string 이 GitHub suggestion 블록인지 확인한다. */
function isSuggestionInfo(value: string): boolean {
  return /^suggestion\b/i.test(value.trim());
}

/**
 * fenced code info string 에서 VS Code markdown 언어 식별자를 추출한다.
 * @param value opening fence 뒤 info string
 * @returns 첫 토큰이 언어처럼 보이면 그 값, 아니면 undefined
 */
function codeLanguage(value: string): string | undefined {
  const language = value.trim().split(/\s+/, 1)[0];
  return /^[A-Za-z0-9_+.-]+$/.test(language) ? language : undefined;
}

/**
 * GitHub body_html 에서 Suggested changeset 코드 후보를 추출한다.
 * - 일부 GitHub UI 는 raw body 에 suggestion fence 를 남기지 않고 렌더링 HTML 에만 코드블록을 둔다.
 * - HTML 파서는 두지 않고, GitHub comment HTML 의 pre/code 와 blob-code table 패턴만 보수적으로 읽는다.
 * @param bodyHtml GitHub full media type 이 내려준 HTML 본문
 * @returns suggested change 코드 후보 목록
 */
function suggestionsFromHtml(bodyHtml: string | undefined): string[] {
  if (!bodyHtml) {
    return [];
  }
  const searchable = htmlText(bodyHtml);
  const hasSuggestionHint =
    /suggest(?:ed)?\s+changeset|suggest(?:ed)?\s+change/i.test(searchable) ||
    /suggest(?:ed)?[-_ ]?changeset|suggest(?:ed)?[-_ ]?change|js-suggest/i.test(bodyHtml);
  if (!hasSuggestionHint) {
    return [];
  }
  const values = [
    ...preCodeBlocksFromHtml(bodyHtml),
    ...blobCodeBlocksFromHtml(bodyHtml),
  ]
    .map((value) => value.trimEnd())
    .filter(Boolean);
  return uniqueStrings(values);
}

/**
 * HTML 의 pre/code 블록을 코드 문자열로 추출한다.
 * @param html GitHub body_html
 * @returns 디코딩된 code block 배열
 */
function preCodeBlocksFromHtml(html: string): string[] {
  const blocks: string[] = [];
  const pattern = /<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi;
  for (const match of html.matchAll(pattern)) {
    blocks.push(htmlText(match[1]));
  }
  return blocks;
}

/**
 * GitHub diff table 의 blob-code 셀을 줄 단위 코드로 추출한다.
 * @param html GitHub body_html
 * @returns table 별 코드 후보 배열
 */
function blobCodeBlocksFromHtml(html: string): string[] {
  const blocks: string[] = [];
  const tablePattern = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
  for (const table of html.matchAll(tablePattern)) {
    const lines = blobCodeLines(table[0]);
    if (lines.length) {
      blocks.push(lines.join("\n"));
    }
  }
  if (blocks.length) {
    return blocks;
  }
  const lines = blobCodeLines(html);
  return lines.length ? [lines.join("\n")] : [];
}

/**
 * HTML 조각에서 blob-code 셀 텍스트를 순서대로 읽는다.
 * @param html GitHub body_html 일부
 * @returns 디코딩된 코드 줄 배열
 */
function blobCodeLines(html: string): string[] {
  const lines: string[] = [];
  const cellPattern = /<td\b[^>]*class="[^"]*\bblob-code\b[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
  for (const match of html.matchAll(cellPattern)) {
    const text = htmlText(match[1]);
    if (text || /blob-code-empty/.test(match[0])) {
      lines.push(text);
    }
  }
  return lines;
}

/**
 * HTML 태그를 제거하고 엔티티를 사람이 읽을 수 있는 텍스트로 디코딩한다.
 * @param value HTML 조각
 * @returns 일반 텍스트
 */
function htmlText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  );
}

/**
 * HTML entity 를 최소한의 코드 표시용 텍스트로 바꾼다.
 * @param value entity 가 포함된 텍스트
 * @returns 디코딩된 텍스트
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (match, code: string) => decodeCodePoint(match, Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (match, code: string) => decodeCodePoint(match, parseInt(code, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

/**
 * 숫자 HTML entity code point 를 안전하게 문자로 바꾼다.
 * @param fallback 디코딩할 수 없을 때 유지할 원문
 * @param codePoint entity 가 가리키는 Unicode code point
 * @returns 디코딩된 문자 또는 fallback
 */
function decodeCodePoint(fallback: string, codePoint: number): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return fallback;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

/**
 * 같은 suggested change 후보가 중복 표시되지 않도록 제거한다.
 * @param values 후보 문자열 배열
 * @returns 입력 순서를 유지한 고유 문자열 배열
 */
function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

/** suggestion 라벨을 만들기 위한 diff side 와 1-base 라인 범위 */
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

/** GitHub side 문자열을 RIGHT/LEFT 로 정규화한다. */
function normalizeSide(value: string | undefined): "LEFT" | "RIGHT" {
  return String(value || "").toUpperCase() === "LEFT" ? "LEFT" : "RIGHT";
}

/**
 * comment target range 를 사람이 읽기 쉬운 라인 표시로 바꾼다.
 * @param comment GitHub review comment
 * @returns `line N` 또는 `lines A-B`
 */
function rangeLabel(comment: PullRequestCommentMarkdownInput): string | undefined {
  const range = targetRange(comment);
  if (!range) {
    return undefined;
  }
  return range.start === range.end
    ? vscode.l10n.t("line {0}", range.end)
    : vscode.l10n.t("lines {0}-{1}", range.start, range.end);
}
