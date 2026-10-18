// index stage의 mode와 불변 OID로 표시 내용을 읽는다. 작업트리/해결 mutation과 분리한다.
import type { ConflictContentSide } from "./conflictContentService";
import type { UnmergedStageEntry } from "./unmergedFiles";
import { conflictBlobReader, MAX_CONFLICT_TEXT_BYTES, type ConflictBlobPreview } from "./conflictBlobReader";
import { runGitBuffer } from "./gitExec";
import { decodeUtf8 } from "../utils/textEncoding";

/**
 * index stage 객체를 text/binary/submodule/symlink/absent로 분류한다.
 * @param repoRoot 저장소 루트 @param stage 표시할 index stage 1/2/3
 * @param entries 이번 조회에서 읽은 stage mode/OID @param forcedBinary 현재 attributes의 -diff 여부
 * @param truncate 표시 prefix만 읽을지 여부. 실제 해결은 전체 원문을 읽는다.
 * @param signal 표시 조회의 취소 신호 @param previews 같은 호출에서 배치로 읽은 불변 미리보기
 * @returns stage 존재 여부, 원래 mode/OID와 안전하게 분류한 표시 내용
 */
export async function readConflictStage(
  repoRoot: string,
  stage: 1 | 2 | 3,
  entries: Map<1 | 2 | 3, UnmergedStageEntry>,
  forcedBinary: boolean,
  truncate = true,
  signal?: AbortSignal,
  previews?: ReadonlyMap<string, ConflictBlobPreview>
): Promise<ConflictContentSide> {
  const entry = entries.get(stage);
  if (!entry) return { stage, exists: false, kind: "absent", content: "" };
  if (entry.mode === "160000") {
    return { stage, exists: true, kind: "submodule", oid: entry.oid, mode: entry.mode, content: "" };
  }
  if (entry.mode !== "120000" && truncate) {
    const preview = forcedBinary ? { kind: "binary" as const, content: "" }
      : previews?.get(entry.oid) ?? await conflictBlobReader.read(repoRoot, entry.oid, signal);
    return { stage, exists: true, oid: entry.oid, mode: entry.mode, ...preview };
  }
  const buffer = await runGitBuffer(["cat-file", "blob", entry.oid], repoRoot, { signal, env: { GIT_NO_REPLACE_OBJECTS: "1" } });
  if (entry.mode === "120000") {
    return {
      stage, exists: true, kind: "symlink", oid: entry.oid, mode: entry.mode,
      content: decodeUtf8(buffer) || "",
    };
  }
  const decoded = forcedBinary ? undefined : decodeUtf8(buffer);
  const truncated = decoded !== undefined && truncate && buffer.length > MAX_CONFLICT_TEXT_BYTES;
  return {
    stage,
    exists: true,
    kind: decoded === undefined ? "binary" : "text",
    oid: entry.oid,
    mode: entry.mode,
    truncated: truncated || undefined,
    content: decoded === undefined
      ? ""
      : truncated
        ? buffer.subarray(0, MAX_CONFLICT_TEXT_BYTES).toString("utf8")
        : decoded,
  };
}
