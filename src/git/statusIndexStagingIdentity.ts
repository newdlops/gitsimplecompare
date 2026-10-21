import { createHash } from "node:crypto";
import { BufferedHash } from "../utils/bufferedHash";

const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const OPTIONAL_EXTENSIONS = new Set(["TREE", "REUC", "UNTR", "FSMN", "EOIE", "IEOT"]);
interface IndexEntry { name: Buffer; object: Buffer; mode: number; flagged: boolean }
interface ParsedIndex { identity: string; objectBytes: number; metadataOffsets?: Uint32Array; directoryCount?: number; hasUntrackedCache?: boolean; entries?: () => Iterable<IndexEntry> }

/** Native update-index로 반영할 작은 stage 차이다. 파일명은 UTF-8로 변환하지 않는다. */
export interface StatusIndexTransition { input: Buffer; changedPaths: number }

/**
 * 한 상태 조회의 source 해석만 보관한다. 전역/다음 조회에는 캐시하지 않으며 원본 파일은 읽거나 쓰지 않는다.
 * 같은 Buffer도 await 중 바뀔 수 있어 재사용 때 전체 checksum과 최초 checksum을 모두 대조한다.
 */
export class StatusIndexSource {
  private readonly checksum: Buffer;

  /** 검증된 사본과 그 해석을 묶는다. 생성은 inspect에서만 허용해 형식 검증 누락을 막는다. */
  private constructor(private readonly bytes: Buffer, private readonly parsed: ParsedIndex) {
    this.checksum = Buffer.from(bytes.subarray(-parsed.objectBytes));
  }

  /** 큰 Native source를 한 번 해석한다. merge 중복 이름·미지원 index는 기존 exact 경로에 맡긴다. */
  static inspect(bytes: Buffer): StatusIndexSource | undefined {
    const parsed = parseIndex(bytes, true, true, true);
    return parsed ? new StatusIndexSource(bytes, parsed) : undefined;
  }

  /** 최초 검증 시점의 stage 의미와 디렉터리 형태다. 비동기 재사용은 아래 검증 메서드만 사용한다. */
  get info(): { identity: string; directoryCount: number; hasUntrackedCache: boolean } {
    return { identity: this.parsed.identity, directoryCount: this.parsed.directoryCount!, hasUntrackedCache: this.parsed.hasUntrackedCache! };
  }

  /** 호출자가 같은 source 사본을 사용하는지 확인하고 이후 byte 수정도 checksum으로 검출한다. */
  matches(bytes: Buffer): boolean {
    return bytes === this.bytes && checksumLength(bytes) === this.parsed.objectBytes &&
      this.checksum.equals(bytes.subarray(-this.parsed.objectBytes));
  }

  /** 검증한 source를 재해석하지 않고 이전 private index와 작은 Native stage 변경을 계산한다. */
  planTransition(cached: Buffer, previousIdentity: string): StatusIndexTransition | undefined {
    if (!this.matches(this.bytes)) return undefined;
    return planParsedTransition(parseIndex(cached, false, false, true), this.parsed, previousIdentity);
  }

  /** 새 private index는 매번 해석·검증하고, 같은 source의 stat 위치만 재사용해 checksum을 다시 만든다. */
  restoreMetadata(cached: Buffer): Buffer | undefined {
    if (!this.matches(this.bytes)) return undefined;
    return restoreParsedMetadata(cached, parseIndex(cached, true), this.bytes, this.parsed);
  }
}

/**
 * 검증된 이전 전용 index와 현재 실제 index의 작은 차이만 Native index-info 입력으로 만든다.
 * @param cached Git의 UNTR 캐시가 있는 이전 사본 @param source 현재 source 사본
 * @param previousIdentity 이전 사본이 따라야 하는 검증된 stage 식별자
 * @returns 삭제를 먼저 수행하는 NUL 입력. 형식·flag·이전 의미·크기 조건이 맞지 않으면 undefined
 * Native Git이 추적 경로 변경에 따른 UNTR 무효화를 담당한다. 이 함수는 index를 수정하지 않는다.
 */
export function planStatusIndexTransition(cached: Buffer, source: Buffer, previousIdentity: string): StatusIndexTransition | undefined {
  const before = parseIndex(cached, false, false, true), after = parseIndex(source, false, false, true);
  return planParsedTransition(before, after, previousIdentity);
}

