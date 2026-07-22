// PR stack의 연쇄 rebase 계획·실행·충돌 후속 처리를 담당하는 서비스 모듈.
// - 각 layer를 별도 clean worktree에서 `rebase --onto`하고 branch별 backup ref를 먼저 만든다.
// - 충돌 상태와 남은 계획은 common git dir에 저장해 VS Code 재시작 뒤 Continue/Abort도 이어 간다.
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectOperation } from "./conflictService";
import { runGit } from "./gitExec";
import { PullRequestStackMetadataService } from "./pullRequestStackMetadata";
import type { StackLocalBranch } from "./pullRequestStackModel";
import { WorktreeService, type WorktreeInfo } from "./worktreeService";
const STATE_VERSION = 1, STATE_RELATIVE_PATH = "gitsimplecompare/stack-restack-state.json";
const TEMP_WORKTREE_PREFIX = "gsc-stack-restack-";
/** Advance 완료 뒤 명령 레이어가 submit/cleanup을 이어가기 위한 후속 동작 */
export interface PullRequestStackRestackPostAction {
  kind: "advance";
  mergedBranch: string;
  promotedBranches: string[];
  remote: string;
}
/** 특정 root의 parent 관계를 Advance 시점에 바꿔 계획하는 override */
export interface PullRequestStackParentOverride {
  parentBranch: string;
  oldParentHead: string;
  parentTargetHash?: string;
}
/** restack 계획 한 단계와 사용자 preview에 필요한 안전 정보 */
export interface PullRequestStackRestackStep {
  branch: string;
  parentBranch: string;
  beforeHead: string;
  oldParentHead: string;
  previewParentHead: string;
  parentTargetHash?: string;
  inferredBoundary: boolean;
  action: "record" | "rebase";
}
/** 실행 전 확인 화면과 실제 executor가 공유하는 연쇄 restack 계획 */
export interface PullRequestStackRestackPlan {
  repoRoot: string;
  operationId: string;
  steps: PullRequestStackRestackStep[];
  postAction?: PullRequestStackRestackPostAction;
}
/** restack 실행/Continue 결과 */
export type PullRequestStackRestackResult =
  | {
      status: "completed";
      repoRoot: string;
      operationId: string;
      rewrittenBranches: string[];
      backupRefs: string[];
      postAction?: PullRequestStackRestackPostAction;
    }
  | {
      status: "conflicts";
      repoRoot: string;
      operationId: string;
      branch: string;
      worktreePath: string;
      conflictFiles: string[];
      completedBranches: string[];
    }
  | { status: "none" };
