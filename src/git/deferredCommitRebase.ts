// 커밋 목록을 현재 브랜치 위에 재적용하되, 충돌 커밋은 마지막으로 미루는 rebase merge 실행기.
// - git rebase 는 첫 충돌에서 멈추므로, cherry-pick 큐로 충돌 없는 커밋을 먼저 쌓고
//   충돌나는 커밋만 마지막 단계에서 Conflicts 뷰에 노출한다.
import { detectOperation } from "./conflictService";
import { GitError, runGit } from "./gitExec";
import {
  clearPendingDeferredCommitRebase,
  readPendingDeferredCommitRebase,
  writePendingDeferredCommitRebase,
  type PendingDeferredCommitRebase,
  type PendingDeferredCommitRebaseKind,
  type PendingDeferredCommitOperation,
} from "./deferredCommitRebaseState";
import { runStash } from "./stashExec";
import { assertCurrentBranchHead } from "./refSafety";

/** deferred rebase 실행에 필요한 입력값 */
export interface DeferredCommitRebaseInput {
  kind: PendingDeferredCommitRebaseKind;
  operation?: PendingDeferredCommitOperation;
  label: string;
  repoRoot: string;
  commits: string[];
  destinationBranch: string;
  beforeHead: string;
  snapshotRef: string;
  sourceRef?: string;
  preservedStashHash?: string;
  /** true 면 각 commit 적용 전 대상 브랜치와 HEAD 가 작업 예상 상태인지 확인한다. */
  guardCurrentBranch?: boolean;
}

/** deferred rebase 시작 결과 */
export interface DeferredCommitRebaseResult {
  status: "completed" | "conflicts";
  branch: string;
  beforeHead: string;
  afterHead: string;
  snapshotRef: string;
  sourceRef?: string;
  currentCommit?: string;
  deferredCount?: number;
  preservedStashHash?: string;
  restoredLocalChanges?: boolean;
  conflictKind?: "commit" | "stash";
  operation?: PendingDeferredCommitOperation;
}

/** Conflicts 뷰에서 continue 후 deferred rebase 를 이어간 결과 */
export type DeferredCommitRebaseResumeResult =
  | { status: "none" }
  | { status: "pending" }
  | { status: "completed"; branch: string; afterHead: string; restoredLocalChanges: boolean; operation: PendingDeferredCommitOperation }
  | { status: "conflicts"; branch: string; currentCommit?: string; remainingCount: number; operation: PendingDeferredCommitOperation }
  | { status: "restoreConflicts"; branch: string; preservedStashHash?: string; operation: PendingDeferredCommitOperation };

/** deferred rebase abort/stash 정리 결과 */
export type DeferredCommitRebaseCleanupResult =
  | { status: "none" }
  | { status: "restored"; branch: string; operation: PendingDeferredCommitOperation }
  | { status: "dropped"; branch: string; operation: PendingDeferredCommitOperation };

type CommitApplyResult = "applied" | "skipped" | "conflicts";

/**
 * 커밋 목록을 현재 브랜치에 재적용하고, 충돌 커밋은 뒤로 미뤄 마지막에 하나씩 노출한다.
 * - 첫 pass 에서는 충돌 커밋을 abort 후 큐에 담고 다음 커밋을 계속 시도한다.
 * - 충돌 큐가 비면 보존 stash 를 복원하고 작업을 끝낸다.
 * @param input deferred rebase 실행 입력값
 * @returns 완료 또는 충돌 대기 상태
 */
