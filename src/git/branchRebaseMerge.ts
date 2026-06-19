// 브랜치 Rebase Merge 를 실제 git rebase 로 수행하고 충돌 후속 처리를 이어받는 모듈.
// - source 브랜치를 직접 움직이지 않도록 임시 브랜치에서 rebase 한 뒤, 성공하면 destination 을 fast-forward 한다.
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
  sourceBranch: string;
  destinationBranch: string;
  beforeHead: string;
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
  destinationBranch: string;
  sourceBranch: string;
  temporaryBranch: string;
  beforeHead: string;
  snapshotRef: string;
  preservedStashHash?: string;
  createdAt: number;
}

/**
 * source 브랜치를 임시 브랜치에서 실제 git rebase 로 destination 위에 올린다.
 * - rebase 가 끝나면 destination 브랜치를 rebase 결과로 fast-forward 한다.
 * - 충돌이 나면 Git 의 rebase 상태를 그대로 남기고 pending 상태를 기록해 Continue/Abort 가 이어받게 한다.
 * @param input rebase merge 시작 정보
 * @returns 완료 또는 충돌 대기 상태
 */
export async function runBranchRebaseMerge(
  input: BranchRebaseMergeInput
): Promise<BranchRebaseMergeResult> {
  await clearPendingBranchRebaseMerge(input.repoRoot).catch(() => undefined);
  const base = await mergeBase(input.repoRoot, input.beforeHead, input.sourceBranch);
  const temporaryBranch = temporaryBranchName(input.destinationBranch, input.sourceBranch);
  await runGit(["switch", "-c", temporaryBranch, input.sourceBranch], input.repoRoot);
  const pending = pendingState(input, temporaryBranch);
  try {
    await writePendingBranchRebaseMerge(input.repoRoot, pending);
    await runGit(
      ["rebase", "--onto", input.beforeHead, base],
      input.repoRoot,
      { env: rebaseEnv() }
    );
    const rebasedHead = await currentHead(input.repoRoot);
    const result = await completePendingBranchRebaseMerge(input.repoRoot, pending, rebasedHead);
    return resumeToRunResult(input, result, rebasedHead);
  } catch (err) {
    if (await isRebaseConflictState(input.repoRoot)) {
      return {
        status: "conflicts",
        branch: input.destinationBranch,
        sourceBranch: input.sourceBranch,
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
 * 충돌 해결 후 `git rebase --continue` 가 끝난 브랜치 rebase merge 를 destination 에 반영한다.
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
 * 브랜치 rebase merge abort 뒤 destination 브랜치와 보존 stash 를 복원한다.
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
  await switchToBranch(repoRoot, pending.destinationBranch);
  await restorePendingLocalChanges(
    repoRoot,
    pending,
    "Branch rebase merge was aborted, but local changes could not be restored."
  );
  await runGit(["update-ref", "-d", pending.snapshotRef], repoRoot).catch(() => "");
  await deleteTemporaryBranch(repoRoot, pending.temporaryBranch);
  await clearPendingBranchRebaseMerge(repoRoot);
  return { status: "restored", branch: pending.destinationBranch };
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
  await deleteTemporaryBranch(repoRoot, pending.temporaryBranch).catch(() => undefined);
  if (pending.preservedStashHash) {
    await dropPreservedLocalChangesStash(repoRoot, pending.preservedStashHash);
    await clearPendingBranchRebaseMerge(repoRoot);
    return { status: "dropped", branch: pending.destinationBranch };
  }
  await clearPendingBranchRebaseMerge(repoRoot);
  return { status: "none" };
}

/**
 * undo 흐름에서 destination 브랜치에 묶인 보존 stash 를 복원한다.
 * @param repoRoot git 저장소 루트
 * @param branch 복원 대상 destination 브랜치
 * @param failureMessage stash 복원 실패 시 보여줄 메시지
 */
export async function restorePendingBranchRebaseMergeLocalChangesForBranch(
  repoRoot: string,
  branch: string,
  failureMessage: string
): Promise<void> {
  const pending = await readPendingBranchRebaseMerge(repoRoot);
  if (!pending || pending.destinationBranch !== branch) {
    return;
  }
  await restorePendingLocalChanges(repoRoot, pending, failureMessage);
  await deleteTemporaryBranch(repoRoot, pending.temporaryBranch).catch(() => undefined);
  await clearPendingBranchRebaseMerge(repoRoot);
}

/**
 * destination 브랜치를 rebase 결과로 fast-forward 하고 보존 stash 를 복원한다.
 * @param repoRoot git 저장소 루트
 * @param pending 저장된 rebase merge 상태
 * @param rebasedHead rebase 가 끝난 임시 브랜치 HEAD
 */
async function completePendingBranchRebaseMerge(
  repoRoot: string,
  pending: PendingBranchRebaseMerge,
  rebasedHead: string
): Promise<BranchRebaseMergeResumeResult> {
  await switchToBranch(repoRoot, pending.destinationBranch);
  await assertCurrentBranchHead(
    repoRoot,
    pending.destinationBranch,
    pending.beforeHead,
    "completing branch rebase merge"
  );
  await assertTargetDescendsFrom(
    repoRoot,
    pending.beforeHead,
    rebasedHead,
    "completing branch rebase merge"
  );
  await runGit(["merge", "--ff-only", rebasedHead], repoRoot, { env: { GIT_EDITOR: "true" } });
  await deleteTemporaryBranch(repoRoot, pending.temporaryBranch).catch(() => undefined);
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
        branch: pending.destinationBranch,
        preservedStashHash: pending.preservedStashHash,
      };
    }
    throw err;
  }
  await clearPendingBranchRebaseMerge(repoRoot);
  return {
    status: "completed",
    branch: pending.destinationBranch,
    afterHead: await currentHead(repoRoot),
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
    branch: input.destinationBranch,
    sourceBranch: input.sourceBranch,
    beforeHead: input.beforeHead,
    afterHead: result.status === "completed" ? result.afterHead : fallbackHead,
    snapshotRef: input.snapshotRef,
    preservedStashHash: input.preservedStashHash,
  };
}

