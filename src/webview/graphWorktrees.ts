// graph 웹뷰에 전달할 worktree 점유 상태를 만드는 모듈.
// - git worktree 조회는 WorktreeService 에 위임하고, graphPanel 에는 브랜치별 표시 데이터만 넘긴다.
import * as path from "node:path";
import type { WorktreeBranchStatus } from "../graph/graphTypes";
import { WorktreeInfo, WorktreeService } from "../git/worktreeService";

/**
 * 저장소의 worktree 목록에서 로컬 브랜치를 checkout 중인 항목만 그래프 표시용으로 추린다.
 * - detached worktree 는 특정 브랜치를 점유하지 않으므로 그래프 branch badge 에 표시하지 않는다.
 * @param repoRoot git worktree 명령을 실행할 저장소 루트
 * @returns 브랜치 이름별 worktree 점유 상태 목록
 */
export async function readGraphWorktreeBranchStatus(
  repoRoot: string
): Promise<WorktreeBranchStatus[]> {
  const worktrees = await new WorktreeService(repoRoot).listWorktrees();
  return worktrees
    .filter(hasBranch)
    .map((worktree) => ({
      branch: worktree.branch,
      path: worktree.path,
      name: displayName(worktree.path),
      isMain: worktree.isMain,
      locked: worktree.locked,
      prunable: worktree.prunable,
    }))
    .sort((a, b) => a.branch.localeCompare(b.branch) || a.path.localeCompare(b.path));
}

/**
 * worktree 가 로컬 브랜치를 checkout 중인지 확인한다.
 * @param worktree git worktree 상태
 */
function hasBranch(
  worktree: WorktreeInfo
): worktree is WorktreeInfo & { branch: string } {
  return Boolean(worktree.branch);
}

/**
 * 배지에 표시할 짧은 이름을 만든다.
 * @param worktreePath worktree 루트 경로
 */
function displayName(worktreePath: string): string {
  return path.basename(worktreePath) || worktreePath;
}
