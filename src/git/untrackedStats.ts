// 미추적 파일 통계 계산 유틸.
// - git diff --numstat 이 다루지 않는 새 파일의 추가 라인 수를 UI 서비스들이 공유한다.
import * as path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { LINE_STATS_MAX_FILE_BYTES } from "./largeChangeSet";
import { LruCache } from "../utils/lruCache";
import { SharedGitRead } from "./sharedGitRead";

/** 정확한 줄 수를 세는 미추적 파일 크기 상한. 추적 파일 라인 통계의 대용량 기준과 같다. */
const MAX_EXACT_UNTRACKED_STAT_BYTES = LINE_STATS_MAX_FILE_BYTES;

interface CachedUntrackedStat {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  additions: number | undefined;
}

const cache = new LruCache<string, CachedUntrackedStat>(4096, 1024 * 1024,
  (file) => Buffer.byteLength(file) + 128);
const pending = new Map<string, SharedGitRead<number | undefined>>();
let generation = 0;

/** 확장 종료·검사에서 미추적 파일 경로와 완료 통계를 해제한다. */
export function clearUntrackedStatsCache(): void {
  generation++; cache.clear();
  for (const read of pending.values()) void read.dispose();
  pending.clear();
}

/** 장기 사용 검사에 필요한 캐시 항목 수와 추정 보관 비용을 반환한다. */
export function untrackedStatsCacheStats() { return cache.stats(); }

/**
 * 미추적 파일의 추가 라인 수를 계산한다.
 * - 새 파일은 비교 기준에 존재하지 않으므로 삭제 라인은 호출부에서 0으로 둔다.
 * - 큰 미추적 파일은 UI refresh 를 막지 않도록 정확한 줄 수 계산을 생략한다.
 * - 바이너리 파일이나 읽을 수 없는 파일은 비용과 오류 전파를 피하기 위해 undefined 로 처리한다.
 * @param repoRoot 저장소 루트 절대 경로
 * @param relPath  저장소 루트 기준 상대 경로
 */
export async function countUntrackedLines(
  repoRoot: string,
  relPath: string,
  signal?: AbortSignal
): Promise<number | undefined> {
  signal?.throwIfAborted();
  const fullPath = path.join(repoRoot, relPath);
  try {
    const fileStat = await stat(fullPath);
    signal?.throwIfAborted();
    const cached = cache.get(fullPath);
    if (
      cached &&
      cached.size === fileStat.size &&
      cached.mtimeMs === fileStat.mtimeMs && cached.ctimeMs === fileStat.ctimeMs && cached.ino === fileStat.ino
    ) {
      return cached.additions;
    }
    if (fileStat.size > MAX_EXACT_UNTRACKED_STAT_BYTES) {
      cache.set(fullPath, {
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        ctimeMs: fileStat.ctimeMs, ino: fileStat.ino,
        additions: undefined,
      });
      return undefined;
    }
    const identity = JSON.stringify([fullPath, fileStat.size, fileStat.mtimeMs, fileStat.ctimeMs, fileStat.ino]);
    let shared = pending.get(identity);
    if (!shared) {
      const startedGeneration = generation;
      shared = new SharedGitRead(async ownedSignal => {
        const raw = await readFile(fullPath, { signal: ownedSignal });
        ownedSignal.throwIfAborted();
        let lines: number | undefined = raw.length === 0 ? 0 : raw[raw.length - 1] === 10 ? 0 : 1;
        for (const byte of raw) {
          if (byte === 0) { lines = undefined; break; }
          if (byte === 10) lines++;
        }
        const after = await stat(fullPath);
        ownedSignal.throwIfAborted();
        // 읽는 도중 파일이 교체되거나 변경됐으면 옛 identity로 완료 값을 저장하지 않는다.
        if (generation === startedGeneration && after.size === fileStat.size && after.mtimeMs === fileStat.mtimeMs
          && after.ctimeMs === fileStat.ctimeMs && after.ino === fileStat.ino) {
          cache.set(fullPath, { size: fileStat.size, mtimeMs: fileStat.mtimeMs,
            ctimeMs: fileStat.ctimeMs, ino: fileStat.ino, additions: lines });
        }
        return lines;
      }, value => value);
      pending.set(identity, shared);
    }
    try { return await shared.read({ signal, maxCacheAgeMs: 0 }); }
    finally {
      if (!shared.hasConsumers() && pending.get(identity) === shared) {
        pending.delete(identity); void shared.dispose();
      }
    }
  } catch {
    signal?.throwIfAborted();
    cache.delete(fullPath);
    return undefined;
  }
}
