// diff hunk 를 native/editor 라인 checkbox 좌표로 변환하는 provider 유틸.
// - UI 상태와 git 적용 로직 사이에서 동일한 line id 규칙을 공유하도록 작게 분리한다.
import { DiffFile, DiffHunk } from "../git/diffHunkService";

export type CheckboxSide = "original" | "modified";

export interface CheckboxLine {
  side: CheckboxSide;
  line: number;
  column?: number;
  lineIds: string[];
}

interface HunkHeaderRange {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** diff 파일에서 원본/수정 문서 줄에 붙일 체크박스 목록을 만든다. */
export function checkboxLines(file: DiffFile): CheckboxLine[] {
  return file.hunks.flatMap((hunk) => checkboxLinesForHunk(hunk));
}

/**
 * checkbox line id 별 실제 diff side 를 만든다.
 * @param lines 화면/patch 매핑에서 만든 checkbox 줄 목록
 * @returns line id 를 key 로 하고 original/modified side 를 값으로 하는 map
 */
export function checkboxLineSides(
  lines: readonly CheckboxLine[]
): Map<string, CheckboxSide> {
  const sides = new Map<string, CheckboxSide>();
  for (const line of lines) {
    for (const id of line.lineIds) {
      sides.set(id, line.side);
    }
  }
  return sides;
}

/** hunk 하나에서 git diff 의 `-`/`+` 변경 라인을 실제 old/new 줄에 각각 표시한다. */
function checkboxLinesForHunk(hunk: DiffHunk): CheckboxLine[] {
  const [, ...body] = hunk.text.split("\n");
  const parsed = parseHunkHeader(hunk);
  if (!parsed) {
    return [];
  }
  const items: CheckboxLine[] = [];
  let index = 0;
  let oldNo = parsed.oldStart;
  let newNo = parsed.newStart;
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
        items.push({
          side: "original",
          line: item.line,
          column: changeColumn(item.text, additions[offset]?.text),
          lineIds: [lineId(hunk, item.index)],
        })
      );
      additions.forEach((item, offset) =>
        items.push({
          side: "modified",
          line: item.line,
          column: changeColumn(deletions[offset]?.text, item.text),
          lineIds: [lineId(hunk, item.index)],
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
  return items;
}

/**
 * hunk header 에서 old/new 시작 줄과 길이를 읽는다.
 * @param hunk unified diff hunk
 * @returns 파싱된 줄 범위. header 형식이 아니면 undefined
 */
function parseHunkHeader(hunk: DiffHunk): HunkHeaderRange | undefined {
  const header = hunk.text.split("\n", 1)[0] ?? "";
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) {
    return undefined;
  }
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/**
 * DiffHunkService 와 동일한 hunk line id 규칙을 사용한다.
 * @param hunk id 의 기준이 되는 hunk
 * @param index hunk body 안의 0-based 줄 인덱스
 * @returns checkbox/patch 선택에 쓰는 안정적인 line id
 */
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