/** 시작 입력값에서 pending 상태를 만든다. */
function pendingState(
  input: BranchRebaseMergeInput,
  temporaryBranch: string
): PendingBranchRebaseMerge {
  return {
    kind: "branch-rebase",
    destinationBranch: input.destinationBranch,
    sourceBranch: input.sourceBranch,
    temporaryBranch,
    beforeHead: input.beforeHead,
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
    typeof item.destinationBranch !== "string" ||
    typeof item.sourceBranch !== "string" ||
    typeof item.temporaryBranch !== "string" ||
    typeof item.beforeHead !== "string" ||
    typeof item.snapshotRef !== "string"
  ) {
    return undefined;
  }
  return {
    kind: "branch-rebase",
    destinationBranch: item.destinationBranch,
    sourceBranch: item.sourceBranch,
    temporaryBranch: item.temporaryBranch,
    beforeHead: item.beforeHead,
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

/** 예상치 못한 시작 실패 뒤 destination 으로 돌아가고 임시 상태를 정리한다. */
async function cleanupFailedStart(
  repoRoot: string,
  pending: PendingBranchRebaseMerge
): Promise<void> {
  await switchToBranch(repoRoot, pending.destinationBranch).catch(() => undefined);
  await deleteTemporaryBranch(repoRoot, pending.temporaryBranch).catch(() => undefined);
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

/** merge-base 를 계산한다. */
async function mergeBase(repoRoot: string, a: string, b: string): Promise<string> {
  return (await runGit(["merge-base", a, b], repoRoot)).trim();
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

/** 임시 브랜치를 삭제한다. 이미 없으면 무시한다. */
async function deleteTemporaryBranch(repoRoot: string, branch: string): Promise<void> {
  if (await currentBranch(repoRoot) === branch) {
    return;
  }
  await runGit(["branch", "-D", branch], repoRoot).catch(() => undefined);
}

/** git rebase/cherry-pick 중 hook/editor 로 막히지 않도록 쓰는 환경 변수다. */
function rebaseEnv(): Record<string, string> {
  return { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", HUSKY: "0" };
}

/** 임시 브랜치 이름을 만든다. */
function temporaryBranchName(destination: string, source: string): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `gsc/rebase-merge/${refSlug(destination)}/${refSlug(source)}-${suffix}`;
}

/** 브랜치 이름 조각에 안전한 문자만 남긴다. */
function refSlug(value: string): string {
  const slug = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "branch";
}