/** 검증된 두 index의 정렬 entry를 병합 비교해 Native 입력을 만든다. Buffer나 해석 결과는 수정하지 않는다. */
function planParsedTransition(before: ParsedIndex | undefined, after: ParsedIndex | undefined, previousIdentity: string): StatusIndexTransition | undefined {
  if (!before || !after || !before.hasUntrackedCache || before.identity !== previousIdentity || before.objectBytes !== after.objectBytes) return undefined;
  const old = before.entries!()[Symbol.iterator](), next = after.entries!()[Symbol.iterator](), deletes: Buffer[] = [], updates: Buffer[] = [];
  let previous = old.next().value, current = next.next().value, changedPaths = 0, bytes = 0;
  /** raw 경로를 보존하고 한 번의 Native 쓰기에 넘기는 변경량과 입력 크기를 함께 제한한다. */
  const add = (entry: IndexEntry, remove: boolean): boolean => {
    const header = Buffer.from(remove ? `0 ${"0".repeat(before.objectBytes * 2)}\t` : `${entry.mode.toString(8)} ${entry.object.toString("hex")} 0\t`);
    bytes += header.length + entry.name.length + 1;
    if (++changedPaths > 128 || bytes > 256 * 1024) return false;
    (remove ? deletes : updates).push(Buffer.concat([header, entry.name, Buffer.from([0])]));
    return true;
  };
  while (previous || current) {
    if ((previous && (previous.flagged || previous.mode === 0o160000)) || (current && (current.flagged || current.mode === 0o160000))) return undefined;
    const order = !previous ? 1 : !current ? -1 : Buffer.compare(previous.name, current.name);
    if (order < 0) { if (!add(previous, true)) return undefined; previous = old.next().value; }
    else if (order > 0) { if (!add(current, false)) return undefined; current = next.next().value; }
    else {
      if ((previous.mode !== current.mode || !previous.object.equals(current.object)) && !add(current, false)) return undefined;
      previous = old.next().value; current = next.next().value;
    }
  }
  return changedPaths ? { input: Buffer.concat([...deletes, ...updates]), changedPaths } : undefined;
}

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
 * 큰 index의 첫 디렉터리 탐색에만 필요한 형태 정보를 stage 검증과 한 번에 읽는다.
 * @param bytes 실제 index의 검증 전 사본
 * @returns 검증된 stage 의미·추적 파일의 parent 수·기존 UNTR 유무. 미지원 형식은 undefined
 */
export function statusIndexStagingInfo(bytes: Buffer): { identity: string; directoryCount: number; hasUntrackedCache: boolean } | undefined {
  const parsed = parseIndex(bytes, false, true);
  return parsed && { identity: parsed.identity, directoryCount: parsed.directoryCount!, hasUntrackedCache: parsed.hasUntrackedCache! };
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
  return restoreParsedMetadata(cached, to, source, from);
}

