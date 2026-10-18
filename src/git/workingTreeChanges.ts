// 작업 전 변경 유무만 필요한 경로에서 전체 미추적 파일 목록을 만들지 않도록 공통 조회를 제공한다.
import { runGit } from "./gitExec";

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
