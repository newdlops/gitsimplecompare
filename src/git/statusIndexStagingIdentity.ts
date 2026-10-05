import { createHash } from "node:crypto";

const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const OPTIONAL_EXTENSIONS = new Set(["TREE", "REUC", "UNTR", "FSMN", "EOIE", "IEOT"]);
interface ParsedIndex { identity: string; objectBytes: number; metadataOffsets?: number[] }

/**
 * Git index의 스테이징 의미만 해시해 stat·감시 토큰 갱신으로 전용 캐시를 잃지 않게 한다.
 * @param bytes 실제 index를 stat 전후 검증해 읽은 바이트. 이 함수는 파일이나 Git을 수정하지 않는다.
 * @returns 경로·OID·mode·merge stage·assume-valid·intent-to-add의 식별자.
 * split/sparse/skip-worktree, 알 수 없는 형식·확장·손상은 undefined로 exact identity에 복구한다.
 * 형식 기준: https://git-scm.com/docs/index-format
 */
export function statusIndexStagingIdentity(bytes: Buffer): string | undefined {
  return parseIndex(bytes)?.identity;
}

/**
 * warmed index의 미추적/감시 캐시를 유지하면서 tracked stat은 실제 index와 다시 맞춘다.
 * @param cached Git이 검증한 전용 index 바이트
 * @param source 현재 실제 index의 바이트
 * @returns 같은 stage 의미일 때만 metadata와 checksum을 갱신한 사본. 원본 두 Buffer는 변경하지 않는다.
 * stat과 racy-clean 의미까지 실제 Git과 같게 해 timestamp를 보존한 같은 크기 수정도 놓치지 않는다.
 */
export function restoreStatusIndexMetadata(cached: Buffer, source: Buffer): Buffer | undefined {
  const from = parseIndex(source, true), to = parseIndex(cached, true);
  if (!from || !to || from.identity !== to.identity) return undefined;
  const restored = Buffer.from(cached);
  for (let entry = 0; entry < from.metadataOffsets!.length; entry++) {
    source.copy(restored, to.metadataOffsets![entry], from.metadataOffsets![entry], from.metadataOffsets![entry] + 40);
  }
  const end = restored.length - to.objectBytes;
  createHash(to.objectBytes === 20 ? "sha1" : "sha256").update(restored.subarray(0, end)).digest().copy(restored, end);
  return restored;
}

/**
 * 알려진 전체 index 형식의 stage 의미와 선택적인 stat 위치를 파싱한다.
 * @param bytes checksum을 포함한 index
 * @param collectMetadata stat 재바인딩에 필요한 entry 위치를 수집할지 여부
 * @returns 지원/검증된 의미와 위치. 알 수 없는 구성은 undefined로 복구한다.
 */