/** 형식·의미가 같은 두 검증 결과의 stat 위치를 결합한다. source와 cached Buffer는 그대로 보존한다. */
function restoreParsedMetadata(cached: Buffer, to: ParsedIndex | undefined, source: Buffer, from: ParsedIndex | undefined): Buffer | undefined {
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
 * @param collectDirectories 큰 저장소의 첫 탐색 판정에 필요한 parent 디렉터리 수를 수집할지 여부
 * @param collectEntries 작은 Native stage 이행을 위해 정렬된 raw entry를 수집할지 여부
 * @returns 지원/검증된 의미와 위치. 알 수 없는 구성은 undefined로 복구한다.
 */
function parseIndex(bytes: Buffer, collectMetadata = false, collectDirectories = false, collectEntries = false): ParsedIndex | undefined {
  if (bytes.length < 32 || bytes.length > MAX_INDEX_BYTES || bytes.subarray(0, 4).toString() !== "DIRC") return undefined;
  const version = bytes.readUInt32BE(4);
  if (![2, 3, 4].includes(version)) return undefined;
  const objectBytes = checksumLength(bytes);
  if (!objectBytes) return undefined;
  const end = bytes.length - objectBytes, count = bytes.readUInt32BE(8);
  const fixed = 42 + objectBytes;
  if (count > Math.floor((end - 12) / (fixed + 1))) return undefined;
  const digest = new BufferedHash(createHash("sha256").update(`gsc-index-staging-v1:${objectBytes}\0`).update(bytes.subarray(8, 12)));
  let cursor = 12;
  let previous: Buffer = Buffer.alloc(0);
  const metadataOffsets = collectMetadata ? new Uint32Array(count) : undefined;
  const directories = collectDirectories ? new Set<string>() : undefined;
  // Hash.update는 동기로 소비한다. 매 entry마다 같은 8-byte 의미 buffer를 덮어써 임시 객체를 줄인다.
  const meaning = Buffer.alloc(8);
  let hasUntrackedCache = false;
  try {
    for (let entry = 0; entry < count; entry++) {
      const start = cursor;
      if (metadataOffsets) metadataOffsets[entry] = start;
      if (cursor + fixed >= end) return undefined;
      const mode = bytes.readUInt32BE(cursor + 24), flags = bytes.readUInt16BE(cursor + 40 + objectBytes);
      if (mode !== 0o100644 && mode !== 0o100755 && mode !== 0o120000 && mode !== 0o160000) return undefined;
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
      // v2/v3의 연속 경로는 원본 범위로 해시한다. 이름 view는 복원·정렬·디렉터리 조회에만 만든다.
      let name: Buffer | undefined = version === 4 ? Buffer.concat([previous.subarray(0, previous.length - removed), bytes.subarray(cursor, nul)]) : undefined;
      const nameLength = name ? name.length : nul - cursor;
      if (!nameLength || (flags & 0x0fff) !== Math.min(nameLength, 0x0fff)) return undefined;
      if (collectEntries || directories) name ??= bytes.subarray(cursor, nul);
      if (collectEntries && entry && Buffer.compare(previous, name!) >= 0) return undefined;
      if (directories) { const slash = name!.lastIndexOf(47); if (slash >= 0) directories.add(name!.subarray(0, slash).toString("utf8")); }
      meaning.writeUInt16BE(flags & 0xb000); meaning.writeUInt16BE(extended & 0x2000, 2); meaning.writeUInt32BE(nameLength, 4);
      digest.append(bytes, start + 24, start + 28);
      digest.append(bytes, start + 40, start + 40 + objectBytes);
      digest.append(meaning);
      if (version === 4) digest.append(name!); else digest.append(bytes, cursor, nul);
      if (version === 4 || collectEntries) previous = name!;
      cursor = nul + 1;
      if (version !== 4) {
        const padded = start + Math.ceil((cursor - start) / 8) * 8;
        if (padded > end) return undefined;
        // 최대 7바이트의 padding은 별도 view/콜백 없이도 모든 0바이트 검증을 유지한다.
        for (let padding = cursor; padding < padded; padding++) if (bytes[padding] !== 0) return undefined;
        cursor = padded;
      }
    }
    while (cursor < end) {
      if (cursor + 8 > end) return undefined;
      const signature = bytes.subarray(cursor, cursor + 4).toString(), size = bytes.readUInt32BE(cursor + 4);
      if (!OPTIONAL_EXTENSIONS.has(signature) || cursor + 8 + size > end) return undefined;
      if (signature === "UNTR") hasUntrackedCache = true;
      cursor += 8 + size;
    }
    return cursor === end ? { identity: digest.digestHex(), objectBytes, metadataOffsets, directoryCount: directories?.size, hasUntrackedCache,
      // 같은 source의 계획을 다시 비교해도 소진된 iterator를 재사용하지 않는다.
      ...(collectEntries ? { entries: () => verifiedEntries(bytes, version, objectBytes, count) } : {}) } : undefined;
  } catch { return undefined; }
}

/**
 * 전체 checksum·형식·정렬 검증을 끝낸 Buffer에서 비교 중인 두 entry만 순서대로 만든다.
 * @param bytes parseIndex가 같은 동기 호출에서 검증한 사본 @param version 지원하는 index 버전
 * @param objectBytes 검증한 OID 길이 @param count 검증한 entry 수
 * @returns raw 이름·OID view의 iterator. 전체 항목 객체 배열을 보유하지 않는다.
 */
function* verifiedEntries(bytes: Buffer, version: number, objectBytes: number, count: number): IterableIterator<IndexEntry> {
  let cursor = 12;
  let previous: Buffer = Buffer.alloc(0);
  for (let entry = 0; entry < count; entry++) {
    const start = cursor, flags = bytes.readUInt16BE(start + 40 + objectBytes);
    cursor += 42 + objectBytes;
    const extended = flags & 0x4000 ? bytes.readUInt16BE(cursor) : 0;
    if (flags & 0x4000) cursor += 2;
    let removed = 0;
    if (version === 4) { const prefix = prefixRemoval(bytes, cursor, bytes.length - objectBytes)!; removed = prefix.removed; cursor = prefix.next; }
    const nul = bytes.indexOf(0, cursor);
    const name = version === 4 ? Buffer.concat([previous.subarray(0, previous.length - removed), bytes.subarray(cursor, nul)]) : bytes.subarray(cursor, nul);
    yield { name, object: bytes.subarray(start + 40, start + 40 + objectBytes), mode: bytes.readUInt32BE(start + 24), flagged: !!((flags & 0xb000) || (extended & 0x2000)) };
    previous = name; cursor = nul + 1;
    if (version !== 4) cursor = start + Math.ceil((cursor - start) / 8) * 8;
  }
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
