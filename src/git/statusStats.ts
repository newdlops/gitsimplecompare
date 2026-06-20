// 작업트리 상태 목록에 +/- 라인 통계를 붙이는 보조 모듈.
// - GitService 의 status 조회와 VS Code Git provider 상태 보강이 같은 numstat 병합 로직을 공유한다.
import { parseNumstat } from "./diffParse";
import type { StatusGroups } from "./gitService";
import { countUntrackedLines } from "./untrackedStats";

type RunGitLike = (args: string[]) => Promise<string>;

/**
 * 현재 index/working diff 를 읽어 이미 분류된 상태 목록에 라인 증감 정보를 붙인다.
 * - `git status` 를 다시 읽지 않고 numstat 만 조회해 빠른 상태 provider 결과를 보강한다.
 * @param repoRoot 저장소 루트
 * @param groups staged/unstaged 파일 목록
 * @param run git 명령 실행 함수
 */
export async function attachStatusStats(
  repoRoot: string,
  groups: StatusGroups,
  run: RunGitLike
): Promise<StatusGroups> {
  if (!groups.staged.length && !groups.unstaged.length) {
    return { staged: [], unstaged: [] };
  }
  const [stagedNum, unstagedNum] = await Promise.all([
    groups.staged.length
      ? run(["diff", "--cached", "--numstat", "-z", "-M"]).catch(() => "")
      : Promise.resolve(""),
    groups.unstaged.length
      ? run(["diff", "--numstat", "-z", "-M"]).catch(() => "")
      : Promise.resolve(""),
  ]);
  return attachParsedStatusStats(repoRoot, groups, stagedNum, unstagedNum);
}

/**
 * 이미 읽은 numstat 원문을 staged/unstaged 목록에 병합한다.
 * - 미추적 파일은 diff numstat 에 나오지 않으므로 파일을 직접 읽어 추가 라인 수를 계산한다.
 * @param repoRoot 저장소 루트
 * @param groups      staged/unstaged 파일 목록
 * @param stagedNum   `git diff --cached --numstat -z` 출력
 * @param unstagedNum `git diff --numstat -z` 출력
 */
export async function attachParsedStatusStats(
  repoRoot: string,
  groups: StatusGroups,
  stagedNum: string,
  unstagedNum: string
): Promise<StatusGroups> {
  const stagedCounts = parseNumstat(stagedNum);
  const unstagedCounts = parseNumstat(unstagedNum);

  const staged = groups.staged.map((change) => {
    const stat = stagedCounts.get(change.path);
    return { ...change, additions: stat?.additions, deletions: stat?.deletions };
  });
  const unstaged = await Promise.all(
    groups.unstaged.map(async (change) => {
      const stat = unstagedCounts.get(change.path);
      if (stat) {
        return {
          ...change,
          additions: stat.additions,
          deletions: stat.deletions,
        };
      }
      if (change.status === "A") {
        const additions = await countUntrackedLines(repoRoot, change.path);
        return additions === undefined
          ? { ...change }
          : { ...change, additions, deletions: 0 };
      }
      return { ...change, additions: 0, deletions: 0 };
    })
  );
  return { staged, unstaged };
}
