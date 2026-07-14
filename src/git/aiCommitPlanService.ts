// 검증된 AI 계획을 private HEAD에서 일반 커밋으로 만든 뒤 실제 branch에 한 번만 publish한다.
// - 실행 중 실제 HEAD/index는 그대로여서 hook 실패나 외부 변경을 rollback으로 덮을 수 없다.
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { CommitPlanContext, CommitPlanGroup } from "../ai/commitPlanModel";
import { detectOperation } from "./conflictService";
import {
  readAiCommitPlanBinaryDiff,
  readAiCommitPlanContext,
  readAiCommitPlanHeadRef,
  readAiCommitPlanIndexFingerprint,
} from "./aiCommitPlanContext";
import {
  applyCommitPlanEntryOverridesToIndex,
  applyFrozenBinaryDiffToIndex,
  assertCommitPlanSourceEntries,
  cleanupCommitPlanIndex,
  commitPlanGitEnvironment,
  commitPlanFilesForPaths,
  copyRealIndexToSibling,
  readCommitPlanIndexSnapshot,
  readCommitPlanIndexTags,
  writeCommitPlanIndexTree,
} from "./aiCommitPlanIndexEntries";
import { publishAiCommitPlan } from "./aiCommitPlanIndexLock";
import { AiCommitPlanPrivateRepo } from "./aiCommitPlanPrivateRepo";
import { runGit } from "./gitExec";
import { tempIndexPath } from "./gitPatchApply";
import {
  AiCommitPlanError,
  assertCommitPlanFence,
  commitPlanGroups,
  computeCommitPlanSnapshot,
  reportCommitPlanProgress,
  validateExecutableCommitPlan,
  type CommitPlanExecutionResult,
  type CommitPlanProgressCallback,
  type ExecutedCommitPlanGroup,
  type ExecutableCommitPlan,
  type FrozenCommitPlanInput,
  type GitFenceState,
  type CommitPlanIndexEntry,
} from "./aiCommitPlanSafety";

export { AiCommitPlanError } from "./aiCommitPlanSafety";
export type {
  AiCommitPlanErrorCode, CommitPlanExecutionResult, CommitPlanProgress,
  CommitPlanProgressCallback, CommitPlanProgressPhase, ExecutedCommitPlanGroup,
  ExecutableCommitPlan,
} from "./aiCommitPlanSafety";

/** frozen source와 staged hook 결과를 설치할 actual-index sibling 경로를 함께 보관한다. */
interface FrozenExecutionInput extends FrozenCommitPlanInput {
  zeroOid: string;
  publishIndexPath: string;
}

/**
 * 저장소 하나의 AI 커밋 계획을 private transaction과 최종 ref/index publish로 실행한다.
 * - command/UI 계층은 이 서비스만 호출하며 Git 격리와 동시성 정책은 하위 모듈이 담당한다.
 */
export class AiCommitPlanService {
  /**
   * 실행 대상 저장소를 고정한다.
   * @param repoRoot 계획 컨텍스트와 일치해야 하는 Git 작업트리 루트
   */
  constructor(public readonly repoRoot: string) {}

  /**
   * 계획 path를 검증하고 frozen source entry로 private 일반 커밋들을 만든 뒤 한 번에 publish한다.
   * - 각 그룹 전후 actual HEAD OID/ref, semantic index, active operation fence를 검사한다.
   * - hook은 private HEAD/index에서 실행되며 승인 그룹 밖 tree 변경은 publish 전에 거부한다.
   * - 최종 actual index.lock 안에서 원래 exact branch ref를 old-value CAS로 한 번만 이동한다.
   * @param context AI 요청을 만들 때 읽은 저장소 변경 snapshot
   * @param plan planner 결과 또는 사용자가 편집한 그룹 배열
   * @param onProgress 검증/그룹 commit/완료 상태를 받는 선택 callback
   * @returns 실제 branch에 publish된 commit hash 목록과 최종 HEAD
   */
  async execute(
    context: CommitPlanContext,
    plan: ExecutableCommitPlan,
    onProgress?: CommitPlanProgressCallback
  ): Promise<CommitPlanExecutionResult> {
    this.assertRepository(context);
    const groups = validateExecutableCommitPlan(context, commitPlanGroups(plan));
    await reportCommitPlanProgress(onProgress, {
      phase: "validate",
      current: 0,
      total: groups.length,
    });
    await this.assertSnapshot(context);

    const initial = await readFenceState(this.repoRoot);
    assertCommitPlanFence(
      initial,
      context.head,
      context.branch === "HEAD" ? undefined : `refs/heads/${context.branch}`,
      initial.indexFingerprint,
      "execution start"
    );
    assertSupportedInitialFence(initial);
    const frozen = await freezeCommitPlanInput(
      this.repoRoot,
      context,
      initial.indexFingerprint
    );
    let privateRepo: AiCommitPlanPrivateRepo | undefined;
    try {
      await assertExecutionFence(this.repoRoot, initial, "frozen source capture");
      privateRepo = await AiCommitPlanPrivateRepo.create(
        this.repoRoot,
        initial.head!
      );
      return await this.executePrivateGroups(
        context,
        groups,
        frozen,
        initial,
        privateRepo,
        onProgress
      );
    } finally {
      await privateRepo?.dispose();
      cleanupFrozenExecutionInput(frozen);
    }
  }

