// 그래프 드래그 대상 커밋을 interactive rebase 의 --onto 인자로 사용할지 판단한다.
// - rebase 계획 생성에서만 필요한 git 범위 판단을 RebaseService 밖으로 분리해 서비스 책임을 줄인다.
import { runGit } from "./gitExec";

/**
 * 드래그 drop 대상 커밋을 --onto 로 사용할 수 있는지 판단한다.
 * - 대상이 base 이거나 base..HEAD 재작성 범위 내부면 reorder 의도로 보고 --onto 를 생략한다.
 * - 대상이 다른 브랜치/과거 커밋처럼 범위 밖이면 현재 브랜치를 그 커밋 위로 옮기는 계획이 된다.
 * @param repoRoot 저장소 루트
 * @param ontoHash 사용자가 드래그를 놓은 대상 커밋 해시
 * @param base     rebase 기준점
 * @param root     root rebase 여부
 * @returns --onto 로 넘길 정규화된 커밋 해시. 사용할 수 없으면 undefined
 */
export async function usableRebaseOntoTarget(
  repoRoot: string,
  ontoHash: string | undefined,
  base: string,
  root: boolean
): Promise<string | undefined> {
  if (!ontoHash) {
    return undefined;
  }
  const onto = await normalizeCommit(repoRoot, ontoHash);
  if (!root && onto === base) {
    return undefined;
  }
  const insideRewrittenRange = root
    ? await isAncestor(repoRoot, onto, "HEAD")
    : (await isAncestor(repoRoot, base, onto)) &&
      (await isAncestor(repoRoot, onto, "HEAD"));
  return insideRewrittenRange ? undefined : onto;
}

/**
 * 사용자가 그래프에서 넘긴 해시가 실제 commit 인지 확인하고 전체 해시로 정규화한다.
 * @param repoRoot 저장소 루트
 * @param hash     그래프 row/node 에서 넘어온 커밋 식별자
 * @returns git 이 확인한 commit 해시
 */
async function normalizeCommit(repoRoot: string, hash: string): Promise<string> {
  return (
    await runGit(["rev-parse", "--verify", `${hash}^{commit}`], repoRoot)
  ).trim();
}

/**
 * ancestor 가 target 의 조상인지 확인한다.
 * @param repoRoot 저장소 루트
 * @param ancestor 조상인지 확인할 커밋
 * @param target   대상 커밋
 */
async function isAncestor(
  repoRoot: string,
  ancestor: string,
  target: string
): Promise<boolean> {
  try {
    await runGit(["merge-base", "--is-ancestor", ancestor, target], repoRoot);
    return true;
  } catch {
    return false;
  }
}