interface RestackMetadataCheckpoint {
  branch: string;
  parentBranch?: string;
  parentHead?: string;
}
interface PendingRestackStep extends PullRequestStackRestackStep {
  snapshotRef: string;
  afterHead?: string;
  worktreePath?: string;
  temporaryWorktree?: boolean;
}
interface PendingPullRequestStackRestack {
  version: number;
  repoRoot: string;
  operationId: string;
  index: number;
  status: "running" | "conflicts";
  steps: PendingRestackStep[];
  metadataBefore: RestackMetadataCheckpoint[];
  rewrittenBranches: string[];
  postAction?: PullRequestStackRestackPostAction;
  createdAt: number;
}
/** PR stack 연쇄 rebase의 plan과 실행 상태를 관리하는 서비스 */
export class PullRequestStackRestackService {
  private readonly metadata: PullRequestStackMetadataService;
  constructor(public readonly repoRoot: string) {
    this.metadata = new PullRequestStackMetadataService(repoRoot);
  }
  /** Continue/Abort를 기다리는 stack restack state가 common git dir에 있는지 확인한다. */
  async hasPendingRestack(): Promise<boolean> {
    return Boolean(await readPendingState(this.repoRoot));
  }
  /**
   * 선택 layer와 모든 descendant를 parent 우선 순서로 restack하는 preview 계획을 만든다.
   * - rootBranch가 없으면 메타데이터가 있는 모든 stack layer를 대상으로 한다.
   * - parent 기록이 없는 imported layer는 merge-base를 경계로 추론하고 preview에 표시한다.
   * @param rootBranch 선택한 subtree root branch
   * @param overrides Advance가 직접 child의 새 parent/목표 OID를 지정할 때 쓸 관계 map
   * @param postAction 완료 뒤 submit/cleanup 같은 후속 동작
   * @returns stale ref 검증에 필요한 시작 HEAD가 고정된 실행 계획
   */
  async createPlan(
    rootBranch?: string | string[],
    overrides: Readonly<Record<string, PullRequestStackParentOverride>> = {},
    postAction?: PullRequestStackRestackPostAction
  ): Promise<PullRequestStackRestackPlan> {
    const branches = await this.metadata.listBranches();
    const selected = selectRestackBranches(branches, rootBranch);
    if (!selected.length) {
      throw new Error(rootBranch
        ? `The selected branch is not part of a local pull request stack.`
        : "No local pull request stack layers were found.");
    }
    const planned = new Set(selected.map((branch) => branch.name));
    const steps: PullRequestStackRestackStep[] = [];
    for (const branch of selected) {
      const override = overrides[branch.name];
      const parentBranch = override?.parentBranch || branch.parentBranch;
      if (!parentBranch) {
        continue;
      }
      const previewParentHead = override?.parentTargetHash
        || await this.metadata.resolveBranchHead(parentBranch);
      const boundary = override?.oldParentHead
        ? { hash: await this.resolveCommit(override.oldParentHead), inferred: false }
        : await this.resolveOldParentBoundary(branch, previewParentHead);
      const parentWillMove = planned.has(parentBranch)
        && steps.some((step) => step.branch === parentBranch && step.action === "rebase");
      const parentAlreadyAncestor = await this.isAncestor(previewParentHead, branch.hash);
      steps.push({
        branch: branch.name,
        parentBranch,
        beforeHead: branch.hash,
        oldParentHead: boundary.hash,
        previewParentHead,
        parentTargetHash: override?.parentTargetHash,
        inferredBoundary: boundary.inferred,
        action: !parentWillMove && parentAlreadyAncestor ? "record" : "rebase",
      });
    }
    return {
      repoRoot: this.repoRoot,
      operationId: makeOperationId(),
      steps,
      postAction,
    };
  }
  /**
   * 확인이 끝난 계획에 backup ref와 pending state를 만든 뒤 충돌 또는 완료까지 실행한다.
   * @param plan createPlan이 만든 immutable 실행 계획
   * @returns 완료 요약 또는 Conflicts view로 연결할 worktree/파일 정보
   */
  async execute(
    plan: PullRequestStackRestackPlan
  ): Promise<PullRequestStackRestackResult> {
    if (path.resolve(plan.repoRoot) !== path.resolve(this.repoRoot)) {
      throw new Error("Restack plan belongs to a different repository.");
    }
    if (await readPendingState(this.repoRoot)) {
      throw new Error("Another pull request stack restack is waiting for Continue or Abort.");
    }
    await this.assertPlanStillCurrent(plan);
    await this.assertOwnedWorktreesClean(plan.steps.map((step) => step.branch));
    const branches = await this.metadata.listBranches();
    const metadataBefore = plan.steps.map((step) => {
      const branch = branches.find((item) => item.name === step.branch);
      return {
        branch: step.branch,
        parentBranch: branch?.parentBranch,
        parentHead: branch?.parentHead,
      };
    });
    const steps = await Promise.all(plan.steps.map(async (step) => ({
      ...step,
      snapshotRef: await this.createBackupRef(plan.operationId, step.branch, step.beforeHead),
    })));
    const state: PendingPullRequestStackRestack = {
      version: STATE_VERSION,
      repoRoot: this.repoRoot,
      operationId: plan.operationId,
      index: 0,
      status: "running",
      steps,
      metadataBefore,
      rewrittenBranches: [],
      postAction: plan.postAction,
      createdAt: Date.now(),
    };
    await writePendingState(this.repoRoot, state);
    try {
      await this.applyPlannedParentOverrides(state);
      return await this.runRemaining(state);
    } catch (error) {
      await this.rollbackFailedExecution(state).catch(() => undefined);
      throw error;
    }
  }