  /**
   * frozen entry를 그룹별 private commit으로 만들고 안전한 hook blob을 반영한 최종 tree만 publish한다.
   * @param context scope와 전체 파일 메타데이터
   * @param groups 검증된 계획 그룹
   * @param frozen source index/tree/entry snapshot
   * @param initial 실제 저장소 시작 fence
   * @param privateRepo 실제 ref와 분리된 private transaction
   * @param onProgress 선택 진행 callback
   * @returns publish된 실제 결과
   */
  private async executePrivateGroups(
    context: CommitPlanContext,
    groups: CommitPlanGroup[],
    frozen: FrozenExecutionInput,
    initial: GitFenceState,
    privateRepo: AiCommitPlanPrivateRepo,
    onProgress?: CommitPlanProgressCallback
  ): Promise<CommitPlanExecutionResult> {
    const filesByPath = new Map(context.files.map((file) => [file.path, file]));
    const executed: ExecutedCommitPlanGroup[] = [];
    const hookEntryOverrides: CommitPlanIndexEntry[] = [];
    let finalTree = "";
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      await reportCommitPlanProgress(onProgress, {
        phase: "commit",
        current: index,
        total: groups.length,
        step: "started",
        message: group.message,
        paths: [...group.paths],
      });
      await assertExecutionFence(
        this.repoRoot,
        initial,
        `before private commit group ${index + 1}`
      );
      const commit = await privateRepo.commitGroup(
        group,
        commitPlanFilesForPaths(group.paths, filesByPath),
        frozen.entries,
        frozen.zeroOid
      );
      await assertExecutionFence(
        this.repoRoot,
        initial,
        `after private commit group ${index + 1}`
      );
      finalTree = commit.tree;
      hookEntryOverrides.push(...commit.hookEntryOverrides);
      executed.push({
        hash: commit.hash,
        message: group.message,
        paths: [...group.paths],
        hookAdjustedPaths: commit.hookEntryOverrides.map((entry) => entry.path),
      });
      await reportCommitPlanProgress(onProgress, {
        phase: "commit",
        current: index + 1,
        total: groups.length,
        step: "completed",
        message: group.message,
        paths: [...group.paths],
      });
    }
    await prepareCommitPlanPublishIndexes(
      this.repoRoot,
      frozen,
      hookEntryOverrides,
      finalTree
    );
    const installIndex = context.scope === "all" || hookEntryOverrides.length > 0;
    const finalIndexBytes = installIndex
      ? await readFile(frozen.publishIndexPath)
      : undefined;
    await assertExecutionFence(this.repoRoot, initial, "before final publication");
    await publishAiCommitPlan(this.repoRoot, {
      original: initial,
      finalHead: privateRepo.head,
      finalTree,
      finalIndexBytes,
    });
    await reportCommitPlanProgress(onProgress, {
      phase: "complete",
      current: groups.length,
      total: groups.length,
    });
    return {
      originalHead: initial.head,
      head: privateRepo.head,
      commits: executed,
    };
  }

  /**
   * 컨텍스트가 이 서비스와 같은 저장소에서 만들어졌는지 확인한다.
   * @param context 실행 요청의 저장소 루트가 담긴 계획 컨텍스트
   */
  private assertRepository(context: CommitPlanContext): void {
    if (path.resolve(context.repoRoot) !== path.resolve(this.repoRoot)) {
      throw new AiCommitPlanError(
        "repository-mismatch",
        "The AI commit plan belongs to a different repository."
      );
    }
  }

  /**
   * context를 다시 수집해 AI 요청 뒤 HEAD/ref/index/선택 범위가 바뀌지 않았는지 확인한다.
   * @param context AI 요청 시점 snapshot과 branch
   */
  private async assertSnapshot(context: CommitPlanContext): Promise<void> {
    let current: CommitPlanContext;
    try {
      current = await readAiCommitPlanContext(this.repoRoot, context.scope);
    } catch (error) {
      if (
        error instanceof AiCommitPlanError &&
        (error.code === "active-operation" || error.code === "unsupported-head")
      ) {
        throw error;
      }
      throw new AiCommitPlanError(
        "stale-snapshot",
        "Changes can no longer be matched to the AI commit plan. Generate the plan again.",
        error
      );
    }
    if (current.snapshot !== context.snapshot || current.branch !== context.branch) {
      throw new AiCommitPlanError(
        "stale-snapshot",
        "Changes were modified after the AI commit plan was created. Generate the plan again."
      );
    }
  }
}