export async function runDeferredCommitRebase(
  input: DeferredCommitRebaseInput
): Promise<DeferredCommitRebaseResult> {
  const commits = uniqueHashes(input.commits);
  if (!commits.length) {
    throw new Error(`${input.label} has no commits to replay.`);
  }
  await clearPendingDeferredCommitRebase(input.repoRoot).catch(() => undefined);
  const deferred: string[] = [];
  const operation = input.operation ?? "cherry-pick";
  let operationHead = input.beforeHead;
  for (const commit of commits) {
    if (input.guardCurrentBranch) {
      await assertCurrentBranchHead(
        input.repoRoot,
        input.destinationBranch,
        operationHead,
        `continuing ${input.label} deferred rebase`
      );
    }
    const result = await tryApplyCommit(input.repoRoot, commit, operation);
    if (result === "conflicts") {
      await runGit([operation, "--abort"], input.repoRoot);
      deferred.push(commit);
    }
    operationHead = await currentHead(input.repoRoot);
  }
  const pending = createPendingState(input, deferred, operationHead);
  if (!deferred.length) {
    const finish = await finishPendingDeferredCommitRebase(input.repoRoot, pending);
    return resumeToRunResult(input, finish, await safeCurrentHead(input.repoRoot, input.beforeHead));
  }
  await writePendingDeferredCommitRebase(input.repoRoot, pending);
  const next = await applyPendingDeferredCommitQueue(
    input.repoRoot,
    pending,
    input.guardCurrentBranch === true
  );
  return resumeToRunResult(input, next, await safeCurrentHead(input.repoRoot, input.beforeHead));
}

/**
 * `git cherry-pick --continue` 뒤에 남은 deferred commit 큐를 계속 적용한다.
 * - 다음 deferred commit 이 또 충돌하면 다시 Conflicts 뷰에 맡긴다.
 * @param repoRoot git 저장소 루트
 * @returns 이어가기 결과
 */
export async function continuePendingDeferredCommitRebase(
  repoRoot: string
): Promise<DeferredCommitRebaseResumeResult> {
  const pending = await readPendingDeferredCommitRebase(repoRoot);
  if (!pending) {
    return { status: "none" };
  }
  if (await isConflictState(repoRoot)) {
    return { status: "pending" };
  }
  const operationHead = await currentHead(repoRoot);
  return applyPendingDeferredCommitQueue(repoRoot, {
    ...pending,
    currentCommit: undefined,
    operationHead,
  }, Boolean(pending.operationHead));
}

/**
 * deferred rebase 를 abort 한 뒤 시작 snapshot 과 보존 stash 를 복원한다.
 * - 이미 적용된 non-conflict commit 들까지 모두 취소해야 하므로 snapshot 으로 hard reset 한다.
 * @param repoRoot git 저장소 루트
 */
export async function restorePendingDeferredCommitRebaseAfterAbort(
  repoRoot: string
): Promise<DeferredCommitRebaseCleanupResult> {
  const pending = await readPendingDeferredCommitRebase(repoRoot);
  if (!pending || await isConflictState(repoRoot)) {
    return { status: "none" };
  }
  await switchToBranch(repoRoot, pending.destinationBranch);
  if (pending.operationHead) {
    await assertCurrentBranchHead(
      repoRoot,
      pending.destinationBranch,
      pending.operationHead,
      "restoring aborted deferred rebase"
    );
  }
  await runGit(["reset", "--hard", pending.snapshotRef], repoRoot);
  await restorePendingLocalChanges(
    repoRoot,
    pending,
    "Deferred rebase merge was aborted, but preserved local changes could not be restored."
  );
  await runGit(["update-ref", "-d", pending.snapshotRef], repoRoot).catch(() => "");
  return { status: "restored", branch: pending.destinationBranch, operation: pending.operation };
}

/**
 * stash 복원 충돌이 사용자의 파일 해결로 끝난 뒤 보존 stash 와 상태 파일을 정리한다.
 * @param repoRoot git 저장소 루트
 */
export async function dropPendingDeferredCommitRebaseStashAfterResolvedRestore(
  repoRoot: string
): Promise<DeferredCommitRebaseCleanupResult> {
  const pending = await readPendingDeferredCommitRebase(repoRoot);
  if (!pending || await isConflictState(repoRoot)) {
    return { status: "none" };
  }
  if (pending.preservedStashHash) {
    await dropStash(repoRoot, pending.preservedStashHash);
    await clearPendingDeferredCommitRebase(repoRoot);
    return { status: "dropped", branch: pending.destinationBranch, operation: pending.operation };
  }
  await clearPendingDeferredCommitRebase(repoRoot);
  return { status: "none" };
}

/**
 * 지정 브랜치의 pending deferred rebase stash 를 복원한다.
 * - undo 흐름에서 snapshot 으로 돌아간 뒤 사용자의 원래 변경을 되살릴 때 사용한다.
 * @param repoRoot git 저장소 루트
 * @param branch 복원 대상 브랜치
 * @param failureMessage stash 복원 실패 시 붙일 사용자 메시지
 */