  /**
   * generic Conflicts Continue/Skip이 현재 rebase를 끝낸 뒤 남은 stack layer를 이어 실행한다.
   * @returns stack pending이 없으면 none, 다음 충돌 또는 전체 완료 결과
   */
  async resumeAfterContinue(): Promise<PullRequestStackRestackResult> {
    const state = await readPendingState(this.repoRoot);
    if (!state) {
      return { status: "none" };
    }
    const executor = path.resolve(state.repoRoot) === path.resolve(this.repoRoot) ? this : new PullRequestStackRestackService(state.repoRoot);
    const step = state.steps[state.index];
    if (!step?.worktreePath) {
      throw new Error("Pending stack restack worktree is missing.");
    }
    if (await executor.isConflictState(step.worktreePath)) {
      return executor.conflictResult(state, step);
    }
    await executor.finishStep(state, step, step.worktreePath);
    state.index++;
    state.status = "running";
    await writePendingState(state.repoRoot, state);
    return executor.runRemaining(state);
  }

  /**
   * generic Conflicts Abort가 현재 rebase를 중단한 뒤 앞서 끝난 layer와 메타데이터를 복원한다.
   * @returns 실제 stack pending을 정리했으면 원래 Graph 저장소 루트
   */
  async restoreAfterAbort(): Promise<string | undefined> {
    const state = await readPendingState(this.repoRoot);
    if (!state) {
      return undefined;
    }
    const executor = path.resolve(state.repoRoot) === path.resolve(this.repoRoot) ? this : new PullRequestStackRestackService(state.repoRoot);
    await executor.rollbackState(state);
    return state.repoRoot;
  }