/**
 * class를 보관하지 않는 command 계층을 위한 일회성 실행 함수다.
 * @param context AI 요청 시점 저장소 컨텍스트
 * @param plan planner 결과 또는 편집된 그룹 배열
 * @param onProgress 선택 진행 callback
 * @returns publish된 commits와 최종 HEAD
 */
export async function executeAiCommitPlan(
  context: CommitPlanContext,
  plan: ExecutableCommitPlan,
  onProgress?: CommitPlanProgressCallback
): Promise<CommitPlanExecutionResult> {
  return new AiCommitPlanService(context.repoRoot)
    .execute(context, plan, onProgress);
}

/**
 * staged/all 입력 전체를 source index 한 개에 고정하고 tree/entry map을 읽는다.
 * - staged는 HEAD 기반 temp index에 fresh full binary cached diff를 적용해 intent/flags 영향을 피한다.
 * - all은 actual index의 sibling snapshot에 `add -A`해 flags/split-index 의미를 유지하고 이후 편집을 제외한다.
 * @param repoRoot Git 저장소 루트
 * @param context 계획 범위와 시작 snapshot
 * @param indexFingerprint 실행 시작 실제 index semantic fingerprint
 * @returns 정리할 source index, 전체 tree/entries, object format zero OID
 */
async function freezeCommitPlanInput(
  repoRoot: string,
  context: CommitPlanContext,
  indexFingerprint: string
): Promise<FrozenExecutionInput> {
  const indexPath = context.scope === "all"
    ? await copyRealIndexToSibling(repoRoot)
    : tempIndexPath();
  let publishIndexPath = indexPath;
  const env = commitPlanGitEnvironment({ GIT_INDEX_FILE: indexPath });
  try {
    if (context.scope === "staged") {
      publishIndexPath = await copyRealIndexToSibling(repoRoot);
    }
    let binaryDiff: Uint8Array;
    if (context.scope === "staged") {
      await initializeIndex(repoRoot, context.head!, env);
      binaryDiff = await readAiCommitPlanBinaryDiff(repoRoot, context.head!);
      await applyFrozenBinaryDiffToIndex(repoRoot, env, binaryDiff);
    } else {
      await runGit(["add", "-A"], repoRoot, { env });
      binaryDiff = await readAiCommitPlanBinaryDiff(
        repoRoot,
        context.head!,
        env
      );
    }
    const snapshot = computeCommitPlanSnapshot(
      context.head,
      context.scope,
      binaryDiff,
      indexFingerprint
    );
    if (snapshot !== context.snapshot) {
      throw new AiCommitPlanError(
        "stale-snapshot",
        "Changes moved while the AI commit plan source was being captured. Generate the plan again."
      );
    }
    const [tree, indexSnapshot] = await Promise.all([
      writeCommitPlanIndexTree(repoRoot, env),
      readCommitPlanIndexSnapshot(repoRoot, env),
    ]);
    assertCommitPlanSourceEntries(context.files, indexSnapshot.entries);
    return {
      indexPath,
      publishIndexPath,
      tree,
      entries: indexSnapshot.entries,
      zeroOid: indexSnapshot.zeroOid,
    };
  } catch (error) {
    cleanupCommitPlanIndex(indexPath);
    if (publishIndexPath !== indexPath) {
      cleanupCommitPlanIndex(publishIndexPath);
    }
    throw error;
  }
}

/**
 * 검증된 hook blob 교체를 승인 source와 실제-index sibling에 반영하고 최종 private tree를 재검증한다.
 * - source index는 HEAD 기반의 완전한 tree라 전체 OID 비교로 누락된 변경을 잡는다.
 * - staged publish sibling은 실제 index flags/확장을 보존하며 hook이 바꾼 entry만 교체한다.
 * @param repoRoot Git 저장소 루트
 * @param frozen 승인 source index와 publish용 actual-index sibling
 * @param overrides 그룹별 hook 검증을 통과한 일반 파일 entry
 * @param finalTree 마지막 private commit의 root tree OID
 */
