// 로컬 브랜치가 upstream 보다 앞선 커밋 범위를 계산하는 보조 모듈.
// - 그래프 렌더링에서 "로컬에만 있는 커밋"을 표시할 수 있도록 해시별 브랜치 목록을 만든다.
import type { LocalBranchStatus } from "../graph/graphTypes";
import { runGit } from "./gitExec";

/**
 * ahead 상태인 로컬 브랜치의 `upstream..local` 범위를 해시별로 묶는다.
 * - upstream 이 없거나 사라진 브랜치는 기준점이 모호하므로 표시 대상에서 제외한다.
 * @param repoRoot git 명령을 실행할 저장소 루트
 * @param branches `getLocalBranches` 가 반환한 로컬 브랜치 상태 목록
 * @returns 로컬 전용 커밋 해시별 브랜치 이름 맵
 */
export async function loadLocalOnlyBranchMap(
  repoRoot: string,
  branches: LocalBranchStatus[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  await Promise.all(
    branches
      .filter((branch) => branch.upstream && !branch.gone && branch.ahead > 0)
      .map(async (branch) => {
        const out = await runGit(
          ["rev-list", `${branch.upstream}..refs/heads/${branch.name}`],
          repoRoot
        ).catch(() => "");
        for (const hash of out.split("\n").filter(Boolean)) {
          addBranchName(result, hash, branch.name);
        }
      })
  );
  return result;
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
