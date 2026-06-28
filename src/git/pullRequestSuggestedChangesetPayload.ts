// GitHub Copilot review partial HTML 안에 들어 있는 suggestion JSON payload 를 파싱한다.
// - 일부 Copilot suggested changeset 은 DOM diff table 이 아니라 data payload 의 diffEntries 로만 내려온다.

/** comment id 별 suggested changeset 코드 */
export type SuggestedChangesetPayloadMap = Map<string, string[]>;

interface JsonValueRange {
  start: number;
  end: number;
  value: unknown;
}

interface DiffEntryPayload {
  path?: unknown;
  diffLines?: unknown;
}

interface DiffLinePayload {
  html?: unknown;
  text?: unknown;
  type?: unknown;
}

/**
 * GitHub HTML 에서 Copilot suggested changeset JSON payload 를 읽는다.
 * - review partial 의 data payload 에 있는 `suggestion.diffEntries[].diffLines[]` 를 사용한다.
 * - payload 주변의 `discussion_r{id}` anchor 를 찾아 REST review comment id 와 연결한다.
 * @param html GitHub PR/review partial HTML
 * @returns comment id 별 suggested changeset 코드 배열
 */
export function parseCopilotSuggestedChangesetPayloads(
  html: string
): SuggestedChangesetPayloadMap {
  const decoded = decodeHtmlEntities(html);
  const result: SuggestedChangesetPayloadMap = new Map();
  for (const payload of suggestionPayloads(decoded)) {
    const id = nearestCommentId(decoded, payload.start, payload.end);
    if (!id) {
      continue;
    }
    const suggestions = suggestedChangesetsFromPayload(payload.value);
    if (suggestions.length) {
      result.set(id, unique([...(result.get(id) || []), ...suggestions]));
    }
  }
  return result;
}

/**
 * HTML 문자열 안의 `"suggestion": {...}` JSON 값을 순회한다.
 * - 전체 data payload 를 알 필요 없이 suggestion object 만 균형 괄호로 잘라 JSON.parse 한다.
 * - 문자열 내부 brace 는 JSON string escape 상태를 추적해 무시한다.
 * @param source HTML entity 를 디코딩한 문자열
 * @returns suggestion JSON object 와 원문 위치
 */
function suggestionPayloads(source: string): JsonValueRange[] {
  const result: JsonValueRange[] = [];
  const pattern = /"suggestion"\s*:/g;
  for (const match of source.matchAll(pattern)) {
    const valueStart = skipWhitespace(source, (match.index || 0) + match[0].length);
    if (source.startsWith("null", valueStart) || source[valueStart] !== "{") {
      continue;
    }
    const json = extractJsonObject(source, valueStart);
    if (!json) {
      continue;
    }
    try {
      result.push({
        start: match.index || valueStart,
        end: json.end,
        value: JSON.parse(json.text),
      });
    } catch {
      continue;
    }
  }
  return result;
}

/**
 * suggestion payload 에서 실제 제안 코드만 추출한다.
 * - GitHub payload 는 diff line type 을 `ADDITION`/`DELETION`/`CONTEXT` 로 내려준다.
 * - 기존 렌더러는 suggestion 코드만 받으므로 addition 줄을 모아 반환하고, 삭제-only 제안은 빈 문자열로 표현한다.
 * @param value JSON.parse 된 suggestion object
 * @returns suggested changeset 코드 배열
 */
function suggestedChangesetsFromPayload(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.diffEntries)) {
    return [];
  }
  const suggestions: string[] = [];
  for (const entry of value.diffEntries) {
    const suggestion = suggestedChangesetFromEntry(entry);
    if (suggestion !== undefined) {
      suggestions.push(suggestion);
    }
  }
  return unique(suggestions);
}

/**
 * 파일 하나의 diff entry 에서 addition 줄을 suggested changeset 코드로 만든다.
 * @param value JSON payload 의 diff entry
 * @returns addition code. 삭제-only 제안이면 빈 문자열, 제안이 아니면 undefined
 */
