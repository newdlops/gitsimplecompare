// private AI 커밋들을 실제 symbolic branch에 한 번만 publish하고 실제 index를 안전하게 마무리한다.
// - Git에는 branch ref CAS와 index CAS를 묶는 명령이 없어 이 모듈만 index.lock 파일 작업을 직접 수행한다.
import {
  lstat,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import type { CommitPlanScope } from "../ai/commitPlanModel";
import { detectOperation } from "./conflictService";
import {
  readAiCommitPlanHeadRef,
  readAiCommitPlanIndexFingerprint,
} from "./aiCommitPlanContext";
import {
  commitPlanGitEnvironment,
  resolveRealGitIndexPath,
  writeCommitPlanIndexTree,
} from "./aiCommitPlanIndexEntries";
import { runGit } from "./gitExec";
import {
  AiCommitPlanError,
  assertCommitPlanFence,
  commitPlanErrorText,
  invalidCommitPlan,
  type GitFenceState,
} from "./aiCommitPlanSafety";

/** 실제 branch publish와 index 마무리에 필요한 불변 입력이다. */
export interface PublishAiCommitPlanInput {
  scope: CommitPlanScope;
  original: GitFenceState;
  finalHead: string;
  finalTree: string;
  sourceIndexPath: string;
}

/** O_EXCL로 직접 만든 실제 index lock과 소유권 identity다. */
interface OwnedIndexLock {
  indexPath: string;
  lockPath: string;
  handle: FileHandle;
  identity: FileIdentity;
  closed: boolean;
}

/** lock 경로가 다른 파일로 교체됐는지 판별하는 device/inode 쌍이다. */
interface FileIdentity {
  dev: number;
  ino: number;
}

/** Node fs 오류에서 플랫폼 공통 code만 읽기 위한 최소 구조다. */
interface FileSystemError {
  code?: string;
}

/**
 * private 최종 commit을 원래 exact branch ref에 CAS publish하고 index를 scope 정책대로 마무리한다.
 * - 실제 index.lock 획득 뒤 original HEAD OID/ref, semantic index, operation을 모두 재검증한다.
 * - staged는 실제 index 바이트/flags를 전혀 바꾸지 않고 lock을 해제한다.
 * - all은 actual index에서 출발한 frozen source 전체 bytes를 설치해 net-zero path까지 reconcile한다.
 * @param repoRoot 실제 Git 작업트리 루트
 * @param input 원래 fence, private 최종 commit/tree, frozen source entry
 */
export async function publishAiCommitPlan(
  repoRoot: string,
  input: PublishAiCommitPlanInput
): Promise<void> {
  assertPublishInput(input);
  const indexPath = await resolveRealGitIndexPath(repoRoot);
  let lock: OwnedIndexLock | undefined;
  let refPublished = false;
  let completed = false;
  try {
    lock = await acquireRealIndexLock(indexPath);
    await assertFenceWhileLocked(repoRoot, input.original);
    if (input.scope === "all") {
      const finalBytes = await readVerifiedFrozenIndex(repoRoot, input);
      await writeBytesToOwnedLock(lock, finalBytes);
    }
    await assertOwnedLockPath(lock);
    await updateExactBranchRef(
      repoRoot,
      input.original.headRef!,
      input.finalHead,
      input.original.head!
    );
    refPublished = true;
    if (input.scope === "all") {
      await assertOwnedLockPath(lock);
      await rename(lock.lockPath, lock.indexPath);
    } else {
      await releaseOwnedLock(lock);
    }
    completed = true;
  } catch (error) {
    if (refPublished && !completed) {
      await rollbackPublishedRef(repoRoot, input, error);
    }
    throw error;
  } finally {
    if (lock && !completed) {
      await closeLockQuietly(lock);
      await removeOnlyOwnedLock(lock);
    }
  }
}

/**
 * publish에 안전한 born symbolic branch와 완전한 원래 fence가 있는지 확인한다.
 * @param input 최종 publish 입력
 */
function assertPublishInput(input: PublishAiCommitPlanInput): void {
  if (!input.original.head || !input.original.headRef) {
    throw new AiCommitPlanError(
      "unsupported-head",
      "AI commit plans require an existing commit on a checked-out local branch."
    );
  }
  if (!input.finalHead || !input.finalTree) {
    throw invalidCommitPlan("The private AI commit transaction has no final commit tree.");
  }
}

/**
 * actual index snapshot에서 시작해 검증된 frozen source index 전체 bytes를 읽는다.
 * - source는 actual index sibling이라 split-index의 상대 sharedindex 참조가 publish 뒤에도 유효하다.
 * - publish 직전 tree를 다시 계산해 private 최종 commit 전체와 정확히 일치하는지 확인한다.
 * @param repoRoot 실제 작업트리 루트
 * @param input frozen source index 경로와 기대 final tree
 * @returns tree 검증을 통과한 final index 전체 바이트
 */
async function readVerifiedFrozenIndex(
  repoRoot: string,
  input: PublishAiCommitPlanInput
): Promise<Buffer> {
  const env = commitPlanGitEnvironment({
    GIT_INDEX_FILE: input.sourceIndexPath,
  });
  const tree = await writeCommitPlanIndexTree(repoRoot, env);
  if (tree !== input.finalTree) {
    throw new AiCommitPlanError(
      "commit-tree-mismatch",
      "The frozen final Git index does not match the approved AI commit plan tree."
    );
  }
  return readFile(input.sourceIndexPath);
}

/**
 * actual index.lock을 O_EXCL로 한 번만 만들고 생성 inode를 기록한다.
 * - 기존 lock이면 절대 대기/삭제/truncate하지 않고 외부 Git 작업으로 보고 종료한다.
 * @param indexPath actual index absolute path
 * @returns 열린 소유 lock
 */
async function acquireRealIndexLock(indexPath: string): Promise<OwnedIndexLock> {
  const lockPath = `${indexPath}.lock`;
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o666);
  } catch (error) {
    if (fileErrorCode(error) === "EEXIST") {
      throw new AiCommitPlanError(
        "concurrent-change",
        "The Git index is locked by another process. Its lock and index were preserved."
      );
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    return {
      indexPath,
      lockPath,
      handle,
      identity: { dev: stats.dev, ino: stats.ino },
      closed: false,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    // identity를 증명할 수 없으므로 실패 경로에서 이름만 보고 lock을 삭제하지 않는다.
    throw error;
  }
}

/**
 * lock 획득 뒤 실제 HEAD OID/ref, semantic index fingerprint, operation을 원래 fence와 비교한다.
 * @param repoRoot 실제 작업트리 루트
 * @param original 계획 실행 시작 fence
 */
async function assertFenceWhileLocked(
  repoRoot: string,
  original: GitFenceState
): Promise<void> {
  assertCommitPlanFence(
    await readFenceState(repoRoot),
    original.head,
    original.headRef,
    original.indexFingerprint,
    "final locked branch publication"
  );
}

/**
 * 실제 Git 상태를 공용 CLI 경계로 읽어 publish fence를 만든다.
 * @param repoRoot 실제 작업트리 루트
 * @returns HEAD OID/ref, semantic index, active operation
 */
async function readFenceState(repoRoot: string): Promise<GitFenceState> {
  const [head, headRef, indexFingerprint, operation] = await Promise.all([
    readHead(repoRoot),
    readAiCommitPlanHeadRef(repoRoot),
    readAiCommitPlanIndexFingerprint(repoRoot),
    detectOperation(repoRoot),
  ]);
  return { head, headRef, indexFingerprint, operation };
}

/**
 * 현재 실제 HEAD OID를 읽는다.
 * @param repoRoot 실제 작업트리 루트
 * @returns born HEAD OID 또는 undefined
 */
async function readHead(repoRoot: string): Promise<string | undefined> {
  const raw = await runGit(["rev-parse", "--verify", "HEAD"], repoRoot)
    .catch(() => "");
  return raw.trim() || undefined;
}

/**
 * 완성된 final index bytes를 owned lock에 쓰고 fsync/close한다.
 * @param lock O_EXCL로 만든 actual index lock
 * @param bytes preserved final index 전체 바이트
 */
async function writeBytesToOwnedLock(
  lock: OwnedIndexLock,
  bytes: Buffer
): Promise<void> {
  await assertOwnedLockPath(lock);
  await lock.handle.truncate(0);
  await lock.handle.writeFile(bytes);
  await lock.handle.sync();
  await lock.handle.close();
  lock.closed = true;
}

/**
 * exact symbolic branch ref를 original→private final로 old-value CAS 갱신한다.
 * - HEAD pseudo-ref가 아니라 시작 시 고정한 refs/heads/...를 사용해 다른 branch에 publish하지 않는다.
 * @param repoRoot 실제 작업트리 루트
 * @param headRef 원래 exact symbolic branch ref
 * @param finalHead private 최종 commit OID
 * @param originalHead 계획 시작 commit OID
 */
async function updateExactBranchRef(
  repoRoot: string,
  headRef: string,
  finalHead: string,
  originalHead: string
): Promise<void> {
  try {
    await runGit(
      ["update-ref", headRef, finalHead, originalHead],
      repoRoot,
      { retryOnLock: false }
    );
  } catch (error) {
    throw new AiCommitPlanError(
      "concurrent-change",
      "The original branch could not be published with its expected old HEAD. External refs were preserved.",
      error
    );
  }
}

/**
 * ref publish 뒤 index 설치/lock 해제가 실패하면 final→original CAS rollback한다.
 * - CAS가 실패하면 외부 ref 변경을 덮지 않고 명시적 rollback-failed 오류를 반환한다.
 * @param repoRoot 실제 작업트리 루트
 * @param input original/final ref OID
 * @param publishError index 마무리 원본 오류
 */
async function rollbackPublishedRef(
  repoRoot: string,
  input: PublishAiCommitPlanInput,
  publishError: unknown
): Promise<void> {
  try {
    await runGit(
      ["update-ref", input.original.headRef!, input.original.head!, input.finalHead],
      repoRoot,
      { retryOnLock: false }
    );
  } catch (rollbackError) {
    throw new AiCommitPlanError(
      "rollback-failed",
      `The AI plan branch was published but index finalization failed, and the branch changed before safe rollback: ${commitPlanErrorText(rollbackError)}`,
      { publishError, rollbackError }
    );
  }
}

/** owned lock 경로가 기록한 device/inode를 계속 가리키는지 확인한다. */
async function assertOwnedLockPath(lock: OwnedIndexLock): Promise<void> {
  const stats = await lstat(lock.lockPath).catch(() => undefined);
  if (!stats || stats.dev !== lock.identity.dev || stats.ino !== lock.identity.ino) {
    throw new AiCommitPlanError(
      "concurrent-change",
      "The Git index lock changed during AI plan publication. External state was preserved."
    );
  }
}

/** staged 성공 시 actual index를 바꾸지 않고 자신이 만든 빈 lock만 닫아 제거한다. */
async function releaseOwnedLock(lock: OwnedIndexLock): Promise<void> {
  await closeLockQuietly(lock);
  await assertOwnedLockPath(lock);
  await unlink(lock.lockPath);
}

/** 오류 경로에서 열린 owned lock handle을 조용히 닫는다. */
async function closeLockQuietly(lock: OwnedIndexLock): Promise<void> {
  if (!lock.closed) {
    await lock.handle.close().catch(() => undefined);
    lock.closed = true;
  }
}

/** 오류 정리에서 inode가 그대로일 때만 자신이 만든 lock을 삭제한다. */
async function removeOnlyOwnedLock(lock: OwnedIndexLock): Promise<void> {
  const stats = await lstat(lock.lockPath).catch(() => undefined);
  if (stats?.dev === lock.identity.dev && stats.ino === lock.identity.ino) {
    await unlink(lock.lockPath).catch(() => undefined);
  }
}

/** unknown Node fs 오류에서 문자열 code만 읽는다. */
function fileErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === "object"
    ? (error as FileSystemError).code
    : undefined;
  return typeof code === "string" ? code : undefined;
}
