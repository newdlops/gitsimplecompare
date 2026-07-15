// conflict marker text를 UI와 편집 명령이 함께 사용할 구조로 변환하는 순수 모델.
// - VS Code API나 Git 접근 없이 줄/offset만 계산해 decoration, CodeLens, block 수용이 같은 해석을 쓴다.

/** conflict marker 한 줄이 블록 안에서 맡는 역할이다. */
export type ConflictMarkerKind =
  | "current-start"
  | "base-start"
  | "incoming-start"
  | "block-end";

/** Current/Incoming 중 사용자가 한 블록에 적용할 선택이다. */
export type ConflictBlockChoice = "current" | "incoming" | "both";

/** 화면에서 action을 붙일 수 있는 완결된 conflict marker 블록이다. */
export interface ConflictMarkerBlock {
  /** 현재 문서 안에서 줄 범위가 바뀌면 함께 바뀌는 stale-safe 식별자 */
  id: string;
  /** `<<<<<<<` marker의 zero-based 줄 번호 */
  startLine: number;
  /** `=======` marker의 zero-based 줄 번호 */
  separatorLine: number;
  /** `>>>>>>>` marker의 zero-based 줄 번호 */
  endLine: number;
  /** diff3 형식의 Base 구획이 있으면 그 marker 줄 번호 */
  baseLine?: number;
}

/** marker와 역할별 본문 줄을 한 번의 파싱으로 얻은 결과다. */
export interface ConflictMarkerScan {
  blocks: ConflictMarkerBlock[];
  current: number[];
  base: number[];
  incoming: number[];
  markers: Array<{ line: number; kind: ConflictMarkerKind }>;
}

interface TextLine {
  line: number;
  start: number;
  end: number;
  text: string;
}

interface ParsedBlock extends ConflictMarkerBlock {
  startOffset: number;
  endOffset: number;
  currentStart: number;
  currentEnd: number;
  incomingStart: number;
  incomingEnd: number;
}

/** 공개 scan 결과에서 block만 mutation용 offset을 포함한 내부 타입으로 바꾼다. */
interface ParsedConflictMarkerScan extends Omit<ConflictMarkerScan, "blocks"> {
  blocks: ParsedBlock[];
}

type Section = "outside" | "current" | "base" | "incoming";

/**
 * 전체 Result text를 역할별 줄과 완결된 marker 블록으로 파싱한다.
 * - 불완전하거나 중첩된 블록에는 action block을 만들지 않아 잘못된 범위를 교체하지 않는다.
 * @param raw 실제 editor document의 전체 문자열
 * @returns decoration/CodeLens가 공유할 zero-based 줄 정보
 */
export function scanConflictMarkers(raw: string): ConflictMarkerScan {
  const parsed = parseConflictMarkers(raw);
  return {
    blocks: parsed.blocks.map(publicBlock),
    current: parsed.current,
    base: parsed.base,
    incoming: parsed.incoming,
    markers: parsed.markers,
  };
}

/**
 * 완결된 marker 블록 하나를 Current, Incoming 또는 두 본문으로 교체한다.
 * - 전달된 id가 현재 text에서 다시 발견될 때만 적용해 stale CodeLens 클릭을 거부한다.
 * @param raw 현재 editor document 전체 문자열
 * @param blockId CodeLens/overlay snapshot에서 받은 블록 식별자
 * @param choice 결과에 남길 conflict side 조합
 * @returns marker가 제거된 전체 문자열, stale/불완전 블록이면 undefined
 */
export function applyConflictBlockChoice(
  raw: string,
  blockId: string,
  choice: ConflictBlockChoice
): string | undefined {
  const parsed = parseConflictMarkers(raw);
  const block = parsed.blocks.find((item) => item.id === blockId);
  if (!block) {
    return undefined;
  }
  const current = raw.slice(block.currentStart, block.currentEnd);
  const incoming = raw.slice(block.incomingStart, block.incomingEnd);
  const replacement = choice === "current"
    ? current
    : choice === "incoming"
      ? incoming
      : `${current}${incoming}`;
  return `${raw.slice(0, block.startOffset)}${replacement}${raw.slice(block.endOffset)}`;
}

/** 내부 offset을 노출하지 않는 직렬화 가능한 block으로 줄인다. */
function publicBlock(block: ParsedBlock): ConflictMarkerBlock {
  return {
    id: block.id,
    startLine: block.startLine,
    separatorLine: block.separatorLine,
    endLine: block.endLine,
    baseLine: block.baseLine,
  };
}

