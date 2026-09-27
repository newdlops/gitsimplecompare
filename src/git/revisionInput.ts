// git log / rev-list 에 ref 범위를 넘기는 공용 실행 모듈.
// - 브랜치 필터·원격 카탈로그 대기·손상 ref 모드에서는 수천 개 ref 이름이 명시되는데, 이를 argv 로 넘기면
//   Windows 명령줄 한도(32K)를 넘고 macOS/Linux 에서도 프로세스 생성 비용이 커진다. 그래서 `--stdin` 으로 넘긴다.
import { runGit, runGitWithInput } from "./gitExec";

/** ref 가 비었을 때 Graph 전체 범위를 뜻하는 git 인자. */
export const ALL_GRAPH_REF_ARGS: readonly string[] = ["--branches", "--remotes", "--tags"];

/**
 * git log / rev-list 를 ref 범위와 함께 실행한다.
 * - refs 가 비면 `--branches --remotes --tags` 를, 있으면 `--stdin` 으로 ref 이름을 한 줄씩 넘긴다.
 * - `--stdin` 은 log/rev-list 가 argv revision 과 같은 규칙으로 해석하므로 결과 순서와 decoration 은 같다.
 * @param args revision 앞까지의 git 인자(예: `["log", "--topo-order", ...]`)
 * @param refs 명시 ref 이름 목록. 비면 Graph 전체 범위
 * @param repoRoot git 을 실행할 저장소 루트
 * @returns git stdout
 */
export function runGitWithRevisions(
  args: readonly string[],
  refs: readonly string[],
  repoRoot: string
): Promise<string> {
  if (refs.length === 0) {
    return runGit([...args, ...ALL_GRAPH_REF_ARGS], repoRoot);
  }
  return runGitWithInput([...args, "--stdin"], repoRoot, `${refs.join("\n")}\n`);
}
