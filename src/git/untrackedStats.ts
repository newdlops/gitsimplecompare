// 미추적 파일 통계 계산 유틸.
// - git diff --numstat 이 다루지 않는 새 파일의 추가 라인 수를 UI 서비스들이 공유한다.
import * as path from "node:path";
import { readFile } from "node:fs/promises";

/**
 * 미추적 파일의 추가 라인 수를 계산한다.
 * - 새 파일은 비교 기준에 존재하지 않으므로 삭제 라인은 호출부에서 0으로 둔다.
 * - 바이너리 파일이나 읽을 수 없는 파일은 비용과 오류 전파를 피하기 위해 0라인으로 처리한다.
 * @param repoRoot 저장소 루트 절대 경로
 * @param relPath  저장소 루트 기준 상대 경로
 */
export async function countUntrackedLines(
  repoRoot: string,
  relPath: string
): Promise<number> {
  try {
    const raw = await readFile(path.join(repoRoot, relPath));
    if (raw.includes(0) || raw.length === 0) {
      return 0;
    }
    const text = raw.toString("utf8");
    return text.endsWith("\n")
      ? text.split("\n").length - 1
      : text.split("\n").length;
  } catch {
    return 0;
  }
}
