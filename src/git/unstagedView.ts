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
  return buildWorkingView(head, index, working, false).text;
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
  return buildWorkingView(head, index, working, true);
}

/**
 * 텍스트와 overlay가 같은 병합 규칙을 공유하되 표시용 배열은 필요한 호출에만 만든다.
 * @param includeMappings true면 표시 좌표를 만들고, false면 필수 index→HEAD 매핑만 사용한다.
 * @returns staged 변경을 제거한 텍스트와 요청한 경우의 줄 매핑
 */
function buildWorkingView(head: string, index: string, working: string, includeMappings: boolean): WorkingContentWithoutStagedView {
  try {
    const headContent = splitContent(head);
    const indexContent = splitContent(index);
    const workingContent = splitContent(working);
    const indexToHead = mapIndexLinesToHead(
      headContent.lines,
      indexContent.lines
    );
    const boundaries = indexHeadBoundaries(indexToHead, headContent.lines.length);
    const indexToHeadDisplay = includeMappings
      ? mapIndexLinesToHeadDisplay(indexToHead, headContent.lines.length, boundaries) : [];
    const unstagedChunks = diffChunks(indexContent.lines, workingContent.lines);
    const merged = applyIndexToWorkingChunksToHead(
      headContent.lines,
      workingContent.lines,
      indexToHead,
      unstagedChunks,
      boundaries,
      includeMappings
    );
    return {
      text: joinContent({
        lines: merged.lines,
        finalNewline: workingContent.finalNewline,
      }),
      indexToHeadLine: includeMappings ? toOneBasedLineMap(indexToHead) : [],
      indexToHeadDisplayLine: toOneBasedLineMap(indexToHeadDisplay),
      workingToViewLine: toOneBasedLineMap(merged.workingToView),
    };
  } catch {
    return includeMappings ? fallbackWorkingView(working)
      : { text: working, indexToHeadLine: [], indexToHeadDisplayLine: [], workingToViewLine: [] };
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
  headLength: number,
  boundaries: number[]
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
    const boundary = boundaries[start];
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
  chunks: EditChunk[],
  boundaries: number[],
  includeMappings: boolean
): { lines: string[]; workingToView: Array<number | undefined> } {
  const out: string[] = [];
  const workingToView = new Array<number | undefined>(includeMappings ? working.length : 0);
  let headCursor = 0;
  for (const chunk of chunks) {
    const range = headRangeForIndexChunk(
      indexToHead,
      chunk.aStart,
      chunk.aEnd,
      boundaries
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
      if (includeMappings) workingToView[workingIndex] = out.length;
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
  boundaries: number[]
): { start: number; end: number } {
  let first: number | undefined, last: number | undefined;
  for (let i = start; i < end; i++) {
    const mapped = indexToHead[i];
    if (mapped !== undefined) { first ??= mapped; last = mapped; }
  }
  if (first !== undefined && last !== undefined) return { start: first, end: last + 1 };
  const boundary = boundaries[start];
  return { start: boundary, end: boundary };
}

/**
 * 모든 index 경계의 HEAD 위치를 두 번의 선형 순회로 구한다. 이전 동일 줄을 다음 동일 줄보다 우선한다.
 * @param indexToHead 순서가 유지된 정확 매핑 @param headLength 매핑이 전혀 없을 때 사용할 끝 경계
 * @returns index.length + 1개 경계 위치. 변경 블록마다 다시 앞뒤를 검색하지 않는다.
 */
function indexHeadBoundaries(
  indexToHead: Array<number | undefined>,
  headLength: number
): number[] {
  const boundaries = new Array<number>(indexToHead.length + 1);
  let previous: number | undefined;
  for (let i = 0; i <= indexToHead.length; i++) {
    boundaries[i] = previous === undefined ? -1 : previous + 1;
    if (indexToHead[i] !== undefined) previous = indexToHead[i];
  }
  let next = headLength;
  for (let i = indexToHead.length; i >= 0; i--) {
    if (indexToHead[i] !== undefined) next = indexToHead[i]!;
    if (boundaries[i] === -1) boundaries[i] = next;
  }
  return boundaries;
}

/** LCS 기반 줄 diff 를 edit chunk 배열로 만든다. */
export function diffChunks(a: string[], b: string[]): EditChunk[] {
  // 뒤쪽 공통 줄을 제외하면 반복 줄의 LCS 동률 선택이 달라진다. 앞쪽 일치만 기존 복원과 동일하다.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  if (prefix) {
    return diffChunks(a.slice(prefix), b.slice(prefix)).map(chunk => ({
      aStart: chunk.aStart + prefix, aEnd: chunk.aEnd + prefix,
      bStart: chunk.bStart + prefix, bEnd: chunk.bEnd + prefix,
    }));
  }
  if (!a.length || !b.length) return a.length || b.length
    ? [{ aStart: 0, aEnd: a.length, bStart: 0, bEnd: b.length }] : [];
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
