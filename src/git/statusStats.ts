// 작업트리 상태 목록에 +/- 라인 통계를 붙이는 보조 모듈.
// - GitService 의 status 조회와 VS Code Git provider 상태 보강이 같은 numstat 병합 로직을 공유한다.
import { parseNumstat } from "./diffParse";
import type { StatusGroups } from "./gitService";
import { countUntrackedLines } from "./untrackedStats";

type RunGitLike = (args: string[]) => Promise<string>;
const UNTRACKED_STATS_CONCURRENCY = 16;

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
  const unstaged = await mapWithConcurrency(
    groups.unstaged,
    UNTRACKED_STATS_CONCURRENCY,
    async (change) => {
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
    }
  );
  return { staged, unstaged };
}

/**
 * 입력 순서를 보존하면서 파일 I/O 작업을 제한된 worker 수로 병렬 실행한다.
 * - 미추적 파일이 수천 개여도 stat/readFile을 한꺼번에 열지 않아 FD 고갈과 디스크 seek 폭주를 막는다.
 * - worker는 서로 독립된 index를 가져가므로 작은 목록은 가능한 만큼 동시에 처리한다.
 * @param items 순서를 보존할 입력 목록
 * @param concurrency 동시에 실행할 최대 작업 수
 * @param mapper 항목 하나를 비동기로 변환하는 함수
 * @returns 입력과 같은 순서로 채운 변환 결과
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => worker()
    )
  );
  return results;
}
