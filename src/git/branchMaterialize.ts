// 원격 브랜치를 브랜치 작업 source 로 사용할 때 필요한 로컬 브랜치 materialize 헬퍼.
// - branch squash/rebase merge 는 로컬 브랜치를 source 로 다루므로, remote-only 브랜치는
//   같은 이름의 로컬 브랜치를 먼저 만든 뒤 기존 branch operation 경로를 재사용한다.
import type { BranchKind } from "./gitTypes";
import { runGit } from "./gitExec";

/** merge source 로 사용할 로컬 브랜치 준비 결과 */
export interface MaterializedBranchSource {
  branch: string;
  sourceBranch: string;
  sourceKind: BranchKind;
  created: boolean;
}

/**
 * 로컬/원격 source 브랜치를 branch operation 에 사용할 로컬 브랜치 이름으로 정규화한다.
 * - 로컬 브랜치는 그대로 반환한다.
 * - 원격 브랜치는 `origin/foo` 에서 `foo` 를 로컬 이름으로 만들고, 이미 있으면 기존 로컬 브랜치를 사용한다.
 * @param repoRoot git 저장소 루트
 * @param sourceBranch 사용자가 선택한 source 브랜치 이름
 * @param sourceKind sourceBranch 의 로컬/원격 종류
 * @returns branch operation 에 넘길 로컬 브랜치 이름과 생성 여부
 */
export async function materializeBranchSource(
  repoRoot: string,
  sourceBranch: string,
  sourceKind: BranchKind
): Promise<MaterializedBranchSource> {
  if (sourceKind === "local") {
    return {
      branch: sourceBranch,
      sourceBranch,
      sourceKind,
      created: false,
    };
  }
  const localName = localNameForRemoteBranch(sourceBranch);
  if (await localBranchExists(repoRoot, localName)) {
    return {
      branch: localName,
      sourceBranch,
      sourceKind,
      created: false,
    };
  }
  await runGit(["branch", "--track", localName, sourceBranch], repoRoot);
  return {
    branch: localName,
    sourceBranch,
    sourceKind,
    created: true,
  };
}

/**
 * origin/feature 형태의 remote ref 에서 feature 를 로컬 브랜치명으로 사용한다.
 * @param remoteBranch 원격 브랜치 short name
 * @returns 로컬 브랜치로 만들 이름
 */
export function localNameForRemoteBranch(remoteBranch: string): string {
  const slash = remoteBranch.indexOf("/");
  return slash >= 0 ? remoteBranch.slice(slash + 1) : remoteBranch;
}

/**
 * 로컬 브랜치가 존재하는지 확인한다.
 * @param repoRoot git 저장소 루트
 * @param branch 확인할 로컬 브랜치 이름
 */
async function localBranchExists(repoRoot: string, branch: string): Promise<boolean> {
  const out = await runGit(
    ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
    repoRoot
  ).catch(() => "");
  return out.trim().length > 0;
}
