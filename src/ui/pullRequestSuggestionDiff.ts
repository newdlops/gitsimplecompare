// GitHub suggestion fence 를 VS Code CommentThread 에서 읽기 좋은 diff 코드블록으로 바꾼다.
// - CommentThread MarkdownString 은 GitHub PR UI 같은 커스텀 CSS 를 줄 수 없으므로 diff syntax highlighting 을 활용한다.

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

/**
 * suggestion fence 내부 코드를 원본/제안 diff 코드블록으로 변환한다.
 * - diff_hunk 와 line metadata 가 있으면 GitHub UI 처럼 삭제/추가 라인을 함께 보여준다.
 * - 원본 라인을 계산할 수 없으면 제안 코드만 추가 라인으로 보여준다.
 * @param suggestion suggestion fence 내부 코드
 * @param input GitHub review comment 의 diff/line metadata
 * @returns VS Code MarkdownString.appendCodeblock 에 넣을 코드와 언어
 */
export function suggestedChangeCodeBlock(
  suggestion: string,
  input: SuggestedChangeDiffInput
): SuggestedChangeCodeBlock {
  const suggestedLines = splitCodeLines(suggestion);
  const originalLines = selectedOriginalLines(input);
  if (!originalLines.length && !suggestedLines.length) {
    return { code: "", language: "text" };
  }
  const diffLines = [
    ...originalLines.map((line) => `-${line}`),
    ...suggestedLines.map((line) => `+${line}`),
  ];
  return {
    code: diffLines.join("\n"),
    language: "diff",
  };
}

/**
 * GitHub diff_hunk 에서 comment target range 에 해당하는 기존 코드를 추출한다.
 * - RIGHT side 는 new line 기준으로 context/addition 을, LEFT side 는 old line 기준으로 context/deletion 을 사용한다.
 * @param input GitHub review comment 의 diff/line metadata
 * @returns suggestion 이 대체할 기존 코드 줄 목록
 */
function selectedOriginalLines(input: SuggestedChangeDiffInput): string[] {
  if (!input.diffHunk) {
    return [];
  }
  const range = targetRange(input);
  if (!range) {
    return [];
  }
  return parseDiffHunkLines(input.diffHunk)
    .filter((line) => lineInRange(line, range))
    .map((line) => line.text);
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
      lines.push({ type: "add", text, newLine });
      newLine++;
    } else if (prefix === "-") {
      lines.push({ type: "delete", text, oldLine });
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
