// 로컬 브랜치가 remote 기준점보다 앞서거나 remote 에 없는 커밋 범위를 계산하는 보조 모듈.
// - 그래프 렌더링에서 "로컬에만 있는 커밋"을 표시할 수 있도록 해시별 브랜치 목록을 만든다.
import type { LocalBranchStatus } from "../graph/graphTypes";
import { runGit } from "./gitExec";

/** local-only 계산이 다른 git status/refresh 를 밀어내지 않도록 제한하는 동시 실행 수 */
const LOCAL_ONLY_BRANCH_CONCURRENCY = 4;

/**
 * 로컬 전용 커밋 범위를 해시별로 묶는다.
 * - upstream 이 살아 있으면 `upstream..local` 을 사용해 해당 브랜치의 ahead 커밋을 표시한다.
 * - upstream 이 없거나 gone 이면 `local --not --remotes` 로 어떤 원격에도 없는 커밋을 표시한다.
 * @param repoRoot git 명령을 실행할 저장소 루트
 * @param branches `getLocalBranches` 가 반환한 로컬 브랜치 상태 목록
 * @returns 로컬 전용 커밋 해시별 브랜치 이름 맵
 */
export async function loadLocalOnlyBranchMap(
  repoRoot: string,
  branches: LocalBranchStatus[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const candidates = branches.filter((branch) => shouldInspectBranch(branch));
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(LOCAL_ONLY_BRANCH_CONCURRENCY, candidates.length) },
    async () => {
      for (;;) {
        const branch = candidates[nextIndex++];
        if (!branch) {
          return;
        }
        await appendLocalOnlyBranch(result, repoRoot, branch);
      }
    }
  );
  await Promise.all(workers);
  return result;
}

/**
 * 브랜치 하나의 로컬 전용 커밋을 읽어 결과 맵에 추가한다.
 * - 브랜치 단위 실패는 전체 그래프 표시를 막지 않도록 빈 결과로 처리한다.
 * @param map      commit hash → 브랜치 이름 배열 맵
 * @param repoRoot git 명령을 실행할 저장소 루트
 * @param branch   검사할 로컬 브랜치 상태
 */
async function appendLocalOnlyBranch(
  map: Map<string, string[]>,
  repoRoot: string,
  branch: LocalBranchStatus
): Promise<void> {
  const out = await runGit(revListArgsForBranch(branch), repoRoot).catch(() => "");
  for (const hash of out.split("\n").filter(Boolean)) {
    addBranchName(map, hash, branch.name);
  }
}

/**
 * 로컬 전용 커밋을 검사해야 하는 브랜치인지 판단한다.
 * @param branch 로컬 브랜치 상태
 */
function shouldInspectBranch(branch: LocalBranchStatus): boolean {
  return branch.upstream && !branch.gone
    ? branch.ahead > 0
    : true;
}

/**
 * 브랜치 상태에 맞는 rev-list 인자를 만든다.
 * @param branch 로컬 브랜치 상태
 */
function revListArgsForBranch(branch: LocalBranchStatus): string[] {
  const localRef = `refs/heads/${branch.name}`;
  if (branch.upstream && !branch.gone) {
    return ["rev-list", `${branch.upstream}..${localRef}`];
  }
  return ["rev-list", localRef, "--not", "--remotes"];
}

/**
 * 해시별 브랜치 목록 맵에 브랜치 이름을 중복 없이 추가한다.
 * @param map        commit hash → 브랜치 이름 배열 맵
 * @param hash       로컬 전용 커밋 해시
 * @param branchName 이 커밋을 포함하는 로컬 브랜치 이름
 */
function addBranchName(
  map: Map<string, string[]>,
  hash: string,
  branchName: string
): void {
  const list = map.get(hash) ?? [];
  if (!list.includes(branchName)) {
    list.push(branchName);
  }
  map.set(hash, list);
}
