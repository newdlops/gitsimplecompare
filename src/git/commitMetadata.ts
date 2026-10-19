// 여러 commit의 parent/tree를 한 Git 프로세스로 읽어 PR 계획 단계의 반복 실행 비용을 줄인다.
import { runGitWithInput } from "./gitExec";

/** commit을 재생하거나 범위로 집계할 때 필요한 원본 object 정보다. */
export interface CommitMetadata {
  parents: string[];
  tree: string;
}

const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/**
 * 정규화된 commit 목록의 부모와 tree를 입력 순서와 무관한 Map으로 반환한다.
 * 누락·잘린 출력은 빈 부모로 추정하지 않고 오류로 처리해 merge commit을 잘못 집계하지 않는다.
 * @param repoRoot object를 읽을 저장소
 * @param commits materialize/존재 검증을 마친 전체 OID 목록
 * @returns 모든 요청 commit을 포함하는 metadata Map. 빈 입력은 Git을 실행하지 않는다.
 */
export async function readCommitMetadata(repoRoot: string, commits: readonly string[]): Promise<Map<string, CommitMetadata>> {
  const requested = new Set(commits);
  if (!requested.size) return new Map();
  const output = await runGitWithInput([
    "-c", "log.showSignature=false", "log", "--no-walk=unsorted", "--no-color",
    "--format=%H%x00%P%x00%T", "--stdin",
  ], repoRoot, `${[...requested].join("\n")}\n`);
  const result = new Map<string, CommitMetadata>();
  for (const line of output.trimEnd().split("\n")) {
    const [hash, parentText, tree, extra] = line.split("\0");
    const parents = parentText ? parentText.split(" ") : [];
    if (extra !== undefined || !requested.has(hash) || !OID.test(tree || "") || parents.some(parent => !OID.test(parent))) {
      throw new Error("Git returned incomplete commit metadata while preparing the PR operation.");
    }
    result.set(hash, { parents, tree });
  }
  if (result.size !== requested.size) throw new Error("Some PR commits are missing from Git commit metadata.");
  return result;
}
