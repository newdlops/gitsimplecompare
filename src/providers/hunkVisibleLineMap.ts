// VS Code diff 에 실제로 보이는 변경 라인을 git hunk line id 로 번역한다.
// - checkbox 위치는 화면 diff 의 +/- 줄을 따르고, stage/unstage 는 git patch id 로 수행한다.
import type { DiffFile, DiffHunk } from "../git/diffHunkService";
import type { WorkingContentWithoutStagedView } from "../git/unstagedView";
import type { CheckboxLine } from "./hunkCheckboxLines";

type DiffSide = "original" | "modified";

interface EditChunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

interface GitChangeLine {
  side: DiffSide;
  line: number;
  column: number;
  text: string;
  lineId: string;
  displayLine?: number;
}

interface DisplayChangeLine {
  side: DiffSide;
  line: number;
  column: number;
  text: string;
}

export interface VisibleChangeRef {
  side: DiffSide;
  line: number;
  column?: number;
  text?: string;
}

interface HunkHeaderRange {
  oldStart: number;
  newStart: number;
}

export interface VisibleLineMapResult {
  lines: CheckboxLine[];
  displayLines: number;
  gitLines: number;
  exactMapped: number;
  textMapped: number;
  displayOnly: number;
  candidateOnly: number;
  droppedGitLines: number;
}

export interface VisibleLineMapOptions {
  virtualUnstagedView?: WorkingContentWithoutStagedView;
}

const MAX_DIFF_CELLS = 4_000_000;

/**
 * 현재 diff 에 표시되는 좌/우 문서 텍스트를 기준으로 checkbox 줄과 git line id 를 연결한다.
 * - 화면 줄은 display diff 에서 만들고, git hunk line id 는 같은 side/line/column 또는 side/text 순서로 붙인다.
 * - VS Code marker row 에 exact 로 붙을 수 있도록 반환 line 은 표시 문서의 1-based 줄 번호다.
 * @param file git diff 에서 파싱한 hunk 파일
 * @param leftText diff 왼쪽에 표시되는 문서 텍스트
 * @param rightText diff 오른쪽에 표시되는 문서 텍스트
 * @param options 가상 unstaged 문서처럼 git 좌표와 표시 좌표가 다른 경우의 보정 정보
 * @returns 화면 변경 라인과 git line id 의 매핑 및 진단 통계
 */
export function checkboxLinesForDisplayedDiff(
  file: DiffFile,
  leftText: string,
  rightText: string,
  options: VisibleLineMapOptions = {}
): VisibleLineMapResult {
  const gitLines = gitChangeLines(file).map((line) => ({
    ...line,
    displayLine: displayLineForGitLine(line, options.virtualUnstagedView),
  }));
  const displayLines = displayChangeLines(leftText, rightText);
  const used = new Set<number>();
  const exact = groupCandidatesByExactLine(gitLines);
  const byText = groupCandidatesByText(gitLines);
  let exactMapped = 0;
  let textMapped = 0;
  let displayOnly = 0;
  const lines: CheckboxLine[] = [];

  for (const displayLine of displayLines) {
    const exactCandidates = takeUnused(
      exact.get(exactKey(displayLine.side, displayLine.line, displayLine.column)) ?? [],
      used
    );
    if (exactCandidates.length) {
      usedCandidates(used, exactCandidates);
      exactMapped += exactCandidates.length;
      lines.push(toCheckboxLine(displayLine, exactCandidates));
      continue;
    }
    const textCandidates = takeUnused(
      byText.get(textKey(displayLine.side, displayLine.text)) ?? [],
      used
    ).slice(0, 1);
    if (textCandidates.length) {
      usedCandidates(used, textCandidates);
      textMapped += textCandidates.length;
      lines.push(toCheckboxLine(displayLine, textCandidates));
      continue;
    }
    displayOnly++;
  }

  return {
    lines,
    displayLines: displayLines.length,
    gitLines: gitLines.length,
    exactMapped,
    textMapped,
    displayOnly,
    candidateOnly: gitLines.length - used.size,
    droppedGitLines: gitLines.filter((line) => !line.displayLine).length,
  };
}

/**
 * VS Code diff DOM 에 실제로 표시된 marker row 를 git hunk line id 로 해석한다.
 * - renderer 가 SOT 이므로, 우리가 다시 계산한 display diff 에 없는 줄도 line/text/column 으로 찾는다.
 * @param file git diff 에서 파싱한 파일 hunk
 * @param visible renderer 가 본 side/line/column/text 정보
 * @param options 가상 unstaged 문서처럼 git 좌표와 표시 좌표가 다른 경우의 보정 정보
 * @returns 가장 가까운 hunk line id. 찾지 못하면 빈 배열
 */
