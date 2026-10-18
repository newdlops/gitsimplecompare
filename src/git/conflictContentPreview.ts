// 작업트리 Result의 no-follow 읽기와 표시용 Accept Both 미리보기를 공유한다.
import type { ConflictContentSide, ConflictWorkingResult } from "./conflictContentService";
import { resolveSafeConflictWorkingPath } from "./conflictPathSafety";
import { readConflictWorkingLeaf } from "./conflictWorktreeCas";
import { MAX_CONFLICT_TEXT_BYTES } from "./conflictBlobReader";
import { decodeUtf8 } from "../utils/textEncoding";
import { acceptAllConflictBlocks } from "../utils/conflictMarkerModel";

/**
 * 실제 Result를 링크를 따라가지 않고 읽고 원문 전체 기준 CAS identity를 반환한다.
 * @param root 저장소 루트 @param rel 검증할 상대 경로 @param forcedBinary 현재 -diff 속성
 * @param truncate 표시 문자열을 prefix로 제한하면 true. version은 항상 전체 원문 기준이다.
 * @param knownSubmodule index에서 gitlink를 확인했으면 디렉터리를 submodule로 분류한다.
 * @param signal 표시 조회 수명이 끝날 때 취소하는 신호
 * @returns 존재·종류·표시 본문·opaque version을 포함한 현재 작업 파일 상태
 */
export async function readConflictWorkingResult(
  root: string, rel: string, forcedBinary: boolean, truncate = true, knownSubmodule = false, signal?: AbortSignal
): Promise<ConflictWorkingResult> {
  const absolute = await resolveSafeConflictWorkingPath(root, rel);
  const snapshot = await readConflictWorkingLeaf(absolute, signal);
  if (snapshot.kind === "absent") {
    return { content: "", state: { exists: false, kind: "absent" }, version: snapshot.version };
  }
  if (snapshot.kind === "symlink") {
    return { content: decodeUtf8(snapshot.buffer!) || "", state: { exists: true, kind: "symlink" }, version: snapshot.version };
  }
  if (snapshot.kind === "nonfile") {
    return { content: "", state: { exists: true, kind: knownSubmodule ? "submodule" : "nonfile" }, version: snapshot.version };
  }
  const buffer = snapshot.buffer!;
  const decoded = forcedBinary ? undefined : decodeUtf8(buffer);
  if (decoded === undefined) {
    return { content: "", state: { exists: true, kind: "binary" }, version: snapshot.version };
  }
  const truncated = truncate && buffer.length > MAX_CONFLICT_TEXT_BYTES;
  return { content: truncated ? buffer.subarray(0, MAX_CONFLICT_TEXT_BYTES).toString("utf8") : decoded,
    state: { exists: true, kind: "text", truncated: truncated || undefined }, version: snapshot.version };
}

/**
 * 완전한 marker와 두 text side가 있는 경우에만 Current/Incoming 결합 미리보기를 만든다.
 * @param current index stage 2 표시 내용 @param incoming index stage 3 표시 내용
 * @param result 방금 읽은 Result. 잘린 본문이나 특수 파일은 결합하지 않는다.
 * @returns 안전하게 결합할 수 있으면 available=true와 결합 문자열, 아니면 빈 미리보기
 */
export function conflictBothPreview(
  current: ConflictContentSide, incoming: ConflictContentSide, result: ConflictWorkingResult
): { available: boolean; content: string } {
  if (!current.exists || !incoming.exists || current.kind !== "text" || incoming.kind !== "text"
    || current.truncated || incoming.truncated || result.state.kind !== "text" || result.state.truncated) {
    return { available: false, content: "" };
  }
  const combined = acceptAllConflictBlocks(result.content);
  return combined !== undefined && combined !== result.content
    ? { available: true, content: combined } : { available: false, content: "" };
}
