// 작업트리 상태 목록에 +/- 라인 통계를 붙이는 보조 모듈.
// - GitService 의 status 조회와 VS Code Git provider 상태 보강이 같은 numstat 병합 로직을 공유한다.
// - 대량 변경 bucket 은 largeChangeSet 정책에 따라 통계를 생략해 stage/commit 과 디스크를 다투지 않게 한다.
// - 대용량 파일은 줄 단위 diff 를 하지 않는다(staged 는 크기로 binary 판정, 작업트리는 pathspec 제외).
import * as path from "node:path";
import { stat } from "node:fs/promises";
import { parseNumstat, type NumstatCount } from "./diffParse";
import type { StatusGroups } from "./gitService";
import {
  LINE_STATS_MAX_FILE_BYTES,
  MAX_LARGE_FILE_EXCLUDES,
  blobDiffSizeLimitArgs,
  largeFileExcludePathspecs,
  shouldComputeLineStats,
} from "./largeChangeSet";
import { countUntrackedLines } from "./untrackedStats";

type RunGitLike = (args: string[]) => Promise<string>;
const UNTRACKED_STATS_CONCURRENCY = 4;
const WORKING_SIZE_CONCURRENCY = 8;
/** 작업트리 파일이 있고 `git diff`(index ↔ 작업트리)가 그 내용을 읽는 unstaged 상태. */
const TRACKED_WORKING_STATUSES = new Set(["M", "T", "U", "R", "C"]);

/** 작업트리 numstat 에서 내용 비교를 건너뛴 unstaged 항목 정보. */
interface UnstagedStatsSkip {
  /** 크기 상한을 넘어 pathspec 으로 제외한 경로. */
  paths: ReadonlySet<string>;
  /** 대용량 파일이 너무 많아 추적 파일 numstat 전체를 생략했으면 true. */
  allTracked: boolean;
}

/**
 * 현재 index/working diff 를 읽어 이미 분류된 상태 목록에 라인 증감 정보를 붙인다.
 * - `git status` 를 다시 읽지 않고 numstat 만 조회해 빠른 상태 provider 결과를 보강한다.
 * - 통계를 생략할 만큼 큰 bucket 은 numstat 프로세스 자체를 실행하지 않는다.
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
  // 두 read-only diff도 큰 저장소에서는 CPU/디스크를 크게 쓰므로 staged 뒤 unstaged 순서로 직렬화한다.
  // staged 는 blob 끼리 비교하므로 크기 임계값만으로 대용량 파일 내용 diff 를 건너뛴다.
  const stagedNum = hasLineStatsBucket(groups.staged.length)
    ? await run([...blobDiffSizeLimitArgs(), "diff", "--cached", "--numstat", "-z", "-M"]).catch(() => "")
    : "";
  let unstagedNum = "";
  let skip: UnstagedStatsSkip = { paths: new Set(), allTracked: false };
  if (hasLineStatsBucket(groups.unstaged.length)) {
    const large = await largeWorkingFiles(repoRoot, groups.unstaged);
    if (large.length > MAX_LARGE_FILE_EXCLUDES) {
      skip = { paths: new Set(large), allTracked: true };
    } else {
      skip = { paths: new Set(large), allTracked: false };
      // 작업트리 쪽 대용량 파일을 먼저 pathspec 으로 빼야 임계값이 해시 계산을 느리게 만들지 않는다.
      unstagedNum = await run([
        ...blobDiffSizeLimitArgs(),
        "diff",
        "--numstat",
        "-z",
        "-M",
        ...largeFileExcludePathspecs(large),
      ]).catch(() => "");
    }
  }
  return attachParsedStatusStats(repoRoot, groups, stagedNum, unstagedNum, skip);
}

/**
 * unstaged 추적 파일 중 작업트리 크기가 라인 통계 상한을 넘는 경로를 찾는다.
 * - stat 만 하므로 파일 내용은 읽지 않으며, 동시에 여는 파일 수를 제한한다.
 * - 삭제(D)·미추적(A) 항목은 작업트리 내용을 diff 하지 않으므로 검사하지 않는다.
 * @param repoRoot 저장소 루트
 * @param changes unstaged 파일 목록
 * @returns 크기 상한을 넘는 저장소 상대 경로(입력 순서 유지)
 */
async function largeWorkingFiles(
  repoRoot: string,
  changes: StatusGroups["unstaged"]
): Promise<string[]> {
  const tracked = changes.filter((change) => TRACKED_WORKING_STATUSES.has(change.status));
  const sizes = await mapWithConcurrency(tracked, WORKING_SIZE_CONCURRENCY, async (change) => {
    try {
      return (await stat(path.join(repoRoot, change.path))).size;
    } catch {
      return 0;
    }
  });
  return tracked
    .filter((_, index) => sizes[index] > LINE_STATS_MAX_FILE_BYTES)
    .map((change) => change.path);
}

