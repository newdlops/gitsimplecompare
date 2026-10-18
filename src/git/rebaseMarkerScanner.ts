// rebase 진단에 필요한 미해결 파일만 제한된 IO와 메모리로 검사한다.
// - 작업 파일의 링크를 따라가지 않고 파일 크기가 도중에 늘어도 검사 상한을 지킨다.
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { containsConflictMarkers } from "./conflictMarkers";
import { resolveSafeConflictWorkingPath } from "./conflictPathSafety";
import { mapWithConcurrency } from "../utils/mapWithConcurrency";
import { logError, logInfo } from "../ui/outputLog";

export const MAX_REBASE_MARKER_SCAN_BYTES = 2 * 1024 * 1024;
const MARKER_SCAN_CONCURRENCY = 4;
type ScanResult = "marker" | "clean" | "large" | "nonfile" | "unsafe" | "unreadable";

/**
 * 전체 unmerged 경로를 검사하되 동시에 네 파일까지만 읽고 입력 순서대로 marker 경로를 반환한다.
 * @param repoRoot 현재 저장소 루트 @param files 실제 index에서 읽은 미해결 상대 경로
 * @returns 크기 상한 안의 일반 파일에 marker가 남은 경로. 한 파일의 오류는 다른 검사와 격리한다.
 */
export async function findRebaseMarkerFiles(repoRoot: string, files: readonly string[]): Promise<string[]> {
  const paths = [...new Set(files)];
  const started = Date.now();
  const results = await mapWithConcurrency(paths, MARKER_SCAN_CONCURRENCY, rel => inspectFile(repoRoot, rel));
  const markers = paths.filter((_, index) => results[index] === "marker");
  const counts: Record<ScanResult, number> = { marker: 0, clean: 0, large: 0, nonfile: 0, unsafe: 0, unreadable: 0 };
  for (const result of results) counts[result]++;
  logInfo("rebase diagnostic marker scan finished", {
    repoRoot, files: paths.length, markers: markers.length,
    skipped: paths.length - counts.marker - counts.clean, oversized: counts.large,
    nonfiles: counts.nonfile, unsafe: counts.unsafe, unreadable: counts.unreadable, elapsedMs: Date.now() - started,
  });
  return markers;
}

/**
 * 경로·leaf 종류를 확인한 FD 하나로 크기 상한까지 읽고 원래 UTF-8/marker 판정을 적용한다.
 * @param repoRoot 저장소 루트 @param rel 검사할 상대 경로
 * @returns marker/정상 text/검사 제외 사유. 본문 문자열과 파일 핸들은 반환하지 않는다.
 */
async function inspectFile(repoRoot: string, rel: string): Promise<ScanResult> {
  let absolute: string;
  try { absolute = await resolveSafeConflictWorkingPath(repoRoot, rel); }
  catch { return "unsafe"; }
  let handle: fs.FileHandle | undefined;
  try {
    const leaf = await fs.lstat(absolute);
    if (!leaf.isFile()) return "nonfile";
    if (leaf.size > MAX_REBASE_MARKER_SCAN_BYTES) return "large";
    handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== leaf.dev || opened.ino !== leaf.ino) return "nonfile";
    if (opened.size > MAX_REBASE_MARKER_SCAN_BYTES) return "large";
    const content = await readBoundedContent(handle, opened.size);
    if (content === undefined) return "large";
    return containsConflictMarkers(content) ? "marker" : "clean";
  } catch { return "unreadable"; }
  finally {
    await handle?.close().catch(error => logError("rebase diagnostic file close failed", error, { repoRoot, rel }));
  }
}

/**
 * 작은 파일에는 작은 buffer를 쓰고 도중에 커지면 상한까지 확장해 전체 바이트를 확인한다.
 * @param handle 일반 파일로 확인한 열린 FD @param initialSize 같은 FD에서 방금 확인한 크기
 * @returns 전체 UTF-8 본문. 상한보다 큰 파일은 undefined이며 최대 상한+1바이트만 읽는다.
 */
async function readBoundedContent(handle: fs.FileHandle, initialSize: number): Promise<string | undefined> {
  const ceiling = MAX_REBASE_MARKER_SCAN_BYTES + 1;
  let buffer = Buffer.allocUnsafe(Math.min(ceiling, Math.max(4096, initialSize + 1)));
  let length = 0;
  while (length < ceiling) {
    if (length === buffer.length) {
      const expanded = Buffer.allocUnsafe(Math.min(ceiling, buffer.length * 2));
      buffer.copy(expanded, 0, 0, length);
      buffer = expanded;
    }
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return length > MAX_REBASE_MARKER_SCAN_BYTES ? undefined : buffer.subarray(0, length).toString("utf8");
}
