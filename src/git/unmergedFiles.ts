// 충돌 유무는 작업 파일 diff 대신 Git index의 unmerged stage만 읽어 판단한다.
import { runGit } from "./gitExec";

/**
 * 작업트리/미추적 파일을 검색하지 않고 stage 1/2/3에 남은 충돌 경로를 반환한다.
 * - 동일 경로의 여러 stage는 하나로 합치고 NUL 구분으로 특수 문자 파일명을 보존한다.
 * - 매번 실제 index를 읽어 Resolve/Continue 직후의 변경도 즉시 반영한다.
 * @param repoRoot 저장소 루트 또는 linked worktree 루트
 * @returns Git index 순서의 중복 없는 충돌 경로
 */
export async function listUnmergedFiles(repoRoot: string): Promise<string[]> {
  const out = await runGit(["ls-files", "--unmerged", "-z"], repoRoot);
  const paths = out.split("\0").filter(Boolean).map(entry => {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw new Error("Invalid unmerged index entry.");
    return entry.slice(separator + 1);
  });
  return [...new Set(paths)];
}
