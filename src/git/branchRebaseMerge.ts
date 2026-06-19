// 브랜치 Rebase Merge 를 실제 `git rebase <target>` 로 수행하고 충돌 후속 처리를 이어받는 모듈.
// - 선택한 브랜치는 rebase 대상(upstream)으로만 사용하며, remote ref 를 로컬 브랜치로 만들지 않는다.
// - Git 이 만든 rebase 상태를 그대로 유지해 Continue/Abort 와 그래프 TODO 카드가 같은 흐름을 본다.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { detectOperation } from "./conflictService";
import { runGit } from "./gitExec";
import { assertCurrentBranchHead, assertTargetDescendsFrom } from "./refSafety";
import {
  dropPreservedLocalChangesStash,
  restorePreservedLocalChangesStash,
} from "./stashExec";
import {
  readRebaseTodoProgress,
  type RebaseTodoProgress,
} from "./rebaseTodoProgress";

const STATE_GIT_PATH = "gitsimplecompare/branch-rebase-merge-state.json";

export interface BranchRebaseMergeInput {
  repoRoot: string;
  branch: string;
  targetRef: string;
  beforeHead: string;
  targetHead: string;
  snapshotRef: string;
  preservedStashHash?: string;
}

export interface BranchRebaseMergeResult {
  status: "completed" | "conflicts";
  branch: string;
  sourceBranch: string;
  beforeHead: string;
  afterHead: string;
  snapshotRef: string;
  preservedStashHash?: string;
  rebaseTodo?: RebaseTodoProgress;
}

export type BranchRebaseMergeResumeResult =
  | { status: "none" }
  | { status: "pending"; rebaseTodo?: RebaseTodoProgress }
  | { status: "completed"; branch: string; afterHead: string; restoredLocalChanges: boolean }
  | { status: "restoreConflicts"; branch: string; preservedStashHash?: string };

export type BranchRebaseMergeCleanupResult =
  | { status: "none" }
  | { status: "restored"; branch: string }
  | { status: "dropped"; branch: string };

interface PendingBranchRebaseMerge {
  kind: "branch-rebase";
  branch: string;
  targetRef: string;
  beforeHead: string;
  targetHead: string;
  snapshotRef: string;
  preservedStashHash?: string;
  createdAt: number;
}

/**
 * 현재 브랜치를 선택한 target ref 위로 실제 git rebase 로 올린다.
 * - local/remote target 모두 ref 를 직접 전달하지 않고 시작 시점 commit hash 로 고정해 사용한다.
 * - 충돌이 나면 Git 의 rebase 상태를 그대로 남기고 pending 상태를 기록해 Continue/Abort 가 이어받게 한다.
 * @param input rebase 시작 정보
 * @returns 완료 또는 충돌 대기 상태
 */
