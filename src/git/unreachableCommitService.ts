// ref/reflog에서 도달하지 못하는 복구 후보를 읽는다. fsck와 metadata 출력은 스트림으로 소비한다.
import { StringDecoder } from "node:string_decoder";
import { runGitStream, runGitStreamWithInput } from "./gitExec";
import { TopK } from "../utils/topK";
import { logError } from "../ui/outputLog";

/** fsck로 찾은 unreachable commit의 UI 표시용 메타데이터다. */
export interface UnreachableCommitRecord {
  hash: string;
  parentHashes: string[];
  timestamp: number;
  dateIso?: string;
  message: string;
}

/**
 * 객체를 검사한 뒤 모든 commit을 한 metadata 프로세스로 읽고 최신 K개만 보관한다.
 * @param repoRoot 조회 저장소 @param limit 반환할 최대 개수 @param signal 소비자가 필요 없어진 조회 취소
 * @returns 최신순 복구 후보. 보조 조회 오류는 로그를 남기고 빈 결과, 취소는 원래 오류로 전달한다.
 */
export async function readUnreachableCommitRecords(repoRoot: string, limit: number, signal?: AbortSignal): Promise<UnreachableCommitRecord[]> {
  signal?.throwIfAborted();
  const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (!count) return [];
  try {
    const hashes = new Set<string>();
    const scan = recordsBySeparator("\n", raw => {
      const match = /^(?:dangling|unreachable) commit ([0-9a-f]{40}|[0-9a-f]{64})$/i.exec(raw.trim());
      if (match) hashes.add(match[1]);
    });
    await runGitStream(["fsck", "--no-reflogs", "--unreachable", "--no-progress"], repoRoot,
      scan.onData, { signal, retryOnLock: false });
    scan.finish(); signal?.throwIfAborted();
    if (!hashes.size) return [];
    const top = new TopK<UnreachableCommitRecord>(count,
      (a, b) => b.timestamp - a.timestamp || a.hash.localeCompare(b.hash));
    const metadata = recordsBySeparator("\0", raw => {
      const record = parseCommitRecord(raw);
      if (record) top.add(record);
    });
    await runGitStreamWithInput(["-c", "log.showSignature=false", "log", "--no-walk=unsorted", "--stdin", "--no-notes",
      "--format=%H%x1f%ct%x1f%cI%x1f%P%x1f%s%x00"], repoRoot, [...hashes].join("\n") + "\n",
    metadata.onData, { signal, retryOnLock: false });
    metadata.finish(); signal?.throwIfAborted();
    return top.values();
  } catch (error) {
    signal?.throwIfAborted();
    logError("unreachable commit scan failed", error, { repoRoot });
    return [];
  }
}

/**
 * UTF-8 문자와 구분자가 chunk를 걸쳐도 현재 record만 보관한다.
 * @param separator record 구분자 @param consume 완성된 record의 동기 소비 함수
 * @returns Git stream에 전달할 onData와 성공·close 뒤에만 호출할 finish
 */
function recordsBySeparator(separator: string, consume: (record: string) => void) {
  const decoder = new StringDecoder("utf8"); let pending = "";
  /** 현재 record 조각을 완성해 소비한다. 과대한 단일 record는 부분 결과를 반환하지 않고 실패한다. */
  const append = (text: string) => {
    pending += text;
    let end: number, cursor = 0;
    while ((end = pending.indexOf(separator, cursor)) >= 0) {
      consume(pending.slice(cursor, end)); cursor = end + separator.length;
    }
    pending = pending.slice(cursor);
    if (pending.length > 128 * 1024 * 1024) throw new Error("Unreachable commit record exceeded its memory limit.");
  };
  return {
    onData: (chunk: Buffer) => append(decoder.write(chunk)),
    finish: () => { append(decoder.end()); if (pending) consume(pending); pending = ""; },
  };
}

/** 고정 metadata 형식을 해석하고 subject 안의 구분 문자도 잃지 않고 보존한다. */
function parseCommitRecord(raw: string): UnreachableCommitRecord | undefined {
  const [rawHash, rawTimestamp, rawDate, rawParents, ...subject] = raw.split("\x1f");
  const hash = rawHash?.trim();
  if (!hash) return undefined;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash)) throw new Error("Invalid unreachable commit identity.");
  const timestamp = Number(rawTimestamp);
  return { hash, timestamp: Number.isFinite(timestamp) ? timestamp : 0, dateIso: rawDate?.trim() || undefined,
    parentHashes: rawParents?.split(" ").filter(Boolean) ?? [], message: subject.join("\x1f").trim() || "Unreachable commit object" };
}
