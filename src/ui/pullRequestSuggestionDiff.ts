// GitHub suggestion fence 를 VS Code CommentThread 에서 읽기 좋은 diff 코드블록으로 바꾼다.
// - CommentThread MarkdownString 은 GitHub PR UI 같은 커스텀 CSS 를 줄 수 없으므로 diff syntax highlighting 을 활용한다.
import {
  EncodedSuggestedChangeRow,
  decodeSuggestedChangeRows,
} from "../utils/suggestedChangeFormat";
import { lineNumberedSuggestedChangeRows } from "../utils/suggestedChangeLineNumbers";

/** suggested change 가 달린 GitHub review comment 의 라인/diff 정보 */
export interface SuggestedChangeDiffInput {
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
}

/** VS Code markdown code block 으로 표시할 suggested change 내용 */
export interface SuggestedChangeCodeBlock {
  /** code block 내용 */
  code: string;
  /** code block 언어 */
  language: "diff" | "text";
}

interface TargetRange {
  side: "LEFT" | "RIGHT";
  start: number;
  end: number;
}

interface ParsedDiffLine {
  type: "context" | "add" | "delete";
  text: string;
  oldLine?: number;
  newLine?: number;
}

interface OriginalSuggestionLine {
  text: string;
  lineNo?: number;
}

interface SuggestedChangeDiffRow {
  marker: "+" | "-";
  lineNo?: number;
  oldLine?: number;
  newLine?: number;
  text: string;
}

/**
 * suggestion fence 내부 코드를 원본/제안 diff 코드블록으로 변환한다.
 * - diff_hunk 와 line metadata 가 있으면 GitHub UI 처럼 삭제/추가 라인을 함께 보여준다.
 * - CommentThread 의 code block 은 별도 gutter 를 둘 수 없으므로 라인 번호를 diff 본문 앞에 넣는다.
 * - 원본 라인을 계산할 수 없으면 제안 코드만 추가 라인으로 보여준다.
 * @param suggestion suggestion fence 내부 코드
 * @param input GitHub review comment 의 diff/line metadata
 * @returns VS Code MarkdownString.appendCodeblock 에 넣을 코드와 언어
 */
export function suggestedChangeCodeBlock(
  suggestion: string,
  input: SuggestedChangeDiffInput
): SuggestedChangeCodeBlock {
  const encodedRows = decodeSuggestedChangeRows(suggestion);
  if (encodedRows) {
    return {
      code: formatEncodedSuggestedChangeRows(lineNumberedSuggestedChangeRows(encodedRows, input)),
      language: "diff",
    };
  }
  const rows = suggestedChangeDiffRows(suggestion, input);
  if (!rows.length) {
    return { code: "", language: "text" };
  }
  return {
    code: formatSuggestedChangeDiffRows(rows),
    language: "diff",
  };
}

/**
 * GitHub/Copilot 에서 읽은 실제 suggested changeset row 를 code block 문자열로 만든다.
 * - row kind 가 이미 있으므로 원본 범위를 재추정하지 않아 문맥 줄을 삭제 줄로 오표시하지 않는다.
 * @param rows 인코딩에서 복원한 diff row 목록
 * @returns VS Code diff code block 내용
 */
function formatEncodedSuggestedChangeRows(rows: EncodedSuggestedChangeRow[]): string {
  const width = encodedLineNumberWidth(rows);
  return rows
    .map((row) => `${encodedMarker(row)} ${formatLineNumber(row.oldLine, width)} ${formatLineNumber(row.newLine, width)} | ${row.text}`)
    .join("\n");
}

/**
 * 구조화 row 의 old/new 라인 번호 컬럼 폭을 계산한다.
 * @param rows suggested changeset row 목록
 * @returns 정렬에 필요한 최소 문자 수
 */
