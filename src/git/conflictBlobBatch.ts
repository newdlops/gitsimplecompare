// cat-file --batch의 프레임 경계를 검증하고 blob 전체 대신 표시용 prefix만 보존한다.
import { runGitStreamWithInput } from "./gitExec";
import type { ConflictBlobPreview } from "./conflictBlobReader";

/** blob 하나의 전체 UTF-8/NUL 유효성과 한정된 표시 prefix를 따로 관리한다. */
class BlobPreview {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly prefix: Buffer[] = [];
  private kept = 0;
  private binary = false;

  constructor(private readonly size: number, private readonly limit: number) {}

  /** 미리보기 한도를 넘는 부분도 끝까지 검사해 뒤쪽 binary 바이트를 놓치지 않는다. */
  append(chunk: Buffer): void {
    if (!this.binary) {
      try { if (chunk.includes(0)) this.binary = true; else this.decoder.decode(chunk, { stream: true }); }
      catch { this.binary = true; }
    }
    if (this.binary) { this.prefix.length = 0; return; }
    const take = Math.min(chunk.length, this.limit - this.kept);
    if (take > 0) { this.prefix.push(Buffer.from(chunk.subarray(0, take))); this.kept += take; }
  }

  /** 마지막 UTF-8 조각까지 검증한 뒤 독립적인 표시 문자열 또는 binary 분류를 반환한다. */
  finish(): ConflictBlobPreview {
    if (!this.binary) { try { this.decoder.decode(); } catch { this.binary = true; } }
    return this.binary ? { kind: "binary", content: "" }
      : { kind: "text", content: Buffer.concat(this.prefix).toString("utf8"), truncated: this.size > this.limit || undefined };
  }
}

/**
 * 실제 index OID들을 한 Git 프로세스로 읽고 요청 순서·종류·정확한 크기를 검증한다.
 * @param oids 검증된 SHA-1/SHA-256 blob OID 목록
 * @param limit 객체마다 보존할 표시용 바이트 수
 * @returns 전체 스트림 검증이 끝난 OID별 미리보기. missing/non-blob/잘린 프레임은 실패한다.
 */
export async function readConflictBlobBatch(
  root: string, oids: readonly string[], limit: number, signal: AbortSignal
): Promise<ReadonlyMap<string, ConflictBlobPreview>> {
  const values = new Map<string, ConflictBlobPreview>();
  let index = 0, header = "", remaining = 0, separator = false;
  let preview: BlobPreview | undefined;
  await runGitStreamWithInput(["cat-file", "--batch"], root, oids.join("\n") + "\n", chunk => {
    let offset = 0;
    while (offset < chunk.length) {
      if (separator) {
        if (chunk[offset++] !== 10) throw new Error("Invalid conflict blob separator.");
        values.set(oids[index++], preview!.finish());
        preview = undefined; separator = false;
      } else if (preview) {
        const take = Math.min(remaining, chunk.length - offset);
        preview.append(chunk.subarray(offset, offset + take)); offset += take; remaining -= take;
        if (remaining === 0) separator = true;
      } else {
        const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
        if (header.length + end - offset > 256) throw new Error("Invalid conflict blob header.");
        header += chunk.toString("ascii", offset, end); offset = end;
        if (newline < 0) break;
        offset++;
        const fields = /^([0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/.exec(header);
        const size = fields ? Number(fields[2]) : NaN;
        if (!fields || fields[1] !== oids[index] || !Number.isSafeInteger(size)) throw new Error("Cannot read the requested conflict blob.");
        header = ""; remaining = size; preview = new BlobPreview(size, limit); separator = size === 0;
      }
    }
  }, { signal, env: { GIT_NO_REPLACE_OBJECTS: "1" } });
  if (index !== oids.length || header || preview || separator) throw new Error("Incomplete conflict blob stream.");
  return values;
}
