// GitHub suggested changeset HTML table 을 표시용 diff row 로 파싱한다.
// - 웹 HTML 수집 서비스가 커지지 않도록 table row 파싱 책임을 분리한다.
import { EncodedSuggestedChangeRow } from "../utils/suggestedChangeFormat";

/**
 * GitHub suggested changeset table 을 실제 diff row 로 읽는다.
 * - addition 만 뽑으면 문맥 줄이 삭제처럼 보일 수 있어서 row kind 와 old/new 라인 번호를 보존한다.
 * @param html suggested changeset HTML 조각
 * @returns 표시용 diff row 목록
 */
export function suggestedDiffRowsFromBlob(html: string): EncodedSuggestedChangeRow[] {
  const rows: EncodedSuggestedChangeRow[] = [];
  for (const rowHtml of tableRows(html)) {
    const code = blobCodeCell(rowHtml);
    if (!code) {
      continue;
    }
    rows.push({
      kind: code.kind,
      oldLine: code.kind === "add" ? undefined : blobLineNumber(rowHtml, "old"),
      newLine: code.kind === "delete" ? undefined : blobLineNumber(rowHtml, "new"),
      text: code.text,
    });
  }
  return rows;
}

/**
 * HTML table row 조각을 순서대로 추출한다.
 * @param html suggested changeset HTML 조각
 * @returns tr HTML 배열
 */
function tableRows(html: string): string[] {
  return Array.from(
    html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi),
    (match) => match[0]
  );
}

/**
 * GitHub blob-code cell 에서 row kind 와 코드 텍스트를 읽는다.
 * @param rowHtml tr HTML 조각
 * @returns diff row code cell 정보
 */
function blobCodeCell(
  rowHtml: string
): { kind: EncodedSuggestedChangeRow["kind"]; text: string } | undefined {
  const match = /<td\b[^>]*class=["']([^"']*\bblob-code\b[^"']*)["'][^>]*>([\s\S]*?)<\/td>/i.exec(rowHtml);
  if (!match) {
    return undefined;
  }
  const className = match[1];
  const kind = className.includes("blob-code-addition")
    ? "add"
    : className.includes("blob-code-deletion")
      ? "delete"
      : "context";
  return { kind, text: htmlText(match[2]) };
}

/**
 * GitHub diff table 의 old/new line number cell 을 읽는다.
 * @param rowHtml tr HTML 조각
 * @param side old/new side
 * @returns 1-base 라인 번호
 */
function blobLineNumber(rowHtml: string, side: "old" | "new"): number | undefined {
  const cells = Array.from(
    rowHtml.matchAll(/<td\b[^>]*class=["'][^"']*\bblob-num\b[^"']*["'][^>]*>/gi),
    (match) => match[0]
  );
  const cell = side === "old" ? cells[0] : cells[1] || cells[0];
  const value = cell ? /data-line-number=["']?(\d+)/i.exec(cell)?.[1] : undefined;
  const line = value ? Number(value) : undefined;
  return line && Number.isFinite(line) ? line : undefined;
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
