// diff editor 의 context menu 가 열린 실제 변경 줄을 짧게 보관한다.
// - VS Code 명령 API 는 editor/context 메뉴의 마우스 위치를 직접 주지 않으므로
//   renderer overlay 가 본 visible row 를 command 레이어가 재사용할 수 있게 한다.

export type HunkContextSide = "original" | "modified";

export interface HunkContextLine {
  uri: string;
  side: HunkContextSide;
  line: number;
  column?: number;
  marker?: string;
  text?: string;
  lineIds: string[];
  at: number;
}

let recentContextLine: HunkContextLine | undefined;

/**
 * context menu 가 열린 diff row 를 저장한다.
 * @param line renderer 가 확인한 visible row 정보
 */
export function rememberHunkContextLine(
  line: Omit<HunkContextLine, "at">
): void {
  recentContextLine = { ...line, at: Date.now() };
}

/**
 * 방금 열린 context menu 의 diff row 를 가져온다.
 * - 오래된 우클릭 위치가 나중 명령에 섞이지 않도록 짧은 유효 시간을 둔다.
 * @param uriString 현재 hunk diff 의 modified URI 문자열
 * @param maxAgeMs 사용할 수 있는 최대 age
 * @returns 현재 명령에 쓸 수 있는 context row. 없으면 undefined
 */
export function recentHunkContextLine(
  uriString: string,
  maxAgeMs = 5000
): HunkContextLine | undefined {
  const item = recentContextLine;
  if (!item || item.uri !== uriString || Date.now() - item.at > maxAgeMs) {
    return undefined;
  }
  return item;
}
