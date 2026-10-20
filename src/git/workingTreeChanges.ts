// 작업 전 변경 유무만 필요한 경로에서 전체 미추적 파일 목록을 만들지 않도록 공통 조회를 제공한다.
import { GitError, runGit } from "./gitExec";

/**
 * index·작업트리·미추적 파일 중 변경이 하나라도 있으면 true를 반환한다.
 * - 경로 목록을 쓰지 않으므로 미추적 디렉터리는 normal 모드로 묶어 하위 파일의 전수 탐색을 피한다.
 * - status.showUntrackedFiles는 표시 설정이므로 작업 전 사용자 파일 보존 판단에는 적용하지 않는다.
 * @param repoRoot 검사할 저장소 또는 linked worktree의 루트
 * @param disableFsmonitor daemon 오류를 피해야 하는 기존 PR 경로에서만 fsmonitor를 비활성화한다.
 * @returns ignored 파일을 제외한 실제 변경이 있으면 true. Git 조회 오류는 숨기지 않고 전파한다.
 */
export async function hasWorkingTreeChanges(repoRoot: string, disableFsmonitor = false): Promise<boolean> {
  const args = [
    ...(disableFsmonitor ? ["-c", "core.fsmonitor=false"] : []),
    "status", "--porcelain=v1", "-z", "--untracked-files=normal",
  ];
  return (await runGit(args, repoRoot)).length > 0;
}

/**
 * commit할 tracked 변경이 있는지 index부터 확인하고, 이미 있으면 작업 파일 조회를 생략한다.
 * - staged/unstaged가 상쇄돼 HEAD와 작업 파일이 같아도 index의 변경은 놓치지 않는다.
 * - 미추적 파일은 commit 대상이 아니므로 열거하지 않으며 외부 diff/textconv도 실행하지 않는다.
 * - index만 읽는 첫 비교는 fsmonitor를 끄고, 작업 파일 비교는 기존 감시자 정책을 유지한다.
 * @param repoRoot 검사할 저장소 또는 격리 worktree의 루트
 * @returns staged 또는 unstaged 변경이 있으면 true. exit 1 이외의 Git 실패는 원인 그대로 전파한다.
 */
export async function hasTrackedWorkingTreeChanges(repoRoot: string): Promise<boolean> {
  return await hasStagedWorkingTreeChanges(repoRoot) || await hasTrackedDiff(repoRoot, false);
}

/**
 * Native merge/replay가 확정한 index에 commit할 변경이 있는지만 확인한다.
 * @param repoRoot 저장소 또는 임시 worktree 루트
 * @returns HEAD와 index가 다르면 true. 표시용 submodule ignore 설정으로 staged gitlink를 숨기지 않는다.
 */
export function hasStagedWorkingTreeChanges(repoRoot: string): Promise<boolean> {
  return hasTrackedDiff(repoRoot, true);
}

/**
 * 한쪽 index 비교의 차이만 Git exit 1로 판정하고 timeout·권한·저장소 오류와 구분한다.
 * @param repoRoot 조회 루트 @param staged HEAD↔index이면 true, index↔작업 파일이면 false
 * @returns diff 존재 여부. 출력·파일명 목록·별도 캐시는 만들지 않는다.
 */
async function hasTrackedDiff(repoRoot: string, staged: boolean): Promise<boolean> {
  try {
    await runGit([...(staged ? ["-c", "core.fsmonitor=false"] : []), "diff", ...(staged ? ["--cached", "--ignore-submodules=none"] : []),
      "--quiet", "--no-ext-diff", "--no-textconv", "--"], repoRoot);
    return false;
  } catch (error) {
    if (error instanceof GitError && error.code === 1) return true;
    throw error;
  }
}