export async function restorePendingDeferredCommitRebaseLocalChangesForBranch(
  repoRoot: string,
  branch: string,
  failureMessage: string
): Promise<void> {
  const pending = await readPendingDeferredCommitRebase(repoRoot);
  if (!pending || pending.destinationBranch !== branch) {
    return;
  }
  await restorePendingLocalChanges(repoRoot, pending, failureMessage);
}

/**
 * pending 상태 객체를 실행 입력값에서 만든다.
 * @param input deferred rebase 실행 입력값
 * @param remainingCommits 첫 pass 에서 뒤로 미룬 충돌 커밋 목록
 */
function createPendingState(
  input: DeferredCommitRebaseInput,
  remainingCommits: string[],
  operationHead: string
): PendingDeferredCommitRebase {
  return {
    kind: input.kind,
    operation: input.operation ?? "cherry-pick",
    label: input.label,
    destinationBranch: input.destinationBranch,
    beforeHead: input.beforeHead,
    snapshotRef: input.snapshotRef,
    sourceRef: input.sourceRef,
    operationHead,
    remainingCommits,
    preservedStashHash: input.preservedStashHash,
    createdAt: Date.now(),
  };
}

/**
 * deferred commit 큐를 충돌이 날 때까지 계속 적용한다.
 * @param repoRoot git 저장소 루트
 * @param pending 현재 pending 상태
 */
async function applyPendingDeferredCommitQueue(
  repoRoot: string,
  pending: PendingDeferredCommitRebase,
  guardCurrentBranch = false
): Promise<DeferredCommitRebaseResumeResult> {
  let state: PendingDeferredCommitRebase = { ...pending, currentCommit: undefined };
  while (state.remainingCommits.length > 0) {
    const [commit, ...remaining] = state.remainingCommits;
    if (guardCurrentBranch && state.operationHead) {
      await assertCurrentBranchHead(
        repoRoot,
        state.destinationBranch,
        state.operationHead,
        `continuing ${state.label} deferred rebase`
      );
    }
    const result = await tryApplyCommit(repoRoot, commit, state.operation);
    if (result === "conflicts") {
      await writePendingDeferredCommitRebase(repoRoot, {
        ...state,
        operationHead: await currentHead(repoRoot),
        currentCommit: commit,
        remainingCommits: remaining,
      });
      return {
        status: "conflicts",
        branch: state.destinationBranch,
        currentCommit: commit,
        remainingCount: remaining.length,
        operation: state.operation,
      };
    }
    state = {
      ...state,
      operationHead: await currentHead(repoRoot),
      currentCommit: undefined,
      remainingCommits: remaining,
    };
    await writePendingDeferredCommitRebase(repoRoot, state);
  }
  return finishPendingDeferredCommitRebase(repoRoot, state);
}

/**
 * deferred rebase 가 끝났을 때 보존 stash 를 복원하고 상태 파일을 정리한다.
 * @param repoRoot git 저장소 루트
 * @param pending 완료할 pending 상태
 */
async function finishPendingDeferredCommitRebase(
  repoRoot: string,
  pending: PendingDeferredCommitRebase
): Promise<DeferredCommitRebaseResumeResult> {
  const state = { ...pending, operationHead: await currentHead(repoRoot) };
  await writePendingDeferredCommitRebase(repoRoot, state);
  try {
    await restorePendingLocalChanges(
      repoRoot,
      state,
      "Deferred rebase merge completed, but preserved local changes could not be restored."
    );
  } catch (err) {
    if (await hasUnmergedChanges(repoRoot)) {
      return {
        status: "restoreConflicts",
        branch: state.destinationBranch,
        preservedStashHash: state.preservedStashHash,
        operation: state.operation,
      };
    }
    throw err;
  }
  return {
    status: "completed",
    branch: state.destinationBranch,
    afterHead: await currentHead(repoRoot),
    restoredLocalChanges: Boolean(state.preservedStashHash),
    operation: state.operation,
  };
}

/**
 * 커밋 하나를 현재 HEAD 위에 적용한다.
 * - 충돌은 호출자가 뒤로 미룰 수 있도록 그대로 남기고 conflicts 로 반환한다.
 * - 이미 적용된 빈 작업은 skip 해서 큐 진행을 막지 않는다.
 * @param repoRoot git 저장소 루트
 * @param commit 적용할 커밋 해시
 * @param operation 적용할 git 작업
 */
