// rebase 시작 실패 뒤 새 편집을 덮지 않고 원래 stash만 복원하는 공통 복구 경계다.
import { detectOperation } from "./conflictService";
import { runGit } from "./gitExec";
import { assertCurrentBranchHead } from "./refSafety";
import { restorePreservedLocalChangesStash } from "./stashExec";
import { logInfo } from "../ui/outputLog";

/** 실패한 작업을 식별하고 자동 복구 가능 여부를 판단하는 입력값이다. */
export interface RebaseFailureRecoveryInput {
  repoRoot: string;
  branch: string;
  beforeHead: string;
  snapshotRef: string;
  preservedStashHash?: string;
}

/** 복구 실패가 원래 Git 오류를 가리지 않도록 복구 결과와 추가 안내를 함께 반환한다. */
export interface RebaseFailureRecoveryResult {
  restored: boolean;
  notice: string;
}

/**
 * Git 작업이 시작되지 않았고 브랜치·HEAD·index·작업트리가 그대로일 때만 원래 stash를 복원한다.
 * 자동 switch/reset은 실행하지 않는다. 새 편집이나 다른 작업이 있으면 snapshot/stash를 보존한다.
 * @param input 실패한 작업의 시작 상태와 선택적 보존 stash
 * @returns 안전하게 원래 상태로 복원했는지 여부와 원래 오류 뒤에 붙일 복구 안내
 */
export async function recoverFailedRebaseStart(input: RebaseFailureRecoveryInput): Promise<RebaseFailureRecoveryResult> {
  const { repoRoot, branch, beforeHead, snapshotRef, preservedStashHash } = input;
  try {
    if (await detectOperation(repoRoot) !== "none") throw new Error("Another Git operation is still in progress.");
    await assertCurrentBranchHead(repoRoot, branch, beforeHead, "restoring a failed operation");
    const changes = await runGit(["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z"], repoRoot);
    if (changes.length) throw new Error("The index or working tree contains changes made after the operation started.");
    if (preservedStashHash) {
      await restorePreservedLocalChangesStash(repoRoot, preservedStashHash,
        "The operation failed and preserved local changes could not be restored.", true);
    }
    await assertCurrentBranchHead(repoRoot, branch, beforeHead, "finishing failed operation recovery");
    logInfo("failed rebase start recovered", { repoRoot, branch, snapshotRef });
    return { restored: true, notice: "" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logInfo("failed rebase recovery stopped; changes and snapshot preserved", { ...input, reason });
    return {
      restored: false,
      notice: `\nAutomatic recovery was stopped: ${reason}\nThe recovery snapshot was kept at ${snapshotRef}.`,
    };
  }
}
