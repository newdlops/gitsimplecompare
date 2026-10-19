// PR commit 집합의 parent 경계를 검증해 선형·merge 이력을 같은 최종 변경 범위로 표현한다.
import { readCommitMetadata, type CommitMetadata } from "./commitMetadata";
import { runGit } from "./gitExec";
import { logInfo } from "../ui/outputLog";

/** 전체 원본 목록과 검증된 최종 변경의 시작 commit·끝 commit·끝 tree다. */
export interface PullRequestSquashPlan {
  commits: string[];
  base?: string;
  head?: string;
  tree?: string;
  /** 단일 merge commit도 mainline 추측 없이 검증된 base와 tree로 재생해야 한다. */
  aggregate?: true;
}

/** 요청 목록을 모두 포함하는 유일한 tip과 목록 밖 parent 경계를 담는다. */
interface CommitBoundary { head: string; parents: string[] }

/**
 * PR의 정확한 commit 집합만 나타내는 base/head를 준비한다.
 * 외부 parent가 하나면 메모리 내 DAG 검사만 사용하고, base 갱신 merge가 있으면
 * 독립된 외부 tip 하나와 실제 rev-list 집합까지 검증해 목록 밖 변경의 유입을 막는다.
 * @param repoRoot 원본 object가 준비된 저장소 @param commits 정규화한 전체 PR commit OID
 * @returns 범위를 입증할 수 없으면 원본 재생 목록만 반환한다. Git 읽기 오류는 전파한다.
 */
export async function preparePullRequestSquashRange(
  repoRoot: string, commits: string[]
): Promise<PullRequestSquashPlan> {
  if (!commits.length) return { commits };
  const nodes = await readCommitMetadata(repoRoot, commits);
  const boundary = findBoundary(nodes);
  if (!boundary) return fallback(repoRoot, commits, "disconnected-or-root-history");
  let [base] = boundary.parents;
  if (boundary.parents.length > 1) {
    // 비정상적으로 큰 octopus의 명령 인자와 이력 탐색을 피하고 기존 재생으로 돌아간다.
    if (boundary.parents.length > 128) return fallback(repoRoot, commits, "too-many-boundary-parents");
    const independent = (await runGit(["merge-base", "--independent", ...boundary.parents], repoRoot)).trim().split(/\s+/);
    if (independent.length !== 1 || !boundary.parents.includes(independent[0])) {
      return fallback(repoRoot, commits, "ambiguous-base-history");
    }
    [base] = independent;
    // 상한은 목록 크기 + 1. 작은 PR 때문에 저장소 전체 이력을 출력하지 않는다.
    const actual = (await runGit([
      "rev-list", `--max-count=${nodes.size + 1}`, `${base}..${boundary.head}`, "--",
    ], repoRoot)).trim().split(/\s+/).filter(Boolean);
    if (actual.length !== nodes.size || new Set(actual).size !== nodes.size || actual.some(hash => !nodes.has(hash))) {
      return fallback(repoRoot, commits, "unlisted-or-excluded-commits");
    }
  }
  logInfo("PR squash range verified", {
    repoRoot, commits: nodes.size, boundaryParents: boundary.parents.length,
    mergeCommits: [...nodes.values()].filter(node => node.parents.length > 1).length,
  });
  return {
    commits, base, head: boundary.head, tree: nodes.get(boundary.head)!.tree,
    ...(nodes.size === 1 && nodes.get(boundary.head)!.parents.length > 1 ? { aggregate: true as const } : {}),
  };
}

/**
 * 목록 내 parent 간선을 따라 모든 요청 commit이 하나의 tip 아래 연결됐는지 확인한다.
 * @param nodes 원본 전체 parent/tree metadata @returns root·분리된 목록·누락된 tip이면 undefined
 */
function findBoundary(nodes: Map<string, CommitMetadata>): CommitBoundary | undefined {
  const tips = new Set(nodes.keys());
  for (const node of nodes.values()) {
    if (!node.parents.length) return undefined;
    for (const parent of node.parents) tips.delete(parent);
  }
  if (tips.size !== 1) return undefined;
  const head = [...tips][0];
  const pending = [head];
  const visited = new Set<string>();
  const parents = new Set<string>();
  while (pending.length) {
    const hash = pending.pop()!;
    if (visited.has(hash)) continue;
    visited.add(hash);
    for (const parent of nodes.get(hash)!.parents) {
      if (nodes.has(parent)) pending.push(parent);
      else parents.add(parent);
    }
  }
  return visited.size === nodes.size && parents.size ? { head, parents: [...parents] } : undefined;
}

/** 범위 추정에 실패한 원인을 Output에 남기고 원래 commit 목록을 그대로 돌려준다. */
function fallback(repoRoot: string, commits: string[], reason: string): PullRequestSquashPlan {
  logInfo("PR squash range fallback", { repoRoot, commits: commits.length, reason });
  return { commits };
}