async function tryApplyCommit(
  repoRoot: string,
  commit: string,
  operation: PendingDeferredCommitOperation
): Promise<CommitApplyResult> {
  const env = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", HUSKY: "0" };
  try {
    const args =
      operation === "cherry-pick"
        ? ["cherry-pick", "--allow-empty", commit]
        : ["revert", "--no-edit", commit];
    await runGit(args, repoRoot, { env });
    return "applied";
  } catch (err) {
    if (await hasUnmergedChanges(repoRoot)) {
      return "conflicts";
    }
    if (isEmptyCommitApplyError(err)) {
      await runGit([operation, "--skip"], repoRoot, { env }).catch(() => undefined);
      return "skipped";
    }
    throw err;
  }
}

/**
 * pending 상태의 보존 stash 를 복원하고, 성공하면 상태 파일을 제거한다.
 * @param repoRoot git 저장소 루트
 * @param pending 저장된 deferred rebase 상태
 * @param failureMessage stash 복원 실패 시 붙일 사용자 메시지
 */
async function restorePendingLocalChanges(
  repoRoot: string,
  pending: PendingDeferredCommitRebase,
  failureMessage: string
): Promise<void> {
  if (pending.preservedStashHash) {
    await restoreStash(repoRoot, pending.preservedStashHash, failureMessage);
  }
  await clearPendingDeferredCommitRebase(repoRoot);
}

/**
 * stash 를 작업트리에 적용하고 성공하면 stash 목록에서 제거한다.
 * @param repoRoot git 저장소 루트
 * @param hash stash commit hash
 * @param failureMessage 실패 시 사용자에게 보여줄 앞부분 메시지
 */
async function restoreStash(
  repoRoot: string,
  hash: string,
  failureMessage: string
): Promise<void> {
  try {
    await runStash(["apply", hash], repoRoot);
    await dropStash(repoRoot, hash);
  } catch (err) {
    const ref = await findStashRef(repoRoot, hash);
    throw new Error(`${failureMessage} Preserved stash: ${ref ?? hash}. ${errText(err)}`);
  }
}

/**
 * 진행 중 작업 또는 unmerged index entry 가 남아 있는지 확인한다.
 * @param repoRoot git 저장소 루트
 */
async function isConflictState(repoRoot: string): Promise<boolean> {
  const [operation, hasUnmerged] = await Promise.all([
    detectOperation(repoRoot),
    hasUnmergedChanges(repoRoot),
  ]);
  return operation !== "none" || hasUnmerged;
}

/**
 * index 에 unmerged 상태로 남은 파일이 있는지 확인한다.
 * @param repoRoot git 저장소 루트
 */
async function hasUnmergedChanges(repoRoot: string): Promise<boolean> {
  return (await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], repoRoot).catch(() => "")).length > 0;
}

/**
 * 지정한 로컬 브랜치로 working tree 를 전환한다.
 * @param repoRoot git 저장소 루트
 * @param branch 전환할 브랜치 이름
 */
async function switchToBranch(repoRoot: string, branch: string): Promise<void> {
  if (await currentBranch(repoRoot).catch(() => "") === branch) {
    return;
  }
  await runGit(["switch", branch], repoRoot);
}

/**
 * 현재 로컬 브랜치 이름을 읽는다.
 * @param repoRoot git 저장소 루트
 */
async function currentBranch(repoRoot: string): Promise<string> {
  return (await runGit(["symbolic-ref", "--short", "HEAD"], repoRoot).catch(() => "")).trim();
}

/**
 * 현재 HEAD commit hash 를 반환한다.
 * @param repoRoot git 저장소 루트
 */
async function currentHead(repoRoot: string): Promise<string> {
  return (await runGit(["rev-parse", "--verify", "HEAD"], repoRoot)).trim();
}

/**
 * stash commit hash 에 대응하는 stash@{n} 참조를 찾는다.
 * @param repoRoot git 저장소 루트
 * @param hash stash commit hash
 */
async function findStashRef(repoRoot: string, hash: string): Promise<string | undefined> {
  const list = await runStash(["list", "--format=%gd%x00%H"], repoRoot).catch(() => "");
  for (const line of list.split(/\r?\n/)) {
    const [ref, itemHash] = line.split("\0");
    if (itemHash === hash) {
      return ref;
    }
  }
  return undefined;
}