  /** pending plan의 현재 단계부터 순서대로 실행한다. */
  private async runRemaining(
    state: PendingPullRequestStackRestack
  ): Promise<PullRequestStackRestackResult> {
    while (state.index < state.steps.length) {
      const step = state.steps[state.index];
      const currentParent = step.parentTargetHash
        || await this.metadata.resolveBranchHead(step.parentBranch);
      const currentBranch = await this.resolveCommit(`refs/heads/${step.branch}`);
      if (currentBranch !== step.beforeHead) {
        throw new Error(
          `Branch '${step.branch}' moved after the restack preview. Refresh and preview again.`
        );
      }
      if (await this.isAncestor(currentParent, currentBranch)) {
        await this.metadata.updateParentHead(step.branch, currentParent);
        step.afterHead = currentBranch;
        state.index++;
        await writePendingState(this.repoRoot, state);
        continue;
      }
      const worktree = await this.acquireBranchWorktree(step.branch);
      step.worktreePath = worktree.path;
      step.temporaryWorktree = worktree.temporary;
      state.status = "running";
      await writePendingState(this.repoRoot, state);
      try {
        await runGit(
          ["rebase", "--onto", currentParent, step.oldParentHead],
          worktree.path,
          { env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", HUSKY: "0" } }
        );
      } catch (error) {
        if (await this.isConflictState(worktree.path)) {
          state.status = "conflicts";
          await writePendingState(this.repoRoot, state);
          return this.conflictResult(state, step);
        }
        throw error;
      }
      await this.finishStep(state, step, worktree.path, currentParent);
      state.index++;
      await writePendingState(this.repoRoot, state);
    }
    const result: PullRequestStackRestackResult = {
      status: "completed",
      repoRoot: state.repoRoot,
      operationId: state.operationId,
      rewrittenBranches: [...state.rewrittenBranches],
      backupRefs: state.steps.map((step) => step.snapshotRef),
      postAction: state.postAction,
    };
    await clearPendingState(this.repoRoot);
    return result;
  }

  /** 성공한 현재 단계의 HEAD/parent 기록을 확정하고 임시 worktree를 정리한다. */
  private async finishStep(
    state: PendingPullRequestStackRestack,
    step: PendingRestackStep,
    worktreePath: string,
    knownParentHead?: string
  ): Promise<void> {
    const afterHead = await this.resolveCommitIn(worktreePath, "HEAD");
    const parentHead = knownParentHead
      || step.parentTargetHash
      || await this.metadata.resolveBranchHead(step.parentBranch);
    step.afterHead = afterHead;
    if (afterHead !== step.beforeHead && !state.rewrittenBranches.includes(step.branch)) {
      state.rewrittenBranches.push(step.branch);
    }
    await this.metadata.updateParentHead(step.branch, parentHead);
    if (step.temporaryWorktree) {
      await this.removeTemporaryWorktree(worktreePath);
      step.worktreePath = undefined;
      step.temporaryWorktree = false;
    }
  }

  /** plan의 parent override를 실행 전에 config에 반영하되 rollback checkpoint는 그대로 보존한다. */
  private async applyPlannedParentOverrides(
    state: PendingPullRequestStackRestack
  ): Promise<void> {
    for (const step of state.steps) {
      const before = state.metadataBefore.find((item) => item.branch === step.branch);
      if (before?.parentBranch !== step.parentBranch) {
        await this.metadata.setParent(step.branch, step.parentBranch, step.oldParentHead);
      }
    }
  }

  /** branch별 시작 HEAD와 parent 경계가 preview 이후 움직이지 않았는지 검사한다. */
  private async assertPlanStillCurrent(plan: PullRequestStackRestackPlan): Promise<void> {
    for (const step of plan.steps) {
      const current = await this.resolveCommit(`refs/heads/${step.branch}`);
      if (current !== step.beforeHead) {
        throw new Error(`Branch '${step.branch}' changed after preview.`);
      }
      await this.resolveCommit(step.oldParentHead);
    }
  }

  /** 계획 대상 branch를 checkout한 기존 worktree가 모두 clean인지 preflight한다. */
  private async assertOwnedWorktreesClean(branches: string[]): Promise<void> {
    const targets = new Set(branches);
    const worktrees = await new WorktreeService(this.repoRoot).listWorktrees();
    for (const worktree of worktrees) {
      if (!worktree.branch || !targets.has(worktree.branch)) {
        continue;
      }
      const status = await runGit(
        ["status", "--porcelain=v1", "--untracked-files=all"],
        worktree.path
      );
      if (status) {
        throw new Error(
          `Worktree '${worktree.path}' for '${worktree.branch}' has local changes. Commit or stash them before restacking.`
        );
      }
      if (await detectOperation(worktree.path) !== "none") {
        throw new Error(`Worktree '${worktree.path}' already has a Git operation in progress.`);
      }
    }
  }

  /** branch를 checkout한 기존 worktree를 재사용하거나 clean 임시 linked worktree를 만든다. */
  private async acquireBranchWorktree(
    branch: string
  ): Promise<{ path: string; temporary: boolean }> {
    const worktrees = await new WorktreeService(this.repoRoot).listWorktrees();
    const existing = worktrees.find((item) => item.branch === branch);
    if (existing) {
      return { path: existing.path, temporary: false };
    }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_WORKTREE_PREFIX));
    await fs.rm(directory, { recursive: true, force: true });
    await runGit(["worktree", "add", directory, branch], this.repoRoot);
    return { path: directory, temporary: true };
  }

  /** 임시 linked worktree의 Git 메타데이터와 디렉터리를 함께 정리한다. */
  private async removeTemporaryWorktree(worktreePath: string): Promise<void> {
    await runGit(["worktree", "remove", "--force", worktreePath], this.repoRoot)
      .catch(async () => {
        await fs.rm(worktreePath, { recursive: true, force: true });
        await runGit(["worktree", "prune"], this.repoRoot).catch(() => undefined);
      });
  }

  /** 현재 pending step의 충돌 파일 목록을 읽어 UI 연결 결과를 만든다. */
  private async conflictResult(
    state: PendingPullRequestStackRestack,
    step: PendingRestackStep
  ): Promise<PullRequestStackRestackResult> {
    const conflictFiles = step.worktreePath
      ? (await runGit(
          ["diff", "--name-only", "--diff-filter=U"],
          step.worktreePath
        ).catch(() => "")).split(/\r?\n/).filter(Boolean)
      : [];
    return {
      status: "conflicts",
      repoRoot: state.repoRoot,
      operationId: state.operationId,
      branch: step.branch,
      worktreePath: step.worktreePath || this.repoRoot,
      conflictFiles,
      completedBranches: state.steps.slice(0, state.index).map((item) => item.branch),
    };
  }

  /** 실행 중 비충돌 오류가 나면 가능한 범위에서 snapshot과 메타데이터를 되돌린다. */
  private async rollbackFailedExecution(
    state: PendingPullRequestStackRestack
  ): Promise<void> {
    const step = state.steps[state.index];
    if (step?.worktreePath && await detectOperation(step.worktreePath) === "rebase") {
      await runGit(["rebase", "--abort"], step.worktreePath).catch(() => undefined);
    }
    await this.rollbackState(state);
  }

  /** 완료된 layer를 역순으로 backup ref에 복원하고 임시 worktree/config/state를 정리한다. */
  private async rollbackState(state: PendingPullRequestStackRestack): Promise<void> {
    const worktrees = await new WorktreeService(this.repoRoot).listWorktrees();
    for (const step of [...state.steps].reverse()) {
      const current = await this.resolveCommit(`refs/heads/${step.branch}`);
      const snapshot = await this.resolveCommit(step.snapshotRef);
      if (current !== snapshot) {
        await this.restoreBranch(step.branch, snapshot, current, worktrees);
      }
      if (step.temporaryWorktree && step.worktreePath) {
        await this.removeTemporaryWorktree(step.worktreePath).catch(() => undefined);
      }
    }
    for (const checkpoint of state.metadataBefore) {
      await this.metadata.restoreParent(
        checkpoint.branch,
        checkpoint.parentBranch,
        checkpoint.parentHead
      );
    }
    await clearPendingState(this.repoRoot);
  }

  /** branch를 checkout한 worktree는 clean reset, 미점유 branch는 CAS update-ref로 복원한다. */
  private async restoreBranch(
    branch: string,
    snapshot: string,
    current: string,
    worktrees: WorktreeInfo[]
  ): Promise<void> {
    const owner = worktrees.find((item) => item.branch === branch);
    if (!owner) {
      await runGit(["update-ref", `refs/heads/${branch}`, snapshot, current], this.repoRoot);
      return;
    }
    const status = await runGit(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      owner.path
    );
    if (status) {
      throw new Error(`Cannot restore '${branch}': worktree '${owner.path}' has new local changes.`);
    }
    await runGit(["reset", "--hard", snapshot], owner.path);
  }

  /** branch의 기록된 parent head가 없을 때 안전한 조상 경계를 계산한다. */
  private async resolveOldParentBoundary(
    branch: StackLocalBranch,
    currentParentHead: string
  ): Promise<{ hash: string; inferred: boolean }> {
    if (branch.parentHead) {
      return { hash: await this.resolveCommit(branch.parentHead), inferred: false };
    }
    const mergeBase = (await runGit(
      ["merge-base", currentParentHead, branch.hash],
      this.repoRoot
    )).trim();
    if (!mergeBase) {
      throw new Error(`Could not infer the old parent boundary for '${branch.name}'.`);
    }
    return { hash: mergeBase, inferred: true };
  }

  /** operation 시작 전 branch HEAD를 backup namespace에 저장한다. */
  private async createBackupRef(
    operationId: string,
    branch: string,
    head: string
  ): Promise<string> {
    const ref = `refs/gitsimplecompare/stack-backups/${operationId}/${branch}`;
    await runGit(["update-ref", ref, head], this.repoRoot);
    return ref;
  }

  /** 지정 commit이 target commit의 조상인지 exit status로 확인한다. */
  private async isAncestor(ancestor: string, target: string): Promise<boolean> {
    return runGit(["merge-base", "--is-ancestor", ancestor, target], this.repoRoot)
      .then(() => true, () => false);
  }

  /** worktree에 rebase 또는 unmerged index가 남아 있는지 확인한다. */
  private async isConflictState(worktreePath: string): Promise<boolean> {
    const [operation, unmerged] = await Promise.all([
      detectOperation(worktreePath),
      runGit(["diff", "--name-only", "--diff-filter=U", "-z"], worktreePath)
        .catch(() => ""),
    ]);
    return operation === "rebase" || Boolean(unmerged);
  }

  /** 현재 저장소에서 commit-ish를 전체 OID로 해석한다. */
  private async resolveCommit(ref: string): Promise<string> {
    return this.resolveCommitIn(this.repoRoot, ref);
  }

  /** 지정 worktree에서 commit-ish를 전체 OID로 해석한다. */
  private async resolveCommitIn(worktreePath: string, ref: string): Promise<string> {
    return (await runGit(
      ["rev-parse", "--verify", `${ref}^{commit}`],
      worktreePath
    )).trim();
  }
}

