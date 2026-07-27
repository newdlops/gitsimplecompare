// GitHub review comment의 suggestion fence를 조립·분석하는 순수 유틸.
// - 웹뷰가 아닌 도메인 레이어에서 wire format과 fence 검증을 공유해 UI마다 다른 suggestion 규칙을 만들지 않게 한다.

const MAX_SUGGESTION_LINES = 100;

/** comment 본문에서 찾은 suggestion 하나와 로컬 적용 전 안전 판단 결과. */
export interface PullRequestReviewSuggestion {
  /** fence 내부 replacement code. 빈 문자열은 삭제 suggestion을 뜻한다. */
  replacement: string;
  /** replacement의 1-base line 수. 빈 replacement는 0이다. */
  lineCount: number;
  /** writer/apply UI가 local bridge를 열어도 되는지 여부 */
  isApplicable: boolean;
  /** 적용하지 않는 경우 UI에 표시할 안정된 이유 */
  reason?: "tooManyLines";
}

/** 일반 설명과 선택 suggestion code를 GitHub review comment body로 합친다. */
export function composePullRequestReviewSuggestionBody(message: string, suggestion?: string): string {
  if (!suggestion?.trim()) return message;
  const normalizedSuggestion = suggestion.replace(/\r\n/g, "\n");
  return message.trim()
    ? `${message}\n\n\`\`\`suggestion\n${normalizedSuggestion}\n\`\`\``
    : `\`\`\`suggestion\n${normalizedSuggestion}\n\`\`\``;
}

/** GitHub Markdown 본문에서 완결된 suggestion fence를 순서대로 추출한다. */
export function parsePullRequestReviewSuggestions(body: string): PullRequestReviewSuggestion[] {
  const lines = splitLinesKeepingEndings(body);
  const suggestions: PullRequestReviewSuggestion[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = parseOpeningFence(lines[index]);
    if (!opening || !/^suggestion\b/i.test(opening.info)) continue;
    const closing = findClosingFence(lines, index + 1, opening);
    if (closing < 0) continue;
    const replacement = stripTrailingLineBreaks(lines.slice(index + 1, closing).join("")).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lineCount = replacement ? replacement.split("\n").length : 0;
    suggestions.push({
      replacement,
      lineCount,
      isApplicable: lineCount <= MAX_SUGGESTION_LINES,
      ...(lineCount > MAX_SUGGESTION_LINES ? { reason: "tooManyLines" as const } : {}),
    });
    index = closing;
  }
  return suggestions;
}

/** 줄바꿈 문자를 보존해 fenced block 경계를 정확히 찾는다. */
function splitLinesKeepingEndings(value: string): string[] {
  return value.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) || [];
}

/** opening fence와 info string을 CommonMark 호환 최소 규칙으로 읽는다. */
function parseOpeningFence(line: string): { char: "`" | "~"; length: number; info: string } | undefined {
  const match = /^[ \t]*(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|\r)?$/.exec(line);
  if (!match) return undefined;
  return { char: match[1][0] as "`" | "~", length: match[1].length, info: match[2].trim() };
}

/** 같은 fence 문자와 opening 이상 길이를 가진 closing fence만 인정한다. */
function findClosingFence(
  lines: readonly string[],
  start: number,
  opening: { char: "`" | "~"; length: number }
): number {
  for (let index = start; index < lines.length; index += 1) {
    const match = /^[ \t]*(`{3,}|~{3,})[ \t]*(?:\r?\n|\r)?$/.exec(lines[index]);
    if (match && match[1][0] === opening.char && match[1].length >= opening.length) return index;
  }
  return -1;
}

/** code 내부 공백은 보존하고 fence 바로 앞의 줄바꿈만 제거한다. */
function stripTrailingLineBreaks(value: string): string {
  return value.replace(/(?:\r?\n|\r)+$/g, "");
}