function encodedLineNumberWidth(rows: EncodedSuggestedChangeRow[]): number {
  return Math.max(
    1,
    ...rows
      .flatMap((row) => [row.oldLine, row.newLine])
      .filter((lineNo): lineNo is number => typeof lineNo === "number")
      .map((lineNo) => String(lineNo).length)
  );
}

/**
 * 구조화 row kind 를 diff code block marker 로 바꾼다.
 * @param row suggested changeset row
 * @returns diff marker
 */
function encodedMarker(row: EncodedSuggestedChangeRow): "+" | "-" | " " {
  if (row.kind === "add") {
    return "+";
  }
  return row.kind === "delete" ? "-" : " ";
}

/**
 * suggestion fence 와 review comment 위치를 diff row 목록으로 변환한다.
 * - 삭제 row 는 diff_hunk 에서 선택된 기존 코드와 실제 라인 번호를 사용한다.
 * - 추가 row 는 suggestion 코드가 적용될 시작 라인부터 이어지는 번호를 부여한다.
 * @param suggestion suggestion fence 내부 코드
 * @param input GitHub review comment 의 diff/line metadata
 * @returns diff 코드블록에 표시할 삭제/추가 row 목록
 */
function suggestedChangeDiffRows(
  suggestion: string,
  input: SuggestedChangeDiffInput
): SuggestedChangeDiffRow[] {
  const suggestedLines = splitCodeLines(suggestion);
  const originalLines = selectedOriginalLines(input);
  if (!originalLines.length && !suggestedLines.length) {
    return [];
  }
  const range = targetRange(input);
  const deletedRows = originalLines.map((line) => ({
    marker: "-" as const,
    lineNo: line.lineNo,
    oldLine: line.lineNo,
    text: line.text,
  }));
  const addedRows = suggestedLines.map((line, index) => ({
    marker: "+" as const,
    lineNo: suggestedLineNumber(range, index),
    newLine: suggestedLineNumber(range, index),
    text: line,
  }));
  return pairSuggestedChangeRows(deletedRows, addedRows);
}

/**
 * 삭제/추가 row 를 사람이 비교하기 쉬운 순서로 섞는다.
 * - 기존 diff 처럼 삭제를 먼저 전부 나열하면 `- 20` 과 `+ 20` 이 멀어져 읽기 어렵다.
 * - 같은 lineNo 가 있으면 삭제 row 바로 뒤에 추가 row 를 붙여 같은 라인 변경으로 보이게 한다.
 * @param deletedRows 기존 코드 row 목록
 * @param addedRows 제안 코드 row 목록
 * @returns 같은 라인 번호끼리 붙인 표시 row 목록
 */
function pairSuggestedChangeRows(
  deletedRows: SuggestedChangeDiffRow[],
  addedRows: SuggestedChangeDiffRow[]
): SuggestedChangeDiffRow[] {
  if (hasLineNumbers(deletedRows) && hasLineNumbers(addedRows)) {
    return pairRowsByLineNumber(deletedRows, addedRows);
  }
  return pairRowsByIndex(deletedRows, addedRows);
}

/**
 * row 목록에 라인 번호가 하나라도 있는지 확인한다.
 * @param rows 확인할 diff row 목록
 * @returns 라인 번호가 있으면 true
 */
function hasLineNumbers(rows: SuggestedChangeDiffRow[]): boolean {
  return rows.some((row) => typeof row.lineNo === "number");
}

/**
 * 실제 lineNo 가 같은 삭제/추가 row 를 바로 붙인다.
 * @param deletedRows 기존 코드 row 목록
 * @param addedRows 제안 코드 row 목록
 * @returns lineNo 기준으로 묶은 row 목록
 */