export function lineIdsForVisibleChange(
  file: DiffFile,
  visible: VisibleChangeRef,
  options: VisibleLineMapOptions = {}
): string[] {
  const gitLines = gitChangeLines(file).map((line) => ({
    ...line,
    displayLine: displayLineForGitLine(line, options.virtualUnstagedView),
  }));
  const candidates = gitLines.filter((line) => line.side === visible.side);
  const sameLine = candidates.filter((line) => line.displayLine === visible.line);
  const linePick = bestVisibleCandidate(sameLine, visible, false);
  if (linePick) {
    return [linePick.lineId];
  }
  const textPick = bestVisibleCandidate(candidates, visible, true);
  return textPick ? [textPick.lineId] : [];
}

/** git hunk 본문을 line id 를 가진 변경 라인 목록으로 푼다. */
function gitChangeLines(file: DiffFile): GitChangeLine[] {
  return file.hunks.flatMap((hunk) => gitChangeLinesForHunk(hunk));
}

/** hunk 하나의 `-`/`+` 줄을 old/new 줄 번호와 line id 로 변환한다. */
function gitChangeLinesForHunk(hunk: DiffHunk): GitChangeLine[] {
  const [, ...body] = hunk.text.split("\n");
  const parsed = parseHunkHeader(hunk);
  if (!parsed) {
    return [];
  }
  const lines: GitChangeLine[] = [];
  let oldNo = parsed.oldStart;
  let newNo = parsed.newStart;
  let index = 0;
  while (index < body.length) {
    const line = body[index];
    if (line.startsWith("-") || line.startsWith("+")) {
      const deletions: Array<{ index: number; line: number; text: string }> = [];
      const additions: Array<{ index: number; line: number; text: string }> = [];
      while (index < body.length && body[index].startsWith("-")) {
        deletions.push({ index, line: oldNo++, text: body[index].slice(1) });
        index++;
      }
      while (index < body.length && body[index].startsWith("+")) {
        additions.push({ index, line: newNo++, text: body[index].slice(1) });
        index++;
      }
      deletions.forEach((item, offset) =>
        lines.push({
          side: "original",
          line: item.line,
          column: changeColumn(item.text, additions[offset]?.text),
          text: item.text,
          lineId: lineId(hunk, item.index),
        })
      );
      additions.forEach((item, offset) =>
        lines.push({
          side: "modified",
          line: item.line,
          column: changeColumn(deletions[offset]?.text, item.text),
          text: item.text,
          lineId: lineId(hunk, item.index),
        })
      );
      continue;
    }
    if (!line.startsWith("\\")) {
      oldNo++;
      newNo++;
    }
    index++;
  }
  return lines;
}

/** 표시 문서 두 개를 다시 diff 해 VS Code marker 와 같은 기준의 변경 라인 후보를 만든다. */
function displayChangeLines(leftText: string, rightText: string): DisplayChangeLine[] {
  const left = splitLines(leftText);
  const right = splitLines(rightText);
  const chunks = diffChunks(left, right);
  const lines: DisplayChangeLine[] = [];
  for (const chunk of chunks) {
    for (let index = chunk.aStart; index < chunk.aEnd; index++) {
      const paired = right[chunk.bStart + (index - chunk.aStart)];
      lines.push({
        side: "original",
        line: index + 1,
        column: changeColumn(left[index], paired),
        text: left[index],
      });
    }
    for (let index = chunk.bStart; index < chunk.bEnd; index++) {
      const paired = left[chunk.aStart + (index - chunk.bStart)];
      lines.push({
        side: "modified",
        line: index + 1,
        column: changeColumn(paired, right[index]),
        text: right[index],
      });
    }
  }
  return lines;
}

/** git hunk 줄 번호를 현재 표시 문서 줄 번호로 바꾼다. */
function displayLineForGitLine(
  line: GitChangeLine,
  view: WorkingContentWithoutStagedView | undefined
): number | undefined {
  if (!view) {
    return line.line;
  }
  if (line.side === "modified") {
    return view.workingToViewLine[line.line - 1];
  }
  return (
    view.indexToHeadLine[line.line - 1] ??
    view.indexToHeadDisplayLine[line.line - 1]
  );
}

/** exact 매칭을 위해 side + 표시 줄 번호 + column 으로 후보를 묶는다. */
function groupCandidatesByExactLine(
  lines: GitChangeLine[]
): Map<string, Array<{ index: number; line: GitChangeLine }>> {
  const map = new Map<string, Array<{ index: number; line: GitChangeLine }>>();
  lines.forEach((line, index) => {
    if (!line.displayLine) {
      return;
    }
    pushMap(map, exactKey(line.side, line.displayLine, line.column), { index, line });
  });
  return map;
}

/** 좌표가 다를 때 같은 side/text 의 순서로 후보를 찾기 위해 묶는다. */
function groupCandidatesByText(
  lines: GitChangeLine[]
): Map<string, Array<{ index: number; line: GitChangeLine }>> {
  const map = new Map<string, Array<{ index: number; line: GitChangeLine }>>();
  lines.forEach((line, index) => {
    pushMap(map, textKey(line.side, line.text), { index, line });
  });
  return map;
}

