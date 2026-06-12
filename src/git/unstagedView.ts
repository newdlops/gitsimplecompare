// staged 변경을 제거한 "남은 unstaged 작업본" 내용을 만드는 순수 유틸.
// - 실제 git index/working tree 는 그대로 두고, 표시용 가상 문서 내용만 계산한다.

interface SplitContent {
  lines: string[];
  finalNewline: boolean;
}

interface EditChunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/** staged 변경을 제거한 표시용 문서와 원본 줄 번호가 화면 줄로 가는 매핑. */
export interface WorkingContentWithoutStagedView {
  text: string;
  indexToHeadLine: Array<number | undefined>;
  indexToHeadDisplayLine: Array<number | undefined>;
  workingToViewLine: Array<number | undefined>;
}

const MAX_DIFF_CELLS = 4_000_000;

/**
 * HEAD, index, working 세 버전에서 staged 변경을 제거한 working 내용을 만든다.
 * - index 에만 있는 변화는 제거하고, index → working 의 추가 변화만 HEAD 위에 얹는다.
 * - 너무 큰 파일이거나 계산이 실패하면 호출자가 넘긴 working 내용을 그대로 반환한다.
 * @param head HEAD 기준 파일 내용
 * @param index index(stage 0) 기준 파일 내용
 * @param working 실제 작업트리 파일 내용
 * @returns staged 변경을 제거한 표시용 작업트리 내용
 */
export function buildWorkingContentWithoutStaged(
  head: string,
  index: string,
  working: string
): string {
  return buildWorkingContentWithoutStagedView(head, index, working).text;
}

/**
 * staged 변경을 제거한 표시용 문서와 줄 번호 매핑을 함께 만든다.
 * - checkbox overlay 는 실제 working/index diff 의 line id 를 유지하되,
 *   화면 좌표는 HEAD ↔ 가상 unstaged 문서 기준으로 바꿔야 한다.
 * @param head HEAD 기준 파일 내용
 * @param index index(stage 0) 기준 파일 내용
 * @param working 실제 작업트리 파일 내용
 * @returns 표시용 텍스트와 index/working 줄의 표시 문서 줄 번호(1-based)
 */
export function buildWorkingContentWithoutStagedView(
  head: string,
  index: string,
  working: string
): WorkingContentWithoutStagedView {
  try {
    const headContent = splitContent(head);
    const indexContent = splitContent(index);
    const workingContent = splitContent(working);
    const indexToHead = mapIndexLinesToHead(
      headContent.lines,
      indexContent.lines
    );
    const indexToHeadDisplay = mapIndexLinesToHeadDisplay(
      indexToHead,
      headContent.lines.length
    );
    const unstagedChunks = diffChunks(indexContent.lines, workingContent.lines);
    const merged = applyIndexToWorkingChunksToHead(
      headContent.lines,
      workingContent.lines,
      indexToHead,
      unstagedChunks
    );
    return {
      text: joinContent({
        lines: merged.lines,
        finalNewline: workingContent.finalNewline,
      }),
      indexToHeadLine: toOneBasedLineMap(indexToHead),
      indexToHeadDisplayLine: toOneBasedLineMap(indexToHeadDisplay),
      workingToViewLine: toOneBasedLineMap(merged.workingToView),
    };
  } catch {
    return fallbackWorkingView(working);
  }
}

/** 문자열을 줄 배열과 마지막 개행 여부로 나눈다. */
function splitContent(text: string): SplitContent {
  if (text.length === 0) {
    return { lines: [], finalNewline: false };
  }
  const finalNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (finalNewline) {
    lines.pop();
  }
  return { lines, finalNewline };
}

/** 줄 배열을 다시 문자열로 합친다. */
function joinContent(content: SplitContent): string {
  return content.lines.join("\n") + (content.finalNewline ? "\n" : "");
}

/** index 각 줄이 HEAD 의 어느 줄과 같은지 매핑한다. staged 추가 줄은 undefined 다. */
function mapIndexLinesToHead(
  head: string[],
  index: string[]
): Array<number | undefined> {
  const chunks = diffChunks(head, index);
  const map = new Array<number | undefined>(index.length);
  let headCursor = 0;
  let indexCursor = 0;
  for (const chunk of chunks) {
    while (headCursor < chunk.aStart && indexCursor < chunk.bStart) {
      map[indexCursor] = headCursor;
      headCursor++;
      indexCursor++;
    }
    headCursor = chunk.aEnd;
    indexCursor = chunk.bEnd;
  }
  while (headCursor < head.length && indexCursor < index.length) {
    map[indexCursor] = headCursor;
    headCursor++;
    indexCursor++;
  }
  return map;
}

