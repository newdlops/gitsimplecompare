// git diff 출력 파싱을 모아둔 순수 유틸 모듈.
// - GitService(브랜치 비교)와 GitLogService(커밋 상세)가 동일한 파서를 공유한다(재사용).
import { FileChange, FileChangeStatus } from "./gitTypes";

/**
 * `git diff --name-status -z` 출력(NUL 구분)을 FileChange 배열로 파싱한다.
 * - 일반 항목: <status>\0<path>\0
 * - 이름변경/복사: <Rxxx|Cxxx>\0<oldPath>\0<newPath>\0
 * @param raw git diff 의 원문 출력
 */
export function parseNameStatusZ(raw: string): FileChange[] {
  const tokens = raw.split("\0").filter((t) => t.length > 0);
  const changes: FileChange[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++][0] as FileChangeStatus;
    if (code === "R" || code === "C") {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      changes.push({ status: code, path: newPath, oldPath });
    } else {
      changes.push({ status: code, path: tokens[i++] });
    }
  }
  return changes;
}

/**
 * `git diff --numstat` 출력을 경로별 {추가, 삭제} 라인 수 맵으로 파싱한다.
 * - 바이너리 파일은 "-"로 표시되며 0 으로 처리한다.
 * - 이름변경 표기("old => new", "{a => b}/c")는 새 경로 기준으로 정규화한다(근사).
 * @param raw git diff --numstat 원문 출력
 */
export function parseNumstat(
  raw: string
): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split("\t");
    if (parts.length < 3) {
      continue;
    }
    const additions = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
    const deletions = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
    const path = normalizeRenamePath(parts.slice(2).join("\t"));
    map.set(path, { additions, deletions });
  }
  return map;
}

/**
 * numstat 의 이름변경 표기를 새 경로로 정규화한다.
 * - "src/{a => b}/c.ts" → "src/b/c.ts", "old.ts => new.ts" → "new.ts"
 * @param raw 경로 토큰(이름변경 표기 가능)
 */
function normalizeRenamePath(raw: string): string {
  const expanded = raw.replace(/\{[^}]*=>\s*([^}]*)\}/g, "$1").replace(/\/{2,}/g, "/");
  const arrow = expanded.indexOf(" => ");
  return arrow >= 0 ? expanded.slice(arrow + 4).trim() : expanded.trim();
}