/**
 * 지정한 stash commit 을 stash 목록에서 제거한다.
 * @param repoRoot git 저장소 루트
 * @param hash stash commit hash
 */
async function dropStash(repoRoot: string, hash: string): Promise<void> {
  const ref = await findStashRef(repoRoot, hash);
  if (ref) {
    await runStash(["drop", ref], repoRoot);
  }
}

/**
 * 시작 결과 형태로 resume 결과를 변환한다.
 * @param input deferred rebase 실행 입력값
 * @param result 내부 resume 결과
 */
function resumeToRunResult(
  input: DeferredCommitRebaseInput,
  result: DeferredCommitRebaseResumeResult,
  afterHead: string
): DeferredCommitRebaseResult {
  if (result.status === "completed") {
    return finishToRunResult(input, result);
  }
  if (result.status === "restoreConflicts") {
    return {
      status: "conflicts",
      branch: result.branch,
      beforeHead: input.beforeHead,
      afterHead,
      snapshotRef: input.snapshotRef,
      sourceRef: input.sourceRef,
      preservedStashHash: result.preservedStashHash,
      conflictKind: "stash",
      operation: result.operation,
    };
  }
  if (result.status === "conflicts") {
    return {
      status: "conflicts",
      branch: result.branch,
      beforeHead: input.beforeHead,
      afterHead,
      snapshotRef: input.snapshotRef,
      sourceRef: input.sourceRef,
      currentCommit: result.currentCommit,
      deferredCount: result.remainingCount + 1,
      preservedStashHash: input.preservedStashHash,
      conflictKind: "commit",
      operation: result.operation,
    };
  }
  return {
    status: "conflicts",
    branch: input.destinationBranch,
    beforeHead: input.beforeHead,
    afterHead,
    snapshotRef: input.snapshotRef,
    sourceRef: input.sourceRef,
    preservedStashHash: input.preservedStashHash,
    conflictKind: "commit",
    operation: input.operation ?? "cherry-pick",
  };
}

/**
 * 완료 결과를 시작 결과 형태로 변환한다.
 * @param input deferred rebase 실행 입력값
 * @param result 완료 resume 결과
 */
function finishToRunResult(
  input: DeferredCommitRebaseInput,
  result: Extract<DeferredCommitRebaseResumeResult, { status: "completed" }>
): DeferredCommitRebaseResult {
  return {
    status: "completed",
    branch: result.branch,
    beforeHead: input.beforeHead,
    afterHead: result.afterHead,
    snapshotRef: input.snapshotRef,
    sourceRef: input.sourceRef,
    restoredLocalChanges: result.restoredLocalChanges,
    operation: result.operation,
  };
}

/**
 * 중복 commit hash 를 입력 순서대로 제거한다.
 * @param commits 적용 후보 commit hash 목록
 */
function uniqueHashes(commits: string[]): string[] {
  return Array.from(new Set(commits.filter(Boolean)));
}

/**
 * 현재 HEAD 를 읽되, 충돌/복원 상태에서 조회가 실패하면 fallback 을 반환한다.
 * @param repoRoot git 저장소 루트
 * @param fallback HEAD 조회 실패 시 사용할 해시
 */
async function safeCurrentHead(repoRoot: string, fallback: string): Promise<string> {
  return currentHead(repoRoot).catch(() => fallback);
}

/**
 * cherry-pick 실패가 이미 적용된 빈 변경을 뜻하는지 확인한다.
 * @param err git 실행 오류
 */
function isEmptyCommitApplyError(err: unknown): boolean {
  const text =
    err instanceof GitError
      ? `${err.message}\n${err.stderr}\n${err.stdout}`
      : err instanceof Error
        ? err.message
        : String(err);
  return /previous cherry-pick is now empty|patch contents already upstream|nothing to commit|empty/i.test(
    text
  );
}

/** 오류 메시지를 사용자에게 보여줄 짧은 문자열로 만든다. */
function errText(err: unknown): string {
  if (err instanceof GitError) {
    return [err.stderr.trim(), err.stdout.trim(), err.message]
      .filter(Boolean)
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
}
