// 최근 표시한 경로는 Native 검사의 우선순위로만 사용한다. 캐시로 clean 여부를 판정하지 않는다.
import path from "node:path";
import type { WorkingTreeEntry } from "./workingTreeStatusFormat";

const ROOT_LIMIT = 32;
const PATH_LIMIT = 8;
const PATH_BYTES_LIMIT = 1024;
const hints = new Map<string, readonly string[]>();

/**
 * 완료된 Native 상태에서 변경 경로 몇 개만 기억한다. 전체 파일 목록이나 상태 결과는 저장하지 않는다.
 * @param root 상태를 읽은 작업트리 루트 @param entries 검증이 끝난 porcelain 변경 항목
 * @returns void. clean·지원하지 않는 경로만 있으면 이전 후보를 제거한다.
 */
export function rememberWorkingTreeChangeHints(root: string, entries: readonly WorkingTreeEntry[]): void {
  const key = path.resolve(root), paths = new Set<string>();
  for (const entry of entries) {
    const file = entry.path;
    if (file && file !== "." && !path.isAbsolute(file) && !file.split("/").includes("..") && !file.includes("\0")
      && Buffer.byteLength(file) <= PATH_BYTES_LIMIT && !paths.has(file)) {
      // parser의 부분 문자열은 거대한 status 원문을 함께 붙잡을 수 있다. 작은 UTF-8 사본만 소유한다.
      paths.add(Buffer.from(file, "utf8").toString("utf8"));
    }
    if (paths.size === PATH_LIMIT) break;
  }
  hints.delete(key);
  if (!paths.size) return;
  while (hints.size >= ROOT_LIMIT) hints.delete(hints.keys().next().value!);
  hints.set(key, [...paths]);
}

/**
 * 최근 변경 경로의 독립 사본을 반환한다. 값이 있어도 Native 재검증 없이 변경/clean으로 취급하면 안 된다.
 * @param root 검사할 작업트리 루트 @returns 최대 8개·경로당 1KiB의 literal path 후보
 */
export function recentWorkingTreeChangeHints(root: string): string[] {
  const key = path.resolve(root), paths = hints.get(key);
  if (!paths) return [];
  hints.delete(key); hints.set(key, paths);
  return [...paths];
}

/**
 * Native 확인에서 변경을 찾지 못한 후보 또는 처분한 작업트리의 경로 집합만 해제한다.
 * @param root 해제할 작업트리 루트 @returns void. 상태 조회나 디스크 쓰기는 시작하지 않는다.
 */
export function forgetWorkingTreeChangeHints(root: string): void { hints.delete(path.resolve(root)); }