function suggestedChangesetFromEntry(value: unknown): string | undefined {
  if (!isDiffEntryPayload(value) || !Array.isArray(value.diffLines)) {
    return undefined;
  }
  const additions: string[] = [];
  let hasDeletion = false;
  for (const line of value.diffLines) {
    if (!isDiffLinePayload(line)) {
      continue;
    }
    const type = String(line.type || "").toUpperCase();
    if (type.includes("ADD")) {
      additions.push(diffLineText(line));
    } else if (type.includes("DEL")) {
      hasDeletion = true;
    }
  }
  if (additions.length) {
    return additions.join("\n").replace(/(?:\r?\n|\r)+$/g, "");
  }
  return hasDeletion ? "" : undefined;
}

/**
 * JSON diff line 에서 코드 텍스트를 읽는다.
 * @param line GitHub diff line payload
 * @returns 코드 텍스트. text 가 없으면 html 을 태그 제거 후 사용한다.
 */
function diffLineText(line: DiffLinePayload): string {
  if (typeof line.text === "string") {
    return line.text;
  }
  if (typeof line.html === "string") {
    return htmlText(line.html);
  }
  return "";
}

/**
 * 문자열의 지정 위치부터 JSON object 하나를 균형 괄호로 추출한다.
 * @param source 전체 문자열
 * @param start object 시작 위치
 * @returns JSON text 와 끝 위치. 유효하지 않으면 undefined
 */
function extractJsonObject(
  source: string,
  start: number
): { text: string; end: number } | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return {
          text: source.slice(start, index + 1),
          end: index + 1,
        };
      }
    }
  }
  return undefined;
}

/**
 * suggested payload 주변에서 가장 가까운 GitHub review comment id 를 찾는다.
 * @param html HTML entity 를 디코딩한 전체 문자열
 * @param start payload 시작 위치
 * @param end payload 끝 위치
 * @returns review comment id 또는 undefined
 */
function nearestCommentId(html: string, start: number, end: number): string | undefined {
  const before = html.slice(Math.max(0, start - 120000), start);
  const after = html.slice(end, Math.min(html.length, end + 20000));
  const beforeIds = Array.from(before.matchAll(commentIdPattern()), (match) => matchedCommentId(match));
  const afterId = commentIdPattern().exec(after);
  return (afterId ? matchedCommentId(afterId) : undefined) || beforeIds.filter(Boolean).pop();
}

/**
 * GitHub HTML 에서 review comment id 로 쓰이는 대표 패턴을 만든다.
 * @returns comment id 추출 정규식
 */
function commentIdPattern(): RegExp {
  return /(?:discussion_r|pullrequestreviewcomment-|review-comment-|comment-)(\d+)/g;
}

/**
 * comment id 정규식 match 에서 id 문자열만 꺼낸다.
 * @param match RegExp match
 * @returns comment id
 */
function matchedCommentId(match: RegExpMatchArray): string | undefined {
  return match[1];
}

/**
 * HTML 조각을 코드 텍스트로 디코딩한다.
 * @param value HTML 조각
 * @returns 사람이 읽을 수 있는 코드 텍스트
 */
function htmlText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, "")
      .replace(/<[^>]+>/g, "")
  );
}

/**
 * HTML entity 를 최소한의 코드 표시용 텍스트로 바꾼다.
 * @param value entity 가 포함된 텍스트
 * @returns 디코딩된 텍스트
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (match, code: string) => decodeCodePoint(match, Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (match, code: string) => decodeCodePoint(match, parseInt(code, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

/**
 * 숫자 HTML entity code point 를 안전하게 문자로 바꾼다.
 * @param fallback 디코딩할 수 없을 때 유지할 원문
 * @param codePoint entity 가 가리키는 Unicode code point
 * @returns 디코딩된 문자 또는 fallback
 */
function decodeCodePoint(fallback: string, codePoint: number): string {
  try {
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 공백이 아닌 첫 위치로 이동한다.
 * @param source 전체 문자열
 * @param start 검색 시작 위치
 * @returns 공백을 건너뛴 index
 */
function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) {
    index++;
  }
  return index;
}

/** 값이 일반 object 인지 확인한다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 값이 GitHub diff entry payload 처럼 보이는지 확인한다. */
function isDiffEntryPayload(value: unknown): value is DiffEntryPayload {
  return isRecord(value);
}

/** 값이 GitHub diff line payload 처럼 보이는지 확인한다. */
function isDiffLinePayload(value: unknown): value is DiffLinePayload {
  return isRecord(value);
}

/** 중복 문자열을 입력 순서대로 제거한다. */
function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
