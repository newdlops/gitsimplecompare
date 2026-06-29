// Suggested changeset diff row 를 문자열 필드로 안전하게 전달하기 위한 순수 유틸이다.
// - GitHub/Copilot 웹 HTML 에서 읽은 실제 diff row 를 UI 계층까지 보존한다.

const ENCODED_SUGGESTED_CHANGE_PREFIX = "\u001fGSC_SUGGESTED_CHANGE_V1:";

/** suggested changeset 한 줄의 표시 종류 */
export type SuggestedChangeRowKind = "add" | "delete" | "context";

/** GitHub suggested changeset 에서 보존한 diff row */
export interface EncodedSuggestedChangeRow {
  /** row 종류. 추가/삭제/문맥을 구분해 잘못된 -/+ 표시를 막는다. */
  kind: SuggestedChangeRowKind;
  /** old side 1-base 라인 번호 */
  oldLine?: number;
  /** new side 1-base 라인 번호 */
  newLine?: number;
  /** marker 를 제외한 코드 텍스트 */
  text: string;
}

/**
 * suggested changeset diff row 를 기존 string[] 전달 경로에 넣을 수 있게 인코딩한다.
 * @param rows GitHub/Copilot 에서 읽은 diff row 목록
 * @returns UI 렌더러가 다시 디코딩할 수 있는 문자열
 */
export function encodeSuggestedChangeRows(rows: EncodedSuggestedChangeRow[]): string {
  return `${ENCODED_SUGGESTED_CHANGE_PREFIX}${JSON.stringify(rows)}`;
}

/**
 * 인코딩된 suggested changeset diff row 를 복원한다.
 * @param value suggestedChangesets 배열의 문자열 값
 * @returns 구조화된 diff row. 인코딩 값이 아니거나 유효하지 않으면 undefined
 */
export function decodeSuggestedChangeRows(
  value: string
): EncodedSuggestedChangeRow[] | undefined {
  if (!value.startsWith(ENCODED_SUGGESTED_CHANGE_PREFIX)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value.slice(ENCODED_SUGGESTED_CHANGE_PREFIX.length));
    return Array.isArray(parsed)
      ? parsed.map(normalizeRow).filter(isEncodedSuggestedChangeRow)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * unknown 값을 suggested change row 후보로 정규화한다.
 * @param value JSON.parse 로 얻은 row 후보
 * @returns 정규화된 row 후보
 */
function normalizeRow(value: unknown): EncodedSuggestedChangeRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = normalizeKind(value.kind);
  if (!kind) {
    return undefined;
  }
  return {
    kind,
    oldLine: normalizeLine(value.oldLine),
    newLine: normalizeLine(value.newLine),
    text: typeof value.text === "string" ? value.text : "",
  };
}

/**
 * row kind 값을 허용 목록으로 좁힌다.
 * @param value 검사할 값
 * @returns 유효한 row kind
 */
function normalizeKind(value: unknown): SuggestedChangeRowKind | undefined {
  return value === "add" || value === "delete" || value === "context"
    ? value
    : undefined;
}

/**
 * line number 값을 1-base 양의 정수로 정규화한다.
 * @param value 검사할 값
 * @returns 유효한 라인 번호
 */
function normalizeLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * 디코딩된 row 가 실제 렌더링 가능한지 확인한다.
 * @param value 정규화 후보
 * @returns 렌더링 가능한 row 이면 true
 */
function isEncodedSuggestedChangeRow(
  value: EncodedSuggestedChangeRow | undefined
): value is EncodedSuggestedChangeRow {
  return Boolean(value);
}

/** 값이 일반 object 인지 확인한다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