/** parent 관계를 기준으로 선택 root와 descendant를 부모 우선 순서로 반환한다. */
function selectRestackBranches(
  branches: StackLocalBranch[],
  rootBranch?: string | string[]
): StackLocalBranch[] {
  const stackBranches = branches.filter((branch) => branch.parentBranch);
  const children = new Map<string, StackLocalBranch[]>();
  for (const branch of stackBranches) {
    const list = children.get(branch.parentBranch!) || [];
    list.push(branch);
    list.sort((left, right) => left.name.localeCompare(right.name));
    children.set(branch.parentBranch!, list);
  }
  const requestedRoots = typeof rootBranch === "string" ? [rootBranch] : rootBranch;
  const roots = requestedRoots
    ? stackBranches.filter((branch) => requestedRoots.includes(branch.name))
    : stackBranches.filter((branch) => !stackBranches.some((item) => item.name === branch.parentBranch));
  const output: StackLocalBranch[] = [];
  const visited = new Set<string>();
  const visit = (branch: StackLocalBranch): void => {
    if (visited.has(branch.name)) return;
    visited.add(branch.name);
    output.push(branch);
    for (const child of children.get(branch.name) || []) visit(child);
  };
  for (const root of roots) visit(root);
  return output;
}

/** 날짜와 난수로 backup ref/state에서 충돌하지 않는 operation ID를 만든다. */
function makeOperationId(): string {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}
/** common git dir 아래 pending state 파일 절대 경로를 계산한다. */
async function pendingStatePath(repoRoot: string): Promise<string> {
  const common = (await runGit(["rev-parse", "--git-common-dir"], repoRoot)).trim();
  return path.resolve(repoRoot, common, STATE_RELATIVE_PATH);
}
/** pending JSON을 검증해 현재 버전 state로 읽는다. */
async function readPendingState(
  repoRoot: string
): Promise<PendingPullRequestStackRestack | undefined> {
  const file = await pendingStatePath(repoRoot);
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as PendingPullRequestStackRestack;
    return value?.version === STATE_VERSION
      && typeof value.repoRoot === "string"
      && Array.isArray(value.steps)
      && Number.isInteger(value.index)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
/** pending state를 임시 파일+rename으로 원자적으로 교체한다. */
async function writePendingState(
  repoRoot: string,
  state: PendingPullRequestStackRestack
): Promise<void> {
  const file = await pendingStatePath(repoRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}
/** 완료/abort 뒤 pending state 파일을 제거한다. */
async function clearPendingState(repoRoot: string): Promise<void> {
  await fs.rm(await pendingStatePath(repoRoot), { force: true });
}