async function prepareCommitPlanPublishIndexes(
  repoRoot: string,
  frozen: FrozenExecutionInput,
  overrides: readonly CommitPlanIndexEntry[],
  finalTree: string
): Promise<void> {
  const sourceEnv = commitPlanGitEnvironment({ GIT_INDEX_FILE: frozen.indexPath });
  if (overrides.length > 0) {
    await assertIndexEntryOverrides(repoRoot, sourceEnv, overrides, false);
    await applyCommitPlanEntryOverridesToIndex(repoRoot, sourceEnv, overrides);
    await assertIndexEntryOverrides(repoRoot, sourceEnv, overrides, true);
    if (frozen.publishIndexPath !== frozen.indexPath) {
      const publishEnv = commitPlanGitEnvironment({
        GIT_INDEX_FILE: frozen.publishIndexPath,
      });
      await assertIndexEntryOverrides(repoRoot, publishEnv, overrides, false);
      await applyCommitPlanEntryOverridesToIndex(repoRoot, publishEnv, overrides);
      await assertIndexEntryOverrides(repoRoot, publishEnv, overrides, true);
    }
  }
  const preparedTree = await writeCommitPlanIndexTree(repoRoot, sourceEnv);
  if (preparedTree !== finalTree) {
    throw new AiCommitPlanError(
      "commit-tree-mismatch",
      "The private AI commits do not reproduce the approved source plus safe hook changes. The real branch and Git index were not changed."
    );
  }
}

/**
 * prepared/publish index의 hook path가 정상 flag와 기대 mode/OID를 유지하는지 확인한다.
 * - assume-unchanged/skip-worktree path는 update-index가 flag를 잃을 수 있어 hook 자동수정을 보수적으로 거부한다.
 * @param repoRoot Git 저장소 루트
 * @param env 검사할 source 또는 actual-index sibling 환경
 * @param overrides 기대하는 hook 생성 entry
 * @param requireFinalOid true면 hook 이후 exact OID까지 같아야 한다
 */
async function assertIndexEntryOverrides(
  repoRoot: string,
  env: Record<string, string>,
  overrides: readonly CommitPlanIndexEntry[],
  requireFinalOid: boolean
): Promise<void> {
  const [actual, tags] = await Promise.all([
    readCommitPlanIndexSnapshot(repoRoot, env).then((snapshot) => snapshot.entries),
    readCommitPlanIndexTags(repoRoot, env),
  ]);
  for (const expected of overrides) {
    const entry = actual.get(expected.path);
    if (
      entry?.mode !== expected.mode ||
      tags.get(expected.path) !== "H" ||
      (requireFinalOid && entry.oid !== expected.oid)
    ) {
      throw new AiCommitPlanError(
        "commit-tree-mismatch",
        `The prepared Git index could not retain a safe unflagged hook change for ${expected.path}.`
      );
    }
  }
}

/** frozen source와 별도 staged publish sibling을 중복 없이 정리한다. */
function cleanupFrozenExecutionInput(frozen: FrozenExecutionInput): void {
  cleanupCommitPlanIndex(frozen.indexPath);
  if (frozen.publishIndexPath !== frozen.indexPath) {
    cleanupCommitPlanIndex(frozen.publishIndexPath);
  }
}

/**
 * actual HEAD OID/ref/index/operation이 시작 fence에서 바뀌면 외부 상태 보존 오류를 던진다.
 * @param repoRoot Git 저장소 루트
 * @param initial 실행 시작 fence
 * @param stage 오류에 표시할 실행 단계
 */
async function assertExecutionFence(
  repoRoot: string,
  initial: GitFenceState,
  stage: string
): Promise<void> {
  assertCommitPlanFence(
    await readFenceState(repoRoot),
    initial.head,
    initial.headRef,
    initial.indexFingerprint,
    stage
  );
}

/**
 * actual HEAD OID/ref, semantic index fingerprint, active operation을 함께 읽는다.
 * @param repoRoot Git 저장소 루트
 * @returns 동시성 fence 현재 상태
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
 * actual HEAD commit OID를 읽는다.
 * @param repoRoot Git 저장소 루트
 * @returns born HEAD OID 또는 undefined
 */
async function readHead(repoRoot: string): Promise<string | undefined> {
  const raw = await runGit(["rev-parse", "--verify", "HEAD"], repoRoot)
    .catch(() => "");
  return raw.trim() || undefined;
}

/**
 * private detached 기준점과 exact publish ref가 없는 저장소를 실행 전에 거부한다.
 * @param initial actual 실행 시작 fence
 */
function assertSupportedInitialFence(initial: GitFenceState): void {
  if (!initial.head || !initial.headRef) {
    throw new AiCommitPlanError(
      "unsupported-head",
      "AI commit plans require an existing commit on a checked-out local branch."
    );
  }
}

/**
 * source index를 HEAD tree로 초기화한다.
 * @param repoRoot Git 저장소 루트
 * @param head 검증된 born 기준 commit OID
 * @param env source GIT_INDEX_FILE 환경
 */
async function initializeIndex(
  repoRoot: string,
  head: string,
  env: Record<string, string>
): Promise<void> {
  await runGit(["read-tree", head], repoRoot, { env });
}
