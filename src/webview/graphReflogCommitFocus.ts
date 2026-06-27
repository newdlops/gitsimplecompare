// reflog commit 을 그래프에 표시하기 위한 window 로딩 보조 모듈.
// - reflog 는 현재 ref 밖 commit 을 가리킬 수 있으므로 대상 hash 를 직접 rev 로 읽는다.
import { CommitWindowResult, loadDirectCommitWindow } from "../git/gitLogWindow";
import { logError, logInfo } from "../ui/outputLog";

/**
 * reflog 항목의 commit 을 포함하는 직접 graph window 를 읽는다.
 * @param repoRoot 저장소 루트
 * @param hash     reflog 항목이 가리키는 commit hash
 * @param limit    대상 commit 과 조상 방향으로 읽을 최대 commit 수
 * @returns 대상 commit 이 포함된 window. Git 이 해당 hash 를 찾지 못하면 undefined
 */
export async function loadGraphReflogCommitWindow(
  repoRoot: string,
  hash: string,
  limit: number
): Promise<CommitWindowResult | undefined> {
  const targetHash = hash.trim();
  try {
    const result = await loadDirectCommitWindow(repoRoot, targetHash, limit);
    const found = result.commits.some((commit) => commit.hash === targetHash);
    logInfo("graph reflog commit window loaded", {
      repoRoot,
      hash: targetHash,
      found,
      count: result.commits.length,
    });
    return found ? result : undefined;
  } catch (error) {
    logError("graph reflog commit window failed", error, { repoRoot, hash: targetHash });
    return undefined;
  }
}