function pairRowsByLineNumber(
  deletedRows: SuggestedChangeDiffRow[],
  addedRows: SuggestedChangeDiffRow[]
): SuggestedChangeDiffRow[] {
  const rows: SuggestedChangeDiffRow[] = [];
  const addedByLine = new Map<number, SuggestedChangeDiffRow[]>();
  const used = new Set<SuggestedChangeDiffRow>();
  for (const row of addedRows) {
    if (typeof row.lineNo !== "number") {
      continue;
    }
    const list = addedByLine.get(row.lineNo) || [];
    list.push(row);
    addedByLine.set(row.lineNo, list);
  }
  for (const row of deletedRows) {
    rows.push(row);
    const matches = typeof row.lineNo === "number" ? addedByLine.get(row.lineNo) : undefined;
    if (!matches) {
      continue;
    }
    for (const added of matches) {
      rows.push(added);
      used.add(added);
    }
  }
  rows.push(...addedRows.filter((row) => !used.has(row)));
  return rows;
}

/**
 * 라인 번호를 알 수 없을 때 삭제/추가 row 를 순서대로 하나씩 붙인다.
 * @param deletedRows 기존 코드 row 목록
 * @param addedRows 제안 코드 row 목록
 * @returns index 기준으로 섞은 row 목록
 */
function pairRowsByIndex(
  deletedRows: SuggestedChangeDiffRow[],
  addedRows: SuggestedChangeDiffRow[]
): SuggestedChangeDiffRow[] {
  const rows: SuggestedChangeDiffRow[] = [];
  const max = Math.max(deletedRows.length, addedRows.length);
  for (let index = 0; index < max; index++) {
    if (deletedRows[index]) {
      rows.push(deletedRows[index]);
    }
    if (addedRows[index]) {
      rows.push(addedRows[index]);
    }
  }
  return rows;
}

/**
 * diff row 목록을 VS Code diff syntax highlight 가 유지되는 문자열로 바꾼다.
 * - 줄 맨 앞의 +,- 는 그대로 두고, 그 뒤에 정렬된 라인 번호 컬럼을 둔다.
 * @param rows 삭제/추가 row 목록
 * @returns code block 에 넣을 diff 문자열
 */
function formatSuggestedChangeDiffRows(rows: SuggestedChangeDiffRow[]): string {
  const width = lineNumberWidth(rows);
  return rows
    .map((row) => `${row.marker} ${formatLineNumber(displayOldLine(row), width)} ${formatLineNumber(displayNewLine(row), width)} | ${row.text}`)
    .join("\n");
}

/**
 * 라인 번호 컬럼 폭을 계산한다.
 * @param rows 삭제/추가 row 목록
 * @returns 정렬에 필요한 최소 문자 수
 */
function lineNumberWidth(rows: SuggestedChangeDiffRow[]): number {
  return Math.max(
    1,
    ...rows
      .flatMap((row) => [displayOldLine(row), displayNewLine(row)])
      .filter((lineNo): lineNo is number => typeof lineNo === "number")
      .map((lineNo) => String(lineNo).length)
  );
}

/**
 * fallback row 의 old 라인 번호를 고른다.
 * @param row 표시할 diff row
 * @returns old side 라인 번호
 */
function displayOldLine(row: SuggestedChangeDiffRow): number | undefined {
  return row.oldLine ?? (row.marker === "-" ? row.lineNo : undefined);
}

/**
 * fallback row 의 new 라인 번호를 고른다.
 * @param row 표시할 diff row
 * @returns new side 라인 번호
 */
function displayNewLine(row: SuggestedChangeDiffRow): number | undefined {
  return row.newLine ?? (row.marker === "+" ? row.lineNo : undefined);
}

/**
 * 라인 번호를 고정 폭 문자열로 만든다.
 * @param lineNo 표시할 1-base 라인 번호
 * @param width 라인 번호 컬럼 폭
 * @returns lineNo 가 없으면 같은 폭의 공백
 */
function formatLineNumber(lineNo: number | undefined, width: number): string {
  return typeof lineNo === "number"
    ? String(lineNo).padStart(width, " ")
    : " ".repeat(width);
}

