// GitHub HTML을 comment별 코드 제안으로 바꾸는 순수 파서다. 인증과 전송을 수행하지 않는다.
import { parseCopilotSuggestedChangesetPayloads } from "./pullRequestSuggestedChangesetPayload";
import { suggestedDiffRowsFromBlob } from "./pullRequestSuggestedChangesetHtmlRows";
import { encodeSuggestedChangeRows } from "../utils/suggestedChangeFormat";

/**
 * GitHub HTML 에서 comment id 별 suggested changeset 을 파싱한다.
 * @param html PR files 웹 HTML
 * @returns comment id 별 suggested changeset 배열
 */
export function parsePullRequestSuggestedChangesets(html: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  mergeSuggestedChangesets(result, parseCopilotSuggestedChangesetPayloads(html));
  const positions = Array.from(html.matchAll(/discussion_r(\d+)/g));
  for (let index = 0; index < positions.length; index++) {
    const id = positions[index][1];
    const start = positions[index].index || 0;
    const end = positions[index + 1]?.index || html.length;
    const block = html.slice(start, end);
    const suggestions = suggestedChangesetsFromBlock(block);
    if (suggestions.length) {
      result.set(id, unique([...(result.get(id) || []), ...suggestions]));
    }
  }
  for (const item of suggestedChangesetElements(html)) {
    const id = nearestCommentId(html, item.start, item.end);
    if (!id) {
      continue;
    }
    const suggestions = suggestedChangesetsFromBlock(item.html);
    if (suggestions.length) {
      result.set(id, unique([...(result.get(id) || []), ...suggestions]));
    }
  }
  return result;
}

/**
 * suggested changeset map 을 다른 map 에 병합한다.
 * @param target 병합 대상
 * @param source 새로 읽은 comment id 별 suggested changeset
 */
export function mergeSuggestedChangesets(
  target: Map<string, string[]>,
  source: Map<string, string[]>
): void {
  for (const [id, suggestions] of source) {
    target.set(id, unique([...(target.get(id) || []), ...suggestions]));
  }
}

/**
 * comment HTML 조각 안의 suggested changeset 코드만 추출한다.
 * @param block comment 주변 HTML
 * @returns suggested changeset 코드 배열
 */
function suggestedChangesetsFromBlock(block: string): string[] {
  const suggestions: string[] = [];
  for (const part of elementsByClass(block, "js-suggested-changes-blob").map((item) => item.html)) {
    const rows = suggestedDiffRowsFromBlob(part);
    if (rows.some((row) => row.kind !== "context")) {
      suggestions.push(encodeSuggestedChangeRows(rows));
      continue;
    }
    const additions = blobCodeLines(part, "blob-code-addition");
    if (additions.length) {
      suggestions.push(additions.join("\n"));
      continue;
    }
    if (blobCodeLines(part, "blob-code-deletion").length) {
      suggestions.push("");
    }
  }
  return unique(suggestions);
}

/** class 로 찾은 HTML element 조각과 원문 위치 */
interface HtmlElementRange {
  /** element 시작 index */
  start: number;
  /** element 끝 index */
  end: number;
  /** element HTML */
  html: string;
}

/**
 * 전체 HTML 에서 suggested changeset blob element 를 위치 정보와 함께 찾는다.
 * @param html 검색할 HTML
 * @returns suggested changeset blob element 목록
 */
function suggestedChangesetElements(html: string): HtmlElementRange[] {
  return elementsByClass(html, "js-suggested-changes-blob");
}

/**
 * 특정 class 를 가진 div element 들을 균형 잡힌 HTML 조각으로 잘라낸다.
 * @param html 검색할 HTML
 * @param className 찾을 class 이름
 * @returns 해당 element HTML 조각과 원문 위치 배열
 */
function elementsByClass(html: string, className: string): HtmlElementRange[] {
  const result: HtmlElementRange[] = [];
  const pattern = new RegExp(`<div\\b[^>]*class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>`, "gi");
  for (const match of html.matchAll(pattern)) {
    const start = match.index || 0;
    const end = balancedDivEnd(html, start);
    if (end > start) {
      result.push({ start, end, html: html.slice(start, end) });
    }
  }
  return result;
}

/**
 * suggested changeset blob 주변에서 가장 가까운 GitHub review comment id 를 찾는다.
 * - GitHub HTML fragment 는 comment anchor 가 blob 앞/뒤 어느 쪽에 놓일 수 있어 양방향을 확인한다.
 * @param html 전체 HTML
 * @param start blob 시작 index
 * @param end blob 끝 index
 * @returns review comment id 또는 undefined
 */
function nearestCommentId(html: string, start: number, end: number): string | undefined {
  const before = html.slice(Math.max(0, start - 120000), start);
  const after = html.slice(end, Math.min(html.length, end + 20000));
  const beforeIds = Array.from(before.matchAll(commentIdPattern()), (match) => matchedCommentId(match));
  const afterId = commentIdPattern().exec(after);
  return beforeIds.filter(Boolean).pop() || (afterId ? matchedCommentId(afterId) : undefined);
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
 * div 시작 위치에서 대응되는 닫는 div 끝 위치를 찾는다.
 * @param html 전체 HTML
 * @param start div 시작 위치
 * @returns 닫는 div 뒤 위치. 찾지 못하면 html 끝
 */
function balancedDivEnd(html: string, start: number): number {
  const tagPattern = /<\/?div\b[^>]*>/gi;
  tagPattern.lastIndex = start;
  let depth = 0;
  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    const tag = match[0];
    if (tag.startsWith("</")) {
      depth--;
      if (depth === 0) {
        return tagPattern.lastIndex;
      }
    } else if (!tag.endsWith("/>")) {
      depth++;
    }
  }
  return html.length;
}

/**
 * GitHub blob-code table cell 에서 코드 줄을 읽는다.
 * @param html suggested changeset HTML 조각
 * @param className addition/deletion cell class
 * @returns 디코딩된 코드 줄 배열
 */
function blobCodeLines(html: string, className: string): string[] {
  const result: string[] = [];
  const pattern = new RegExp(`<td\\b[^>]*class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/td>`, "gi");
  for (const match of html.matchAll(pattern)) {
    result.push(htmlText(match[1]));
  }
  return result;
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

/** HTML entity 를 최소한의 코드 표시용 텍스트로 바꾼다. */
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

/** 숫자 HTML entity code point 를 안전하게 문자로 바꾼다. */
function decodeCodePoint(fallback: string, codePoint: number): string {
  try {
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : fallback;
  } catch {
    return fallback;
  }
}

/** 중복 문자열을 입력 순서대로 제거한다. */
function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

/** 정규식에 넣을 문자열을 escape 한다. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

