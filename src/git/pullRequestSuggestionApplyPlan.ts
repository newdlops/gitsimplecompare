// GitHub suggestion을 현재 작업 문서에 적용하기 전 exact-match preview를 만드는 순수 서비스.
// - 파일 I/O와 VS Code API를 쓰지 않아 coordinator가 읽은 head/worktree 본문을 안전하게 검증할 수 있다.
import { createHash } from "node:crypto";

/** suggestion이 대체할 1-base inclusive source line 범위. */
export interface PullRequestSuggestionRange {
  /** 대체할 첫 줄 */
  startLine: number;
  /** 대체할 마지막 줄 */
  endLine: number;
}

/** preview/apply에 필요한 text offset과 compare-and-swap identity. */
export interface PullRequestSuggestionApplyPreview {
  /** 원본 working document 전체의 SHA-256 identity */
  documentHash: string;
  /** UTF-16 text offset 기준 대체 시작 위치 */
  startOffset: number;
  /** UTF-16 text offset 기준 대체 끝 위치 */
  endOffset: number;
  /** 사용자가 확인할 PR head 원문 범위 */
  before: string;
  /** 문서 EOL을 보존해 만들 replacement */
  after: string;
  /** 적용 뒤 전체 문서 hash. undo CAS에 쓴다. */
  appliedHash: string;
}

/** 원문 불일치·범위 오류를 UI가 안전한 unavailable 상태로 바꿀 수 있는 오류다. */
export class PullRequestSuggestionApplyError extends Error {
  public constructor(public readonly code: "INVALID_RANGE" | "SOURCE_MISMATCH") {
    super(code === "INVALID_RANGE"
      ? "The suggestion range is unavailable in the current pull request head."
      : "The working document differs from the pull request head at this suggestion. Reload or resolve local edits first.");
    this.name = "PullRequestSuggestionApplyError";
  }
}

/** PR head 원문과 working document의 target range가 정확히 일치할 때만 replacement preview를 만든다. */
export function createPullRequestSuggestionApplyPreview(
  headText: string,
  documentText: string,
  range: PullRequestSuggestionRange,
  replacement: string,
  eol: "\n" | "\r\n" = "\n"
): PullRequestSuggestionApplyPreview {
  const offsets = lineRangeOffsets(headText, range);
  const sourceBefore = headText.slice(offsets.startOffset, offsets.endOffset);
  const documentOffsets = lineRangeOffsets(documentText, range);
  const documentBefore = documentText.slice(documentOffsets.startOffset, documentOffsets.endOffset);
  if (normalizeEol(sourceBefore) !== normalizeEol(documentBefore)) {
    throw new PullRequestSuggestionApplyError("SOURCE_MISMATCH");
  }
  const after = normalizeEol(replacement).replace(/\n/g, eol);
  const applied = `${documentText.slice(0, documentOffsets.startOffset)}${after}${documentText.slice(documentOffsets.endOffset)}`;
  return {
    documentHash: hash(documentText),
    startOffset: documentOffsets.startOffset,
    endOffset: documentOffsets.endOffset,
    before: documentBefore,
    after,
    appliedHash: hash(applied),
  };
}

/** text 전체와 preview hash가 같아 concurrent edit 없이 apply/undo할 수 있는지 확인한다. */
export function matchesPullRequestSuggestionDocument(text: string, expectedHash: string): boolean {
  return hash(text) === expectedHash;
}

/** inclusive 1-base line range를 text offset으로 바꾸고 범위 오류를 명시적으로 거부한다. */
function lineRangeOffsets(text: string, range: PullRequestSuggestionRange): { startOffset: number; endOffset: number } {
  if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine) || range.startLine <= 0 || range.endLine < range.startLine) {
    throw new PullRequestSuggestionApplyError("INVALID_RANGE");
  }
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  const startOffset = starts[range.startLine - 1];
  const afterEndLine = starts[range.endLine];
  if (startOffset === undefined || (range.endLine < starts.length && afterEndLine === undefined)) {
    throw new PullRequestSuggestionApplyError("INVALID_RANGE");
  }
  const endOffset = afterEndLine === undefined ? text.length : afterEndLine;
  return { startOffset, endOffset };
}

/** 비교에는 EOL만 정규화하고 코드의 모든 공백·마지막 줄 상태는 그대로 보존한다. */
function normalizeEol(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** persisted preview/CAS에 쓸 짧고 안정적인 SHA-256 identity를 만든다. */
function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
