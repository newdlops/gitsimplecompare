// 커밋 직전 index에 실제 변경이 있는지만 가볍게 확인하는 Git 조회 모듈.
// - 전체 porcelain/untracked 탐색은 하지 않고 cached diff 경로만 읽어 큰 작업트리에서도 빠르게 동작한다.
import { runGit } from "./gitExec";

/**
 * 현재 index에 HEAD와 다른 stage 항목이 하나라도 있는지 확인한다.
 * - `git diff --cached --name-only -z`는 파일 통계와 untracked 디렉터리를 계산하지 않아
 *   스마트 커밋의 stage 정책을 정하는 용도로 전체 status보다 훨씬 저렴하다.
 * @param repoRoot 확인할 Git 저장소 루트
 * @returns 커밋할 staged 경로가 하나라도 있으면 true
 */
export async function hasStagedChanges(repoRoot: string): Promise<boolean> {
  const paths = await runGit(
    ["diff", "--cached", "--name-only", "-z", "--"],
    repoRoot
  );
  return paths.length > 0;
}
