// 작업 전 변경 유무만 필요한 경로에서 전체 미추적 파일 목록을 만들지 않도록 공통 조회를 제공한다.
import { GitError, runGit, runGitStreamResult } from "./gitExec";
import { forgetWorkingTreeChangeHints, recentWorkingTreeChangeHints } from "./workingTreeChangeHints";
import { logInfo } from "../ui/outputLog";

/**
 * index·작업트리·미추적 파일 중 변경이 하나라도 있으면 true를 반환한다.
 * - 경로 목록을 쓰지 않으므로 미추적 디렉터리는 normal 모드로 묶어 하위 파일의 전수 탐색을 피한다.
 * - status.showUntrackedFiles는 표시 설정이므로 작업 전 사용자 파일 보존 판단에는 적용하지 않는다.
 * - 이동 여부와 경로 목록은 사용하지 않아 rename 유사도 비교를 생략하고 stdout은 boolean만 보존한다.
 * - stdout에 변경이 있어도 Native Git이 성공/close하기 전에는 결과를 반환하지 않는다.
 * - 최근 표시 경로에서 실제 변경을 찾으면 true로 완료한다. 찾지 못하면 캐시를 버리고 전체 검사를 실행한다.
 * @param repoRoot 검사할 저장소 또는 linked worktree의 루트
 * @param disableFsmonitor daemon 오류를 피해야 하는 기존 PR 경로에서만 fsmonitor를 비활성화한다.
 * @returns ignored 파일을 제외한 실제 변경이 있으면 true. Git 조회 오류는 숨기지 않고 전파한다.
 */
export async function hasWorkingTreeChanges(repoRoot: string, disableFsmonitor = false): Promise<boolean> {
  const hints = recentWorkingTreeChangeHints(repoRoot);
  if (hints.length) {
    if (await readChanges(repoRoot, disableFsmonitor, hints)) {
      logInfo("working tree change confirmed from recent paths", { repoRoot, candidateCount: hints.length });
      return true;
    }
    forgetWorkingTreeChangeHints(repoRoot);
    logInfo("working tree change hint missed; full scan required", { repoRoot, candidateCount: hints.length });
  }
  return readChanges(repoRoot, disableFsmonitor);
}

/**
 * Native가 성공·close한 출력의 변경 존재만 반환한다. 범위 검사가 false여도 전체 clean을 증명하지 않는다.
 * @param repoRoot 검사 저장소 @param disableFsmonitor 기존 사전 검사의 command-scope 정책
 * @param paths 옵션·glob으로 해석하지 않을 최근 경로 후보. 생략하면 기존 전체 조회다.
 * @returns 해당 범위에 Native 변경이 있으면 true. 부분 출력 뒤의 오류는 그대로 전파한다.
 */
async function readChanges(repoRoot: string, disableFsmonitor: boolean, paths?: string[]): Promise<boolean> {
  const args = [
    ...(paths ? ["--literal-pathspecs"] : []),
    ...(disableFsmonitor ? ["-c", "core.fsmonitor=false"] : []),
    "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames",
    ...(paths ? ["--", ...paths] : []),
  ];
  return runGitStreamResult(args, repoRoot, () => {
    // lock/spawn 재시도는 새 reader를 만든다. 이전 시도의 부분 출력으로 clean 결과를 덮지 않는다.
    let changed = false;
    return { onData: (chunk: Buffer) => { changed ||= chunk.length > 0; }, finish: () => changed };
  });
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