function parseIndex(bytes: Buffer, collectMetadata = false): ParsedIndex | undefined {
  if (bytes.length < 32 || bytes.length > MAX_INDEX_BYTES || bytes.subarray(0, 4).toString() !== "DIRC") return undefined;
  const version = bytes.readUInt32BE(4);
  if (![2, 3, 4].includes(version)) return undefined;
  const objectBytes = checksumLength(bytes);
  if (!objectBytes) return undefined;
  const end = bytes.length - objectBytes, count = bytes.readUInt32BE(8);
  const fixed = 42 + objectBytes;
  if (count > Math.floor((end - 12) / (fixed + 1))) return undefined;
  const digest = createHash("sha256").update(`gsc-index-staging-v1:${objectBytes}\0`).update(bytes.subarray(8, 12));
  let cursor = 12;
  let previous: Buffer = Buffer.alloc(0);
  const metadataOffsets = collectMetadata ? [] as number[] : undefined;
  try {
    for (let entry = 0; entry < count; entry++) {
      const start = cursor;
      metadataOffsets?.push(start);
      if (cursor + fixed >= end) return undefined;
      const mode = bytes.readUInt32BE(cursor + 24), flags = bytes.readUInt16BE(cursor + 40 + objectBytes);
      if (![0o100644, 0o100755, 0o120000, 0o160000].includes(mode)) return undefined;
      cursor += fixed;
      let extended = 0;
      if (flags & 0x4000) {
        if (version === 2 || cursor + 2 > end) return undefined;
        extended = bytes.readUInt16BE(cursor); cursor += 2;
        // skip-worktree의 자동 변경과 sparse 상태는 exact cache에 남겨 의미를 확대 해석하지 않는다.
        if (extended & ~0x2000) return undefined;
      }
      let removed = 0;
      if (version === 4) {
        const value = prefixRemoval(bytes, cursor, end);
        if (!value || value.removed > previous.length) return undefined;
        removed = value.removed; cursor = value.next;
      }
      const nul = bytes.indexOf(0, cursor);
      if (nul < cursor || nul >= end) return undefined;
      const name = version === 4 ? Buffer.concat([previous.subarray(0, previous.length - removed), bytes.subarray(cursor, nul)]) : bytes.subarray(cursor, nul);
      if (!name.length || (flags & 0x0fff) !== Math.min(name.length, 0x0fff)) return undefined;
      const meaning = Buffer.alloc(8);
      meaning.writeUInt16BE(flags & 0xb000); meaning.writeUInt16BE(extended & 0x2000, 2); meaning.writeUInt32BE(name.length, 4);
      digest.update(bytes.subarray(start + 24, start + 28));
      digest.update(bytes.subarray(start + 40, start + 40 + objectBytes));
      digest.update(meaning).update(name);
      previous = name;
      cursor = nul + 1;
      if (version !== 4) {
        const padded = start + Math.ceil((cursor - start) / 8) * 8;
        if (padded > end || bytes.subarray(cursor, padded).some(value => value !== 0)) return undefined;
        cursor = padded;
      }
    }
    while (cursor < end) {
      if (cursor + 8 > end) return undefined;
      const signature = bytes.subarray(cursor, cursor + 4).toString(), size = bytes.readUInt32BE(cursor + 4);
      if (!OPTIONAL_EXTENSIONS.has(signature) || cursor + 8 + size > end) return undefined;
      cursor += 8 + size;
    }
    return cursor === end ? { identity: digest.digest("hex"), objectBytes, metadataOffsets } : undefined;
  } catch { return undefined; }
}

/**
 * index 자체 checksum을 검증해 SHA-1/SHA-256 OID 길이를 추측 없이 결정한다.
 * @param bytes 헤더·entry·확장·checksum을 포함한 전체 index
 * @returns 검증된 checksum/OID 바이트 길이. 어느 형식에도 맞지 않으면 undefined
 */
function checksumLength(bytes: Buffer): number | undefined {
  for (const [algorithm, size] of [["sha1", 20], ["sha256", 32]] as const) {
    if (bytes.length >= 12 + size && createHash(algorithm).update(bytes.subarray(0, -size)).digest().equals(bytes.subarray(-size))) return size;
  }
  return undefined;
}

/**
 * version 4의 OFS_DELTA 정수를 읽고 이전 pathname에서 제거할 바이트 수를 반환한다.
 * @param bytes index 바이트
 * @param offset 압축 경로 앞의 정수 시작 위치
 * @param end checksum 앞의 파싱 상한
 * @returns 제거 길이와 다음 위치. 오버플로·잘림은 undefined로 복구한다.
 */
function prefixRemoval(bytes: Buffer, offset: number, end: number): { removed: number; next: number } | undefined {
  let next = offset, byte = bytes[next++], removed = byte & 0x7f;
  for (let count = 0; byte & 0x80; count++) {
    if (count >= 8 || next >= end) return undefined;
    byte = bytes[next++]; removed = (removed + 1) * 128 + (byte & 0x7f);
    if (!Number.isSafeInteger(removed)) return undefined;
  }
  return { removed, next };
}
