// Suggested changeset diff row 에 표시할 라인 번호를 복원하는 순수 유틸.
// - GitHub 공개 API 가 suggested changeset row 번호를 주지 않는 경우 diff_hunk 와 comment range 로 보강한다.
import { EncodedSuggestedChangeRow } from "./suggestedChangeFormat";

/** suggested change 가 달린 GitHub review comment 의 라인/diff 정보 */
export interface SuggestedChangeLineNumberInput {
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

/**
 * 구조화 row 에 라인 번호가 빠져 있으면 GitHub diff_hunk/comment range 를 기준으로 보강한다.
 * - suggested diff 의 oldLine 은 현재 코드 라인, newLine 은 제안 적용 후 라인으로 취급한다.
 * - 새 파일처럼 PR diff 의 old side 가 0이어도 RIGHT side new line 을 anchor 로 사용한다.
 * @param rows 구조화 suggested changeset row
 * @param input GitHub review comment 의 diff metadata
 * @returns 라인 번호가 가능한 만큼 채워진 row 목록
 */
export function lineNumberedSuggestedChangeRows(
  rows: EncodedSuggestedChangeRow[],
  input: SuggestedChangeLineNumberInput
): EncodedSuggestedChangeRow[] {
  if (rows.every((row) => row.oldLine || row.newLine)) {
    return rows;
  }
  return inferSuggestedChangeLineNumbers(rows, input) || rows;
}

/**
 * diff_hunk 와 comment range 를 이용해 suggested diff row 번호를 추론한다.
 * @param rows 구조화 suggested changeset row
 * @param input GitHub review comment 의 diff metadata
 * @returns 추론된 row 목록. 기준 라인을 찾지 못하면 undefined
 */
function inferSuggestedChangeLineNumbers(
  rows: EncodedSuggestedChangeRow[],
  input: SuggestedChangeLineNumberInput
): EncodedSuggestedChangeRow[] | undefined {
  const range = targetRange(input);
  const hunkLines = parseDiffHunkLines(input.diffHunk);
  const anchor = encodedRowAnchor(rows, hunkLines, range?.side || "RIGHT");
  const startLine = anchor?.lineNo || range?.start;
  if (!startLine) {
    return undefined;
  }
  let oldLine = startLine;
  let newLine = startLine;
  const anchorIndex = anchor?.rowIndex ?? 0;
  for (let index = anchorIndex - 1; index >= 0; index--) {
    if (rows[index].kind === "context") {
      oldLine--;
      newLine--;
    } else if (rows[index].kind === "delete") {
      oldLine--;
    } else {
      newLine--;
    }
  }
  return rows.map((row) => {
    const numbered = numberEncodedRow(row, oldLine, newLine);
    oldLine = numbered.nextOldLine;
    newLine = numbered.nextNewLine;
    return numbered.row;
  });
}

/**
 * suggested row 하나에 현재/제안 라인 카운터를 적용한다.
 * @param row 번호를 채울 row
 * @param oldLine 현재 코드 쪽 라인 번호
 * @param newLine 제안 적용 후 코드 쪽 라인 번호
 * @returns 번호가 채워진 row 와 다음 카운터
 */
function numberEncodedRow(
  row: EncodedSuggestedChangeRow,
  oldLine: number,
  newLine: number
): { row: EncodedSuggestedChangeRow; nextOldLine: number; nextNewLine: number } {
  if (row.kind === "context") {
    return {
      row: { ...row, oldLine: row.oldLine || oldLine, newLine: row.newLine || newLine },
      nextOldLine: oldLine + 1,
      nextNewLine: newLine + 1,
    };
  }
  if (row.kind === "delete") {
    return {
      row: { ...row, oldLine: row.oldLine || oldLine },
      nextOldLine: oldLine + 1,
      nextNewLine: newLine,
    };
  }
  return {
    row: { ...row, newLine: row.newLine || newLine },
    nextOldLine: oldLine,
    nextNewLine: newLine + 1,
  };
}

/**
 * suggested changeset row 와 diff_hunk line 중 현재 코드 쪽에서 같은 코드 줄을 찾는다.
 * @param rows suggested changeset row 목록
 * @param hunkLines 파싱된 diff_hunk line 목록
 * @param side comment 가 달린 GitHub diff side
 * @returns 라인 번호 추론에 사용할 anchor
 */
function encodedRowAnchor(
  rows: EncodedSuggestedChangeRow[],
  hunkLines: ParsedDiffLine[],
  side: TargetRange["side"]
): { rowIndex: number; lineNo: number } | undefined {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (row.kind === "add") {
      continue;
    }
    const line = hunkLines.find((candidate) =>
      lineExistsOnSide(candidate, side) &&
      sameCodeText(row.text, candidate.text)
    );
    const lineNo = line ? lineNumberOnSide(line, side) : undefined;
    if (lineNo) {
      return { rowIndex, lineNo };
    }
  }
  return undefined;
}