/**
 * 상태 목록 중 라인 통계를 계산할 bucket 이 하나라도 있는지 확인한다.
 * - 호출부(refresh 스케줄러)가 통계 보강 pass 자체를 예약할지 결정하는 데 쓴다.
 * @param groups staged/unstaged 파일 목록
 * @returns 비어 있지 않고 크기 제한 안인 bucket 이 있으면 true
 */
export function hasLineStatsWork(groups: StatusGroups): boolean {
  return (
    hasLineStatsBucket(groups.staged.length) ||
    hasLineStatsBucket(groups.unstaged.length)
  );
}

/**
 * 이미 읽은 numstat 원문을 staged/unstaged 목록에 병합한다.
 * - 미추적 파일은 diff numstat 에 나오지 않으므로 파일을 직접 읽어 추가 라인 수를 계산한다.
 * - 통계 생략 대상(대량 bucket, 대용량·binary 파일)은 additions/deletions 를 비워 둬 UI 가 +/- 를
 *   표시하지 않게 한다(0 으로 채우면 "변경 없음"으로 오해된다).
 * @param repoRoot 저장소 루트
 * @param groups      staged/unstaged 파일 목록
 * @param stagedNum   `git diff --cached --numstat -z` 출력
 * @param unstagedNum `git diff --numstat -z` 출력
 * @param skip 작업트리 numstat 에서 내용 비교를 건너뛴 경로/범위
 */
export async function attachParsedStatusStats(
  repoRoot: string,
  groups: StatusGroups,
  stagedNum: string,
  unstagedNum: string,
  skip: UnstagedStatsSkip = { paths: new Set(), allTracked: false }
): Promise<StatusGroups> {
  const staged = shouldComputeLineStats(groups.staged.length)
    ? withStagedStats(groups.staged, parseNumstat(stagedNum))
    : withoutStats(groups.staged);
  const unstaged = shouldComputeLineStats(groups.unstaged.length)
    ? await withUnstagedStats(repoRoot, groups.unstaged, parseNumstat(unstagedNum), skip)
    : withoutStats(groups.unstaged);
  return { staged, unstaged };
}

/** 비어 있지 않고 정책 상한 안인 bucket 인지 확인한다. */
function hasLineStatsBucket(fileCount: number): boolean {
  return fileCount > 0 && shouldComputeLineStats(fileCount);
}

/**
 * staged 항목에 `git diff --cached --numstat` 결과를 붙인다.
 * @param changes staged 파일 목록
 * @param counts 경로별 추가/삭제 라인 수
 */
function withStagedStats(
  changes: StatusGroups["staged"],
  counts: Map<string, NumstatCount>
): StatusGroups["staged"] {
  return changes.map((change) => {
    const stat = counts.get(change.path);
    return stat?.binary
      ? { ...change, additions: undefined, deletions: undefined }
      : { ...change, additions: stat?.additions, deletions: stat?.deletions };
  });
}

/**
 * unstaged 항목에 numstat 결과를 붙이고, numstat 에 없는 미추적 파일은 직접 줄 수를 센다.
 * - 대용량이라 제외한 파일과 binary 파일은 통계 없이 둔다.
 * @param repoRoot 저장소 루트
 * @param changes unstaged 파일 목록
 * @param counts 경로별 추가/삭제 라인 수
 * @param skip 작업트리 numstat 에서 내용 비교를 건너뛴 경로/범위
 */
function withUnstagedStats(
  repoRoot: string,
  changes: StatusGroups["unstaged"],
  counts: Map<string, NumstatCount>,
  skip: UnstagedStatsSkip
): Promise<StatusGroups["unstaged"]> {
  return mapWithConcurrency(
    changes,
    UNTRACKED_STATS_CONCURRENCY,
    async (change) => {
      const skipped =
        skip.paths.has(change.path) || (skip.allTracked && change.status !== "A");
      const stat = counts.get(change.path);
      if (skipped || stat?.binary) {
        return { ...change, additions: undefined, deletions: undefined };
      }
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
}

/**
 * 통계 생략 bucket 의 항목을 additions/deletions 없이 복사한다.
 * - 입력이 이전 통계를 들고 있어도 지워서, 오래된 +/- 가 새 목록에 남지 않게 한다.
 * @param changes 복사할 파일 목록
 */
function withoutStats(
  changes: StatusGroups["staged"]
): StatusGroups["staged"] {
  return changes.map(({ additions: _additions, deletions: _deletions, ...change }) => ({
    ...change,
  }));
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