/** marker state machine을 실행해 UI용 줄과 mutation용 offset을 동시에 만든다. */
function parseConflictMarkers(raw: string): ParsedConflictMarkerScan {
  const scan: ParsedConflictMarkerScan = {
    blocks: [],
    current: [],
    base: [],
    incoming: [],
    markers: [],
  };
  let section: Section = "outside";
  let active: Partial<ParsedBlock> | undefined;
  for (const line of splitLines(raw)) {
    const marker = markerKind(line.text);
    if (marker === "current-start" && section === "outside") {
      section = "current";
      active = {
        startLine: line.line,
        startOffset: line.start,
        currentStart: line.end,
      };
      continue;
    }
    if (marker === "base-start" && section === "current" && active?.baseLine === undefined) {
      section = "base";
      active!.baseLine = line.line;
      active!.currentEnd = line.start;
      continue;
    }
    if (marker === "incoming-start" && (section === "current" || section === "base")) {
      if (active?.currentEnd === undefined) {
        active!.currentEnd = line.start;
      }
      active!.separatorLine = line.line;
      active!.incomingStart = line.end;
      section = "incoming";
      continue;
    }
    if (marker === "block-end" && section === "incoming") {
      if (isCompleteBlock(active)) {
        scan.blocks.push({
          ...active,
          id: `${active.startLine}:${line.line}`,
          endLine: line.line,
          endOffset: line.end,
          incomingEnd: line.start,
        });
      }
      section = "outside";
      active = undefined;
      continue;
    }
    if (marker) {
      section = "outside";
      active = undefined;
    }
  }
  populateLineGroups(scan);
  return scan;
}

/** 완결된 block만 역할별 본문 줄과 marker decoration으로 펼친다. */
function populateLineGroups(scan: ParsedConflictMarkerScan): void {
  for (const block of scan.blocks) {
    scan.markers.push({ line: block.startLine, kind: "current-start" });
    if (block.baseLine !== undefined) {
      scan.markers.push({ line: block.baseLine, kind: "base-start" });
    }
    scan.markers.push(
      { line: block.separatorLine, kind: "incoming-start" },
      { line: block.endLine, kind: "block-end" }
    );
    appendLineRange(
      scan.current,
      block.startLine + 1,
      (block.baseLine ?? block.separatorLine) - 1
    );
    if (block.baseLine !== undefined) {
      appendLineRange(scan.base, block.baseLine + 1, block.separatorLine - 1);
    }
    appendLineRange(scan.incoming, block.separatorLine + 1, block.endLine - 1);
  }
}

/** inclusive line 범위를 대상 배열에 오름차순으로 추가한다. */
function appendLineRange(target: number[], start: number, end: number): void {
  for (let line = start; line <= end; line++) target.push(line);
}

/** 한 줄이 conflict marker token으로 시작하는지 역할과 함께 판별한다. */
function markerKind(text: string): ConflictMarkerKind | undefined {
  if (text.startsWith("<<<<<<<")) return "current-start";
  if (text.startsWith("|||||||")) return "base-start";
  if (text.startsWith("=======")) return "incoming-start";
  if (text.startsWith(">>>>>>>")) return "block-end";
  return undefined;
}

/** block 교체에 필요한 시작/구분 offset이 모두 준비됐는지 좁힌다. */
function isCompleteBlock(active: Partial<ParsedBlock> | undefined): active is Omit<
  ParsedBlock,
  "id" | "endLine" | "endOffset" | "incomingEnd"
> {
  return !!active &&
    active.startLine !== undefined &&
    active.startOffset !== undefined &&
    active.currentStart !== undefined &&
    active.currentEnd !== undefined &&
    active.separatorLine !== undefined &&
    active.incomingStart !== undefined;
}

/** CRLF/LF와 마지막 newline 유무를 보존하면서 각 줄의 byte가 아닌 JS offset을 계산한다. */
function splitLines(raw: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  let line = 0;
  while (start < raw.length) {
    let newline = raw.indexOf("\n", start);
    if (newline < 0) {
      newline = raw.length;
    }
    const end = newline < raw.length ? newline + 1 : raw.length;
    const contentEnd = newline > start && raw.charCodeAt(newline - 1) === 13
      ? newline - 1
      : newline;
    lines.push({ line, start, end, text: raw.slice(start, contentEnd) });
    start = end;
    line++;
  }
  return lines;
}
