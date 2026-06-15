// stash 계열 git 명령을 실행하는 공통 헬퍼.
// - 일부 저장소에서 fsmonitor daemon IPC 가 깨져 있으면 stash apply/pop/push 가 index 쓰기 단계에서
//   `could not write index` 로 실패할 수 있어, stash 명령에는 fsmonitor 를 명시적으로 끈다.
import { runGit, type RunGitOptions } from "./gitExec";

/**
 * `git stash ...` 명령을 fsmonitor 비활성화 옵션과 함께 실행한다.
 * - 일반 git 실행 경로(runGit)는 유지하되, stash 가 index 를 갱신하는 순간 fsmonitor 오류에 막히지 않게 한다.
 * @param args `stash` 뒤에 붙일 인자 배열
 * @param repoRoot git 저장소 루트
 * @param options 추가 env 또는 lock 재시도 옵션
 * @returns git 표준 출력
 */
export function runStash(
  args: string[],
  repoRoot: string,
  options?: RunGitOptions
): Promise<string> {
  return runGit(["-c", "core.fsmonitor=false", "stash", ...args], repoRoot, options);
}