export async function runBranchRebaseMerge(
  input: BranchRebaseMergeInput
): Promise<BranchRebaseMergeResult> {
  await clearPendingBranchRebaseMerge(input.repoRoot).catch(() => undefined);
  await assertCurrentBranchHead(
    input.repoRoot,
    input.branch,
    input.beforeHead,
    "starting branch rebase merge"
  );
  const pending = pendingState(input);
  try {
    await writePendingBranchRebaseMerge(input.repoRoot, pending);
    await runGit(["rebase", input.targetHead], input.repoRoot, { env: rebaseEnv() });
    const rebasedHead = await currentHead(input.repoRoot);
    const result = await completePendingBranchRebaseMerge(input.repoRoot, pending, rebasedHead);
    return resumeToRunResult(input, result, rebasedHead);
  } catch (err) {
    if (await isRebaseConflictState(input.repoRoot)) {
      return {
        status: "conflicts",
        branch: input.branch,
        sourceBranch: input.targetRef,
        beforeHead: input.beforeHead,
        afterHead: await safeCurrentHead(input.repoRoot, input.beforeHead),
        snapshotRef: input.snapshotRef,
        preservedStashHash: input.preservedStashHash,
        rebaseTodo: await readRebaseTodoProgress(input.repoRoot).catch(() => undefined),
      };
    }
    await cleanupFailedStart(input.repoRoot, pending);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * 충돌 해결 후 `git rebase --continue` 가 끝난 branch rebase merge 를 마무리한다.
 * @param repoRoot git 저장소 루트
 * @returns 후속 처리 결과
 */
export async function finishPendingBranchRebaseMergeAfterContinue(
  repoRoot: string
): Promise<BranchRebaseMergeResumeResult> {
  const pending = await readPendingBranchRebaseMerge(repoRoot);
  if (!pending) {
    return { status: "none" };
  }
  if (await isRebaseConflictState(repoRoot)) {
    return {
      status: "pending",
      rebaseTodo: await readRebaseTodoProgress(repoRoot).catch(() => undefined),
    };
  }
  const rebasedHead = await currentHead(repoRoot);
  return completePendingBranchRebaseMerge(repoRoot, pending, rebasedHead);
}

/**
 * branch rebase merge abort 뒤 현재 브랜치와 보존 stash 를 복원한다.
 * - `git rebase --abort` 는 호출자가 먼저 실행하므로 여기서는 pending metadata 와 stash 만 정리한다.
 * @param repoRoot git 저장소 루트
 * @returns 복원 결과
 */
export async function restorePendingBranchRebaseMergeAfterAbort(
  repoRoot: string
): Promise<BranchRebaseMergeCleanupResult> {
  const pending = await readPendingBranchRebaseMerge(repoRoot);
  if (!pending || await isRebaseConflictState(repoRoot)) {
    return { status: "none" };
  }
  await switchToBranch(repoRoot, pending.branch);
  await restorePendingLocalChanges(
    repoRoot,
    pending,
    "Branch rebase merge was aborted, but local changes could not be restored."
  );
  await runGit(["update-ref", "-d", pending.snapshotRef], repoRoot).catch(() => "");
  await clearPendingBranchRebaseMerge(repoRoot);
  return { status: "restored", branch: pending.branch };
}

/**
 * stash 복원 충돌을 사용자가 해결한 뒤 보존 stash 와 pending 상태를 정리한다.
 * @param repoRoot git 저장소 루트
 * @returns 정리 결과
 */
export async function dropPendingBranchRebaseMergeStashAfterResolvedRestore(
  repoRoot: string
): Promise<BranchRebaseMergeCleanupResult> {
  const pending = await readPendingBranchRebaseMerge(repoRoot);
  if (!pending || await isRebaseConflictState(repoRoot)) {
    return { status: "none" };
  }
  if (pending.preservedStashHash) {
    await dropPreservedLocalChangesStash(repoRoot, pending.preservedStashHash);
    await clearPendingBranchRebaseMerge(repoRoot);
    return { status: "dropped", branch: pending.branch };
  }
  await clearPendingBranchRebaseMerge(repoRoot);
  return { status: "none" };
}

/**
 * undo 흐름에서 pending rebase merge 의 보존 stash 를 복원한다.
 * @param repoRoot git 저장소 루트
 * @param branch 복원 대상 브랜치
 * @param failureMessage stash 복원 실패 시 보여줄 메시지
 */
export async function restorePendingBranchRebaseMergeLocalChangesForBranch(
  repoRoot: string,
  branch: string,
  failureMessage: string
): Promise<void> {
  const pending = await readPendingBranchRebaseMerge(repoRoot);
  if (!pending || pending.branch !== branch) {
    return;
  }
  await restorePendingLocalChanges(repoRoot, pending, failureMessage);
  await clearPendingBranchRebaseMerge(repoRoot);
}

/**
 * rebase 완료 후 보존 stash 를 복원하고 pending 상태를 정리한다.
 * @param repoRoot git 저장소 루트
 * @param pending 저장된 rebase merge 상태
 * @param rebasedHead rebase 가 끝난 현재 브랜치 HEAD
 */
async function completePendingBranchRebaseMerge(
  repoRoot: string,
  pending: PendingBranchRebaseMerge,
  rebasedHead: string
): Promise<BranchRebaseMergeResumeResult> {
  await assertCurrentBranchHead(
    repoRoot,
    pending.branch,
    rebasedHead,
    "completing branch rebase merge"
  );
  await assertTargetDescendsFrom(
    repoRoot,
    pending.targetHead,
    rebasedHead,
    "completing branch rebase merge"
  );
  try {
    await restorePendingLocalChanges(
      repoRoot,
      pending,
      "Branch rebase merge completed, but local changes could not be restored."
    );
  } catch (err) {
    if (await hasUnmergedChanges(repoRoot)) {
      return {
        status: "restoreConflicts",
        branch: pending.branch,
        preservedStashHash: pending.preservedStashHash,
      };
    }
    throw err;
  }
  await clearPendingBranchRebaseMerge(repoRoot);
  return {
    status: "completed",
    branch: pending.branch,
    afterHead: rebasedHead,
    restoredLocalChanges: Boolean(pending.preservedStashHash),
  };
}

/** 시작 결과 형태로 후속 처리 결과를 변환한다. */
function resumeToRunResult(
  input: BranchRebaseMergeInput,
  result: BranchRebaseMergeResumeResult,
  fallbackHead: string
): BranchRebaseMergeResult {
  return {
    status: result.status === "completed" ? "completed" : "conflicts",
    branch: input.branch,
    sourceBranch: input.targetRef,
    beforeHead: input.beforeHead,
    afterHead: result.status === "completed" ? result.afterHead : fallbackHead,
    snapshotRef: input.snapshotRef,
    preservedStashHash: input.preservedStashHash,
  };
}

/** 시작 입력값에서 pending 상태를 만든다. */
function pendingState(input: BranchRebaseMergeInput): PendingBranchRebaseMerge {
  return {
    kind: "branch-rebase",
    branch: input.branch,
    targetRef: input.targetRef,
    beforeHead: input.beforeHead,
    targetHead: input.targetHead,
    snapshotRef: input.snapshotRef,
    preservedStashHash: input.preservedStashHash,
    createdAt: Date.now(),
  };
}

/** pending 상태 파일을 읽는다. */
async function readPendingBranchRebaseMerge(
  repoRoot: string
): Promise<PendingBranchRebaseMerge | undefined> {
  const file = await stateFilePath(repoRoot);
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }
  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** pending 상태 파일을 기록한다. */
async function writePendingBranchRebaseMerge(
  repoRoot: string,
  state: PendingBranchRebaseMerge
): Promise<void> {
  const file = await stateFilePath(repoRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** pending 상태 파일을 삭제한다. */
async function clearPendingBranchRebaseMerge(repoRoot: string): Promise<void> {
  const file = await stateFilePath(repoRoot);
  await fs.rm(file, { force: true });
}

/** linked worktree 에서도 올바른 git-dir 내부 상태 파일 경로를 계산한다. */
async function stateFilePath(repoRoot: string): Promise<string> {
  const raw = (await runGit(["rev-parse", "--git-path", STATE_GIT_PATH], repoRoot)).trim();
  return path.resolve(repoRoot, raw);
}

/** JSON 값을 현재 코드가 이해하는 pending 상태로 검증한다. */
function normalizeState(value: unknown): PendingBranchRebaseMerge | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const item = value as Record<string, unknown>;
  if (
    item.kind !== "branch-rebase" ||
    typeof item.branch !== "string" ||
    typeof item.targetRef !== "string" ||
    typeof item.beforeHead !== "string" ||
    typeof item.targetHead !== "string" ||
    typeof item.snapshotRef !== "string"
  ) {
    return undefined;
  }
  return {
    kind: "branch-rebase",
    branch: item.branch,
    targetRef: item.targetRef,
    beforeHead: item.beforeHead,
    targetHead: item.targetHead,
    snapshotRef: item.snapshotRef,
    preservedStashHash: typeof item.preservedStashHash === "string" ? item.preservedStashHash : undefined,
    createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
  };
}

/** rebase/cherry-pick style 충돌 또는 unmerged 파일이 남아 있는지 확인한다. */
async function isRebaseConflictState(repoRoot: string): Promise<boolean> {
  const [operation, unmerged] = await Promise.all([
    detectOperation(repoRoot),
    hasUnmergedChanges(repoRoot),
  ]);
  return operation !== "none" || unmerged;
}

/** index 에 unmerged entry 가 남아 있는지 확인한다. */
async function hasUnmergedChanges(repoRoot: string): Promise<boolean> {
  return (await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], repoRoot).catch(() => "")).length > 0;
}

/** 예상치 못한 시작 실패 뒤 원래 브랜치로 돌아가고 pending 상태를 정리한다. */
async function cleanupFailedStart(
  repoRoot: string,
  pending: PendingBranchRebaseMerge
): Promise<void> {
  await switchToBranch(repoRoot, pending.branch).catch(() => undefined);
  await clearPendingBranchRebaseMerge(repoRoot).catch(() => undefined);
}

/** 보존 stash 를 복원한다. */
async function restorePendingLocalChanges(
  repoRoot: string,
  pending: PendingBranchRebaseMerge,
  failureMessage: string
): Promise<void> {
  if (!pending.preservedStashHash) {
    return;
  }
  await restorePreservedLocalChangesStash(repoRoot, pending.preservedStashHash, failureMessage);
}

/** 현재 브랜치 이름을 반환한다. detached HEAD 면 빈 문자열이다. */
async function currentBranch(repoRoot: string): Promise<string> {
  return (await runGit(["symbolic-ref", "--short", "HEAD"], repoRoot).catch(() => "")).trim();
}

/** 지정 브랜치로 전환한다. */
async function switchToBranch(repoRoot: string, branch: string): Promise<void> {
  if (await currentBranch(repoRoot) === branch) {
    return;
  }
  await runGit(["switch", branch], repoRoot);
}

/** 현재 HEAD commit hash 를 반환한다. */
async function currentHead(repoRoot: string): Promise<string> {
  return (await runGit(["rev-parse", "--verify", "HEAD"], repoRoot)).trim();
}

/** HEAD 를 읽을 수 없을 때는 fallback 을 반환한다. */
async function safeCurrentHead(repoRoot: string, fallback: string): Promise<string> {
  return await currentHead(repoRoot).catch(() => fallback);
}

/** git rebase 중 hook/editor 로 막히지 않도록 쓰는 환경 변수다. */
function rebaseEnv(): Record<string, string> {
  return { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", HUSKY: "0" };
}