/**
 * GitHub diff_hunk 에서 comment target range 에 해당하는 기존 코드를 추출한다.
 * - RIGHT side 는 new line 기준으로 context/addition 을, LEFT side 는 old line 기준으로 context/deletion 을 사용한다.
 * @param input GitHub review comment 의 diff/line metadata
 * @returns suggestion 이 대체할 기존 코드 줄과 표시 라인 번호 목록
 */
function selectedOriginalLines(input: SuggestedChangeDiffInput): OriginalSuggestionLine[] {
  if (!input.diffHunk) {
    return [];
  }
  const range = targetRange(input);
  if (!range) {
    return [];
  }
  return parseDiffHunkLines(input.diffHunk)
    .filter((line) => lineInRange(line, range))
    .map((line) => ({
      text: line.text,
      lineNo: displayLineNumber(line, range.side),
    }));
}

/**
 * GitHub comment line metadata 를 diff_hunk 조회 범위로 바꾼다.
 * @param input GitHub review comment 의 line metadata
 * @returns old/new side 와 1-base 라인 범위
 */
function targetRange(input: SuggestedChangeDiffInput): TargetRange | undefined {
  const side = normalizeSide(input.side || input.startSide);
  const end = side === "LEFT"
    ? input.originalLine || input.line
    : input.line || input.originalLine;
  if (!end) {
    return undefined;
  }
  const start = side === "LEFT"
    ? input.originalStartLine || input.startLine || end
    : input.startLine || input.originalStartLine || end;
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
    if (!raw || raw.startsWith("\\")) {
      continue;
    }
    const prefix = raw[0];
    const text = raw.slice(1);
    if (prefix === "+") {
      lines.push({ type: "add", text, oldLine, newLine });
      newLine++;
    } else if (prefix === "-") {
      lines.push({ type: "delete", text, oldLine, newLine });
      oldLine++;
    } else {
      lines.push({ type: "context", text, oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }
  return lines;
}

/**
 * 파싱된 diff line 이 comment target range 에 포함되는지 확인한다.
 * @param line 파싱된 diff line
 * @param range comment target range
 * @returns 표시 대상이면 true
 */
function lineInRange(line: ParsedDiffLine, range: TargetRange): boolean {
  if (range.side === "LEFT") {
    return line.type !== "add"
      && typeof line.oldLine === "number"
      && line.oldLine >= range.start
      && line.oldLine <= range.end;
  }
  return line.type !== "delete"
    && typeof line.newLine === "number"
    && line.newLine >= range.start
    && line.newLine <= range.end;
}

/**
 * diff_hunk 의 old/new 라인 번호 중 comment side 에 맞는 번호를 고른다.
 * @param line 파싱된 diff line
 * @param side GitHub comment side
 * @returns code block 에 표시할 1-base 라인 번호
 */
function displayLineNumber(
  line: ParsedDiffLine,
  side: TargetRange["side"]
): number | undefined {
  return side === "LEFT" ? line.oldLine : line.newLine;
}

/**
 * 추가될 suggestion 줄의 표시 라인 번호를 계산한다.
 * @param range comment target range
 * @param index suggestion 내부 0-base line index
 * @returns 적용 위치 기준 1-base 라인 번호
 */
function suggestedLineNumber(
  range: TargetRange | undefined,
  index: number
): number | undefined {
  return range ? range.start + index : undefined;
}

/** GitHub side 문자열을 RIGHT/LEFT 로 정규화한다. */
function normalizeSide(value: string | undefined): "LEFT" | "RIGHT" {
  return String(value || "").toUpperCase() === "LEFT" ? "LEFT" : "RIGHT";
}

/**
 * suggestion 코드 문자열을 code line 배열로 나눈다.
 * @param value suggestion fence 내부 코드
 * @returns 끝 줄바꿈을 제외한 코드 line 배열
 */
function splitCodeLines(value: string): string[] {
  const trimmed = value.replace(/(?:\r?\n|\r)+$/g, "");
  return trimmed ? trimmed.split(/\r?\n|\r/) : [];
}
