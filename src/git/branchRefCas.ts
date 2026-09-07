// checkout 중인 브랜치를 보호하면서 기대 OID가 같은 로컬 ref만 원자적으로 갱신한다.
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { runGit } from "./gitExec";
import { WorktreeService } from "./worktreeService";

/**
 * 다른 worktree와 진행 중 rebase/bisect의 브랜치를 보호한 뒤 old OID 조건으로 ref를 갱신한다.
 * @param branch refs/heads 접두어가 없는 로컬 브랜치 이름
 * @param expected 확인한 작업 결과 OID. 최종 Git ref lock 안에서 다시 비교한다.
 * @param restored 복원할 commit OID
 */
export async function restoreUnoccupiedBranch(root: string, branch: string, expected: string, restored: string): Promise<void> {
  for (const worktree of await new WorktreeService(root).listWorktrees()) {
    if (worktree.bare) continue;
    if (worktree.branch === branch) throw new Error(`Cannot restore '${branch}': it is checked out at '${worktree.path}'.`);
    const gitDir = (await runGit(["rev-parse", "--absolute-git-dir"], worktree.path)).trim();
    for (const marker of ["rebase-merge/head-name", "rebase-apply/head-name", "BISECT_START"]) {
      const owner = await readFile(path.join(gitDir, marker), "utf8").catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      });
      if (owner.trim().replace(/^refs\/heads\//, "") === branch) {
        throw new Error(`Cannot restore '${branch}': another worktree is using it.`);
      }
    }
  }
  await runGit(["update-ref", "--no-deref", "-m", "Git Simple Compare: undo PR operation", `refs/heads/${branch}`, restored, expected], root, { retryOnLock: false });
}
