// 미추적 파일 통계 계산 유틸.
// - git diff --numstat 이 다루지 않는 새 파일의 추가 라인 수를 UI 서비스들이 공유한다.
import * as path from "node:path";
import { readFile, stat } from "node:fs/promises";

const MAX_EXACT_UNTRACKED_STAT_BYTES = 5 * 1024 * 1024;

interface CachedUntrackedStat {
  size: number;
  mtimeMs: number;
  additions: number | undefined;
}

const cache = new Map<string, CachedUntrackedStat>();

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
  relPath: string
): Promise<number | undefined> {
  const fullPath = path.join(repoRoot, relPath);
  try {
    const fileStat = await stat(fullPath);
    const cached = cache.get(fullPath);
    if (
      cached &&
      cached.size === fileStat.size &&
      cached.mtimeMs === fileStat.mtimeMs
    ) {
      return cached.additions;
    }
    if (fileStat.size > MAX_EXACT_UNTRACKED_STAT_BYTES) {
      cache.set(fullPath, {
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        additions: undefined,
      });
      return undefined;
    }
    const raw = await readFile(fullPath);
    if (raw.length === 0) {
      cache.set(fullPath, {
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        additions: 0,
      });
      return 0;
    }
    let lines = raw[raw.length - 1] === 10 ? 0 : 1;
    for (const byte of raw) {
      if (byte === 0) {
        cache.set(fullPath, {
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          additions: undefined,
        });
        return undefined;
      }
      if (byte === 10) {
        lines++;
      }
    }
    cache.set(fullPath, {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      additions: lines,
    });
    return lines;
  } catch {
    return undefined;
  }
}
