// git object database 에 남아 있지만 ref/reflog 에서 도달하지 못하는 commit 복구 후보를 찾는 서비스.
// - reflogService 가 HEAD 이동 기록을 조립할 때, reflog 바깥의 dangling/unreachable commit 도 함께 보여줄 수 있게 한다.
import { runGit } from "./gitExec";

const FS = "\x1f";
const RS = "\0";
const SHOW_CHUNK_SIZE = 200;

/** fsck 로 찾은 unreachable commit object 의 UI 표시용 메타데이터 */
export interface UnreachableCommitRecord {
  hash: string;
  timestamp: number;
  dateIso?: string;
  message: string;
}

/**
 * reflog 에 직접 노출되지 않을 수 있는 unreachable commit object 를 읽는다.
 * - `--no-reflogs` 를 써서 branch/tag 뿐 아니라 reflog root 에서도 도달 불가한 commit 후보를 찾는다.
 * - fsck 는 복구 보조 정보라 실패해도 HEAD reflog 표시를 막지 않도록 빈 배열로 낮춘다.
 * @param repoRoot 저장소 루트
 * @param limit    UI 에 보낼 최근 commit object 최대 개수
 */
export async function readUnreachableCommitRecords(
  repoRoot: string,
  limit: number
): Promise<UnreachableCommitRecord[]> {
  try {
    const out = await runGit(
      ["fsck", "--no-reflogs", "--unreachable", "--no-progress"],
      repoRoot,
      { retryOnLock: false }
    );
    const hashes = parseUnreachableCommitHashes(out);
    if (hashes.length === 0) {
      return [];
    }
    const records = await readCommitMetadata(repoRoot, hashes);
    return records
      .sort((a, b) => b.timestamp - a.timestamp || a.hash.localeCompare(b.hash))
      .slice(0, Math.max(0, Math.floor(limit)));
  } catch {
    return [];
  }
}

/**
 * git fsck 출력에서 commit object 해시만 뽑아 중복을 제거한다.
 * @param out `git fsck --unreachable` 출력
 */
function parseUnreachableCommitHashes(out: string): string[] {
  const seen = new Set<string>();
  const hashes: string[] = [];
  for (const line of out.split("\n")) {
    const match = /^(?:dangling|unreachable) commit ([0-9a-f]{40})$/i.exec(line.trim());
    const hash = match?.[1];
    if (!hash || seen.has(hash)) {
      continue;
    }
    seen.add(hash);
    hashes.push(hash);
  }
  return hashes;
}

/**
 * commit object 목록에 UI 표시용 날짜와 제목을 붙인다.
 * @param repoRoot 저장소 루트
 * @param hashes   fsck 에서 찾은 commit 해시 목록
 */
async function readCommitMetadata(
  repoRoot: string,
  hashes: string[]
): Promise<UnreachableCommitRecord[]> {
  const records: UnreachableCommitRecord[] = [];
  for (let index = 0; index < hashes.length; index += SHOW_CHUNK_SIZE) {
    const chunk = hashes.slice(index, index + SHOW_CHUNK_SIZE);
    const out = await runGit(
      ["show", "-s", `--format=%H%x1f%ct%x1f%cI%x1f%s%x00`, ...chunk],
      repoRoot
    );
    records.push(
      ...out
        .split(RS)
        .map(parseUnreachableCommitRecord)
        .filter((record): record is UnreachableCommitRecord => Boolean(record))
    );
  }
  return records;
}

/**
 * `git show -s` 의 NUL 구분 record 를 unreachable commit 메타데이터로 변환한다.
 * @param raw `hash FS timestamp FS dateIso FS subject` 형태의 원문
 */
function parseUnreachableCommitRecord(raw: string): UnreachableCommitRecord | undefined {
  const [rawHash, rawTimestamp, rawDateIso, rawMessage] = raw.split(FS);
  const hash = rawHash?.trim();
  if (!hash) {
    return undefined;
  }
  const timestamp = Number(rawTimestamp);
  return {
    hash,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    dateIso: rawDateIso?.trim() || undefined,
    message: rawMessage?.trim() || "Unreachable commit object",
  };
}