/**
 * diff_hunk line 이 comment side 의 현재 코드에 존재하는지 확인한다.
 * @param line diff_hunk line
 * @param side comment side
 * @returns 해당 side 에 존재하면 true
 */
function lineExistsOnSide(line: ParsedDiffLine, side: TargetRange["side"]): boolean {
  return side === "LEFT" ? line.type !== "add" : line.type !== "delete";
}

/**
 * diff_hunk line 에서 comment side 기준 라인 번호를 읽는다.
 * @param line diff_hunk line
 * @param side comment side
 * @returns side 에 대응하는 1-base 라인 번호
 */
function lineNumberOnSide(line: ParsedDiffLine, side: TargetRange["side"]): number | undefined {
  const value = side === "LEFT" ? line.oldLine : line.newLine;
  return typeof value === "number" && value > 0 ? value : undefined;
}

/**
 * GitHub diff_hunk 문자열을 old/new 카운터가 붙은 line 목록으로 파싱한다.
 * @param hunk GitHub review comment diff_hunk
 * @returns 파싱된 diff line 목록
 */
function parseDiffHunkLines(hunk: string | undefined): ParsedDiffLine[] {
  const lines: ParsedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of String(hunk || "").split(/\r?\n/)) {
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
 * GitHub comment metadata 에서 선택 라인 범위를 계산한다.
 * @param input GitHub review comment 의 diff metadata
 * @returns comment 가 달린 side 와 라인 범위
 */
function targetRange(input: SuggestedChangeLineNumberInput): TargetRange | undefined {
  const side: TargetRange["side"] =
    String(input.side || input.startSide || "").toUpperCase() === "LEFT" ? "LEFT" : "RIGHT";
  const end = side === "LEFT"
    ? normalizeLine(input.originalLine) || normalizeLine(input.line)
    : normalizeLine(input.line) || normalizeLine(input.originalLine);
  if (!end) {
    return undefined;
  }
  const start = side === "LEFT"
    ? normalizeLine(input.originalStartLine) || normalizeLine(input.startLine) || end
    : normalizeLine(input.startLine) || normalizeLine(input.originalStartLine) || end;
  return { side, start: Math.min(start, end), end: Math.max(start, end) };
}

/**
 * unknown line 값을 1-base 라인 번호로 정규화한다.
 * @param value 라인 번호 후보
 * @returns 유효한 라인 번호
 */
function normalizeLine(value: unknown): number | undefined {
  const line = Number(value);
  return Number.isFinite(line) && line > 0 ? line : undefined;
}

/**
 * 줄 끝 공백 차이를 무시하고 코드 텍스트가 같은지 확인한다.
 * @param a 첫 번째 코드 줄
 * @param b 두 번째 코드 줄
 * @returns 같은 코드 줄이면 true
 */
function sameCodeText(a: string, b: string): boolean {
  return a.replace(/[ \t]+$/g, "") === b.replace(/[ \t]+$/g, "");
}