/** 아직 쓰지 않은 후보만 반환한다. */
function takeUnused(
  lines: Array<{ index: number; line: GitChangeLine }>,
  used: Set<number>
): Array<{ index: number; line: GitChangeLine }> {
  return lines.filter((item) => !used.has(item.index));
}

/** 선택된 후보들을 사용 처리한다. */
function usedCandidates(
  used: Set<number>,
  lines: Array<{ index: number; line: GitChangeLine }>
): void {
  lines.forEach((item) => used.add(item.index));
}

/** 표시 줄 하나와 연결된 git 후보들을 renderer 용 checkbox line 으로 바꾼다. */
function toCheckboxLine(
  displayLine: DisplayChangeLine,
  candidates: Array<{ line: GitChangeLine }>
): CheckboxLine {
  return {
    side: displayLine.side,
    line: displayLine.line,
    column: displayLine.column,
    lineIds: candidates.map((item) => item.line.lineId),
  };
}

/** Map 의 배열 값에 항목을 추가한다. */
function pushMap<T>(map: Map<string, T[]>, key: string, item: T): void {
  const list = map.get(key);
  if (list) {
    list.push(item);
  } else {
    map.set(key, [item]);
  }
}

/** 문자열을 줄 배열로 나누고 마지막 개행은 별도 빈 줄로 취급하지 않는다. */
function splitLines(text: string): string[] {
  if (!text.length) {
    return [];
  }
  const lines = text.split("\n");
  if (text.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

/** side + line + column exact 매칭 키를 만든다. */
function exactKey(side: DiffSide, line: number, column: number): string {
  return `${side}\0${line}\0${column}`;
}

/** side + line text 순서 매칭 키를 만든다. */
function textKey(side: DiffSide, text: string): string {
  return `${side}\0${text}`;
}

/** renderer marker row 와 가장 잘 맞는 git hunk 후보를 고른다. */
function bestVisibleCandidate(
  candidates: GitChangeLine[],
  visible: VisibleChangeRef,
  requireText: boolean
): GitChangeLine | undefined {
  const text = normalizeText(visible.text);
  const hasText = visible.text !== undefined;
  const filtered = hasText
    ? candidates.filter((line) => normalizeText(line.text) === text)
    : requireText
      ? []
      : candidates;
  return filtered
    .map((line) => ({ line, score: visibleScore(line, visible, hasText) }))
    .sort((a, b) => a.score - b.score)[0]?.line;
}

/** visible marker 와 git 후보 사이의 거리 점수. 낮을수록 더 정확하다. */
function visibleScore(
  line: GitChangeLine,
  visible: VisibleChangeRef,
  hasText: boolean
): number {
  const lineDistance = Math.abs((line.displayLine ?? line.line) - visible.line);
  const columnDistance = visible.column === undefined
    ? 0
    : Math.abs(line.column - visible.column);
  return lineDistance * 100 + columnDistance + (hasText ? 0 : 10_000);
}

/** DOM text 와 문서 text 의 공백 차이를 최소화한다. */
function normalizeText(value: string | undefined): string | undefined {
  return value?.replace(/\u00a0/g, " ");
}

/** hunk header 에서 old/new 시작 줄을 읽는다. */
function parseHunkHeader(hunk: DiffHunk): HunkHeaderRange | undefined {
  const header = hunk.text.split("\n", 1)[0] ?? "";
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  if (!match) {
    return undefined;
  }
  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

/** DiffHunkService 와 같은 hunk line id 를 만든다. */
function lineId(hunk: DiffHunk, index: number): string {
  return `${hunk.id}:${index}`;
}

/** 두 줄에서 처음 달라지는 1-based column 을 계산한다. */
function changeColumn(left: string | undefined, right: string | undefined): number {
  if (left === undefined || right === undefined) {
    return 1;
  }
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index++) {
    if (left[index] !== right[index]) {
      return index + 1;
    }
  }
  return limit + 1;
}

/** LCS 기반 줄 diff 를 edit chunk 배열로 만든다. */
function diffChunks(a: string[], b: string[]): EditChunk[] {
  if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) {
    throw new Error("Diff input is too large.");
  }
  const width = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * (b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  return rebuildChunks(a, b, dp, width);
}

/** LCS 테이블을 따라가며 연속된 삽입/삭제를 chunk 로 묶는다. */
function rebuildChunks(
  a: string[],
  b: string[],
  dp: Uint32Array,
  width: number
): EditChunk[] {
  const chunks: EditChunk[] = [];
  let chunk: EditChunk | undefined;
  let i = 0;
  let j = 0;
  const startChunk = (): EditChunk =>
    (chunk ??= { aStart: i, aEnd: i, bStart: j, bEnd: j });
  const flush = (): void => {
    if (chunk) {
      chunks.push(chunk);
      chunk = undefined;
    }
  };

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (
      j >= b.length ||
      (i < a.length && dp[(i + 1) * width + j] >= dp[i * width + j + 1])
    ) {
      const current = startChunk();
      i++;
      current.aEnd = i;
    } else {
      const current = startChunk();
      j++;
      current.bEnd = j;
    }
  }
  flush();
  return chunks;
}