/**
 * 정확히 같은 HEAD 줄이 없는 index 줄을 diff 표시용 HEAD 줄로 보정한다.
 * - staged 변경 블록 안의 줄은 LCS 기준 동일 줄 매핑이 없어도 VS Code diff 에서는
 *   주변 HEAD 경계에 삭제 마커가 나타날 수 있다.
 * - checkbox 는 git line id 를 유지하고 표시 위치만 옮겨야 하므로, 빈 매핑을
 *   같은 변경 블록의 HEAD 경계 줄로 제한적으로 채운다.
 * @param indexToHead index 줄에서 HEAD 줄로 가는 0-based 정확 매핑
 * @param headLength HEAD 문서 줄 수
 * @returns checkbox 표시용 0-based HEAD 줄 매핑
 */
function mapIndexLinesToHeadDisplay(
  indexToHead: Array<number | undefined>,
  headLength: number
): Array<number | undefined> {
  const map = new Array<number | undefined>(indexToHead.length);
  if (!headLength) {
    return map;
  }
  let index = 0;
  while (index < indexToHead.length) {
    const exact = indexToHead[index];
    if (exact !== undefined) {
      map[index++] = exact;
      continue;
    }
    const start = index;
    while (index < indexToHead.length && indexToHead[index] === undefined) {
      index++;
    }
    const boundary = headBoundaryForIndexPosition(indexToHead, start, headLength);
    const nextExact = indexToHead[index];
    const maxLine = nextExact === undefined ? headLength - 1 : nextExact - 1;
    const firstLine = Math.min(Math.max(boundary, 0), headLength - 1);
    for (let offset = 0; start + offset < index; offset++) {
      const candidate = firstLine + offset;
      map[start + offset] = candidate <= maxLine ? candidate : undefined;
    }
  }
  return map;
}

/** index → working 변경 chunk 를 HEAD 줄 배열에 좌표 변환해 적용한다. */
function applyIndexToWorkingChunksToHead(
  head: string[],
  working: string[],
  indexToHead: Array<number | undefined>,
  chunks: EditChunk[]
): { lines: string[]; workingToView: Array<number | undefined> } {
  const out: string[] = [];
  const workingToView = new Array<number | undefined>(working.length);
  let headCursor = 0;
  for (const chunk of chunks) {
    const range = headRangeForIndexChunk(
      indexToHead,
      chunk.aStart,
      chunk.aEnd,
      head.length
    );
    const start = Math.max(headCursor, range.start);
    while (headCursor < start) {
      out.push(head[headCursor++]);
    }
    headCursor = Math.max(headCursor, range.end);
    for (
      let workingIndex = chunk.bStart;
      workingIndex < chunk.bEnd;
      workingIndex++
    ) {
      workingToView[workingIndex] = out.length;
      out.push(working[workingIndex]);
    }
  }
  while (headCursor < head.length) {
    out.push(head[headCursor++]);
  }
  return { lines: out, workingToView };
}

/** 0-based 줄 매핑 배열을 화면/Monaco 가 쓰는 1-based 줄 번호로 바꾼다. */
function toOneBasedLineMap(
  map: Array<number | undefined>
): Array<number | undefined> {
  return map.map((line) => (line === undefined ? undefined : line + 1));
}

/** 매핑 계산 실패 시 working 문서 자체를 표시한다고 보고 identity 매핑을 만든다. */
function fallbackWorkingView(working: string): WorkingContentWithoutStagedView {
  const workingContent = splitContent(working);
  const identity = workingContent.lines.map((_, index) => index + 1);
  return {
    text: working,
    indexToHeadLine: identity,
    indexToHeadDisplayLine: identity,
    workingToViewLine: identity,
  };
}

/** index diff chunk 가 HEAD 의 어느 범위를 대체하는지 계산한다. */
function headRangeForIndexChunk(
  indexToHead: Array<number | undefined>,
  start: number,
  end: number,
  headLength: number
): { start: number; end: number } {
  const mapped = indexToHead
    .slice(start, end)
    .filter((item): item is number => item !== undefined);
  if (mapped.length) {
    return {
      start: Math.min(...mapped),
      end: Math.max(...mapped) + 1,
    };
  }
  const boundary = headBoundaryForIndexPosition(indexToHead, start, headLength);
  return { start: boundary, end: boundary };
}

/** index 경계 위치를 HEAD 경계 위치로 변환한다. */
function headBoundaryForIndexPosition(
  indexToHead: Array<number | undefined>,
  indexPosition: number,
  headLength: number
): number {
  for (let i = indexPosition - 1; i >= 0; i--) {
    const mapped = indexToHead[i];
    if (mapped !== undefined) {
      return mapped + 1;
    }
  }
  for (let i = indexPosition; i < indexToHead.length; i++) {
    const mapped = indexToHead[i];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  return headLength;
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
