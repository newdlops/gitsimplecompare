// Git Simple Compare 작업 중 보존되는 임시 worktree 를 만들고 정리한다.
// - temp worktree 는 충돌/반영 실패 시 사용자가 확인할 수 있도록 남겨둘 수 있다.
// - 정리는 git worktree 메타데이터를 먼저 제거한 뒤 디렉터리를 제거한다.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGit } from "./gitExec";

const PR_OPERATION_WORKTREE_PREFIX = "gsc-pr-operation-";

export interface TemporaryWorktreeInfo {
  path: string;
}

export interface TemporaryWorktreeCleanupResult {
  removed: string[];
  failed: { path: string; message: string }[];
}

/** PR operation 용 임시 worktree 를 만든다. */
export async function createPrOperationWorktree(
  repoRoot: string,
  startPoint: string
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), PR_OPERATION_WORKTREE_PREFIX));
  await fs.rm(dir, { recursive: true, force: true });
  await runGit(["worktree", "add", "--detach", dir, startPoint], repoRoot);
  return dir;
}

/** 임시 worktree 를 제거한다. git 메타데이터 제거를 먼저 시도한다. */
export async function removeTemporaryWorktree(
  repoRoot: string,
  worktreePath: string
): Promise<void> {
  await runGit(["worktree", "remove", "--force", worktreePath], repoRoot)
    .catch(async () => {
      await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    });
}

/** 현재 저장소에 등록된 PR operation 임시 worktree 목록을 반환한다. */
export async function listPrOperationWorktrees(
  repoRoot: string
): Promise<TemporaryWorktreeInfo[]> {
  const out = await runGit(["worktree", "list", "--porcelain"], repoRoot).catch(() => "");
  const items: TemporaryWorktreeInfo[] = [];
  for (const entry of out.split(/\n(?=worktree )/)) {
    const match = /^worktree (.+)$/m.exec(entry);
    const worktreePath = match?.[1]?.trim();
    if (worktreePath && path.basename(worktreePath).startsWith(PR_OPERATION_WORKTREE_PREFIX)) {
      items.push({ path: worktreePath });
    }
  }
  return items;
}

/** 현재 저장소에 등록된 PR operation 임시 worktree 를 모두 제거한다. */
export async function cleanupPrOperationWorktrees(
  repoRoot: string
): Promise<TemporaryWorktreeCleanupResult> {
  const worktrees = await listPrOperationWorktrees(repoRoot);
  const result: TemporaryWorktreeCleanupResult = { removed: [], failed: [] };
  for (const item of worktrees) {
    try {
      await removeTemporaryWorktree(repoRoot, item.path);
      result.removed.push(item.path);
    } catch (err) {
      result.failed.push({
        path: item.path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
