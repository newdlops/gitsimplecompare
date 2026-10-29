// Git Simple Compare 작업 중 보존되는 임시 worktree 를 만들고 정리한다.
// - temp worktree 는 충돌/반영 실패 시 사용자가 확인할 수 있도록 남겨둘 수 있다.
// - 정리는 git worktree 메타데이터를 먼저 제거한 뒤 디렉터리를 제거한다.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGit } from "./gitExec";
import { logInfo } from "../ui/outputLog";

const PR_OPERATION_WORKTREE_PREFIX = "gsc-pr-operation-";

export interface TemporaryWorktreeInfo {
  path: string;
  locked?: boolean;
}

export interface TemporaryWorktreeCleanupResult {
  removed: string[];
  failed: { path: string; message: string }[];
}

/**
 * PR 작업 전용 detached worktree를 만든다.
 * @param repoRoot 공통 object 저장소와 worktree 등록을 소유한 저장소
 * @param startPoint 격리 작업을 시작할 고정 commit
 * @param checkout false면 최종 tree를 index에 바로 기록할 수 있도록 파일 checkout을 생략한다.
 * @returns 작업 후 제거하거나 충돌 복구용으로 보존할 임시 디렉터리
 */
export async function createPrOperationWorktree(
  repoRoot: string,
  startPoint: string,
  checkout = true
): Promise<string> {
  return createOperationWorktree(repoRoot, startPoint, checkout, PR_OPERATION_WORKTREE_PREFIX);
}

/**
 * 브랜치 squash 전용 등록을 만들어 PR worktree 정리 명령과 소유 범위를 분리한다.
 * @param repoRoot 원래 저장소 @param startPoint 고정 시작 OID @param checkout 전체 파일 생성 여부
 * @returns 성공 시 정리하거나 충돌 복구를 위해 보존할 detached worktree 경로
 */
export function createBranchOperationWorktree(repoRoot: string, startPoint: string, checkout = true): Promise<string> {
  return createOperationWorktree(repoRoot, startPoint, checkout, "gsc-branch-operation-");
}

/** 작업 종류별 접두어만 달리하고 Native worktree 생성·계측은 같은 경계에서 수행한다. */
async function createOperationWorktree(repoRoot: string, startPoint: string, checkout: boolean, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.rm(dir, { recursive: true, force: true });
  const started = Date.now();
  await runGit(["worktree", "add", "--detach", ...(checkout ? [] : ["--no-checkout"]), dir, startPoint], repoRoot);
  logInfo("temporary worktree created", { repoRoot, worktreePath: dir, checkout, elapsedMs: Date.now() - started });
  return dir;
}

/** 임시 worktree 를 제거한다. git 메타데이터 제거를 먼저 시도한다. */
export async function removeTemporaryWorktree(
  repoRoot: string,
  worktreePath: string
): Promise<void> {
  // Git의 lock·사용 중·권한 오류를 파일시스템 강제 삭제로 우회하지 않는다.
  const started = Date.now();
  await runGit(["worktree", "remove", "--force", worktreePath], repoRoot);
  logInfo("temporary worktree removed", { repoRoot, worktreePath, elapsedMs: Date.now() - started });
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
      items.push({ path: worktreePath, ...(/^locked(?: |$)/m.test(entry) ? { locked: true } : {}) });
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
    if (item.locked) {
      result.failed.push({ path: item.path, message: "This worktree is locked for recovery. Resume its PR operation before cleaning it up." });
      continue;
    }
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
