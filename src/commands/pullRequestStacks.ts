// Git Graph의 PR stack Add/Restack/Submit/Advance 사용자 흐름을 조립하는 명령 모듈.
// - git/GitHub mutation은 stack 서비스에 위임하고 이 파일은 선택, preview 확인, 진행/결과 안내만 담당한다.
import * as path from "node:path";
import * as vscode from "vscode";
import { tryAcquireConflictMutation } from "../git/conflictMutationCoordinator";
import { runGit } from "../git/gitExec";
import { PullRequestStackAdvanceService } from "../git/pullRequestStackAdvanceService";
import { PullRequestStackMetadataService } from "../git/pullRequestStackMetadata";
import {
  PullRequestStackRestackService,
  type PullRequestStackRestackPlan,
  type PullRequestStackRestackPostAction,
  type PullRequestStackRestackResult,
} from "../git/pullRequestStackRestack";
import { PullRequestStackService } from "../git/pullRequestStackService";
import { PullRequestStackSubmitService } from "../git/pullRequestStackSubmitService";
import type { StackLocalBranch } from "../git/pullRequestStackModel";
import { logError, logInfo } from "../ui/outputLog";
import { GitGraphPanel } from "../webview/graphPanel";
import { discoverRepositories, type CommandDeps } from "./shared";

/** Graph row와 Command Palette가 stack 동작에 전달하는 최소 컨텍스트 */
export interface PullRequestStackCommandArg {
  repoRoot?: string;
  /** 선택 layer branch. Add Layer에서는 기본 parent로 사용한다. */
  branch?: string;
  /** Add Layer가 사용할 명시 parent branch */
  parentBranch?: string;
  /** remote-only PR 위에 layer를 만들 때 사용할 parent commit OID */
  parentHash?: string;
}

/**
 * 선택한 parent tip에서 새 child branch를 만들고 선택적으로 linked worktree를 함께 만든다.
 * @param deps 명령 공용 저장소 탐지 의존성
 * @param arg Graph에서 전달한 저장소/parent 문맥
 */
export async function addPullRequestStackLayer(
  deps: CommandDeps,
  arg?: PullRequestStackCommandArg
): Promise<void> {
  const repoRoot = await resolveRepoRoot(deps, arg?.repoRoot);
  if (!repoRoot) return;
  const metadata = new PullRequestStackMetadataService(repoRoot);
  try {
    if (!await ensureNoPendingRestack(repoRoot)) return;
    const branches = await metadata.listBranches();
    const parentBranch = arg?.parentBranch || arg?.branch || await pickParentBranch(repoRoot, branches);
    if (!parentBranch) return;
    const parentRef = arg?.parentHash || await metadata.resolveBranchHead(parentBranch);
    const branch = await vscode.window.showInputBox({
      title: vscode.l10n.t("Add Pull Request Stack Layer"),
      prompt: vscode.l10n.t("New child branch above '{0}'", parentBranch),
      placeHolder: "feature/next-layer",
      validateInput: async (value) => validateNewBranch(metadata, branches, value),
    });
    if (!branch) return;
    const mode = await vscode.window.showQuickPick([
      {
        label: vscode.l10n.t("$(multiple-windows) Create Linked Worktree"),
        description: vscode.l10n.t("recommended; start editing the new layer separately"),
        worktree: true,
      },
      {
        label: vscode.l10n.t("$(git-branch) Create Branch Only"),
        description: vscode.l10n.t("keep the current checkout unchanged"),
        worktree: false,
      },
    ], {
      title: vscode.l10n.t("Add Pull Request Stack Layer"),
      placeHolder: vscode.l10n.t("Choose how to create '{0}'", branch),
    });
    if (!mode) return;
    const worktreePath = mode.worktree
      ? await pickWorktreePath(repoRoot, branch)
      : undefined;
    if (mode.worktree && !worktreePath) return;
    const create = vscode.l10n.t("Create Layer");
    const confirmed = await vscode.window.showInformationMessage(
      worktreePath
        ? vscode.l10n.t("Create '{0}' above '{1}' in linked worktree '{2}'?", branch, parentBranch, worktreePath)
        : vscode.l10n.t("Create branch '{0}' above '{1}'?", branch, parentBranch),
      { modal: true },
      create
    );
    if (confirmed !== create) return;
    const release = acquireStackMutation(repoRoot);
    if (!release) return;
    try {
      await metadata.createLayer({ branch, parentBranch, parentRef, worktreePath });
    } finally {
      release();
    }
    logInfo("pull request stack layer created", {
      repoRoot, branch, parentBranch, parentRef, worktreePath,
    });
    refreshStackSurfaces(repoRoot, "stackLayerCreated");
    if (worktreePath) {
      const open = vscode.l10n.t("Open Worktree");
      const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t("Stack layer '{0}' was created.", branch),
        open
      );
      if (choice === open) {
        await vscode.commands.executeCommand(
          "vscode.openFolder",
          vscode.Uri.file(worktreePath),
          { forceNewWindow: true }
        );
      }
    } else {
      vscode.window.showInformationMessage(
        vscode.l10n.t("Stack layer '{0}' was created above '{1}'.", branch, parentBranch)
      );
    }
  } catch (error) {
    showStackError("pull request stack layer creation failed", error, { repoRoot });
  }
}

/**
 * 선택 layer와 descendants의 연쇄 rebase 계획을 preview한 뒤 안전 snapshot 아래 실행한다.
 * @param deps 명령 공용 의존성
 * @param arg Graph에서 전달한 선택 layer
 */
export async function restackPullRequestStack(
  deps: CommandDeps,
  arg?: PullRequestStackCommandArg
): Promise<void> {
  const repoRoot = await resolveRepoRoot(deps, arg?.repoRoot);
  if (!repoRoot) return;
  try {
    if (!await ensureNoPendingRestack(repoRoot)) return;
    const branch = arg?.branch || await pickStackBranch(repoRoot, vscode.l10n.t("Select the first layer to restack"));
    if (!branch) return;
    const service = new PullRequestStackRestackService(repoRoot);
    const plan = await service.createPlan(branch);
    if (!await confirmRestackPlan(plan, vscode.l10n.t("Restack"))) return;
    logInfo("pull request stack restack confirmed", {
      repoRoot,
      operationId: plan.operationId,
      steps: plan.steps.map((step) => ({
        branch: step.branch,
        parentBranch: step.parentBranch,
        action: step.action,
        inferredBoundary: step.inferredBoundary,
      })),
    });
    const release = acquireStackMutation(repoRoot);
    if (!release) return;
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Restacking pull request stack..."),
      }, () => service.execute(plan));
      await presentRestackResult(repoRoot, result);
    } finally {
      release();
    }
  } catch (error) {
    showStackError("pull request stack restack failed", error, { repoRoot, branch: arg?.branch });
  }
}

/**
 * 선택 branch가 속한 stack을 root→leaf 순서로 push하고 PR/base/body를 동기화한다.
 * @param deps 명령 공용 의존성
 * @param arg Graph에서 전달한 선택 layer
 */
export async function submitPullRequestStack(
  deps: CommandDeps,
  arg?: PullRequestStackCommandArg
): Promise<void> {
  const repoRoot = await resolveRepoRoot(deps, arg?.repoRoot);
  if (!repoRoot) return;
  try {
    if (!await ensureNoPendingRestack(repoRoot)) return;
    const branch = arg?.branch || await pickStackBranch(repoRoot, vscode.l10n.t("Select a stack to submit or sync"));
    if (!branch) return;
    const remote = await pickRemote(repoRoot);
    if (!remote) return;
    const draft = await pickDraftMode();
    if (draft === undefined) return;
    const submit = vscode.l10n.t("Submit / Sync");
    const confirmed = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Push stack '{0}' to '{1}' in dependency order, create or update its pull requests, and refresh the stack section in every PR body? Rewritten remote branches use force-with-lease.",
        branch,
        remote
      ),
      { modal: true },
      submit
    );
    if (confirmed !== submit) return;
    logInfo("pull request stack submit confirmed", { repoRoot, branch, remote, draft });
    const release = acquireStackMutation(repoRoot);
    if (!release) return;
    let result: Awaited<ReturnType<PullRequestStackSubmitService["submit"]>>;
    try {
      result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Submitting pull request stack..."),
      }, () => new PullRequestStackSubmitService(repoRoot).submit({ branch, remote, draft }));
    } finally {
      release();
    }
    logInfo("pull request stack submitted", {
      repoRoot,
      remote,
      layers: result.layers.map((layer) => ({ branch: layer.branch, push: layer.push, pr: layer.pullRequestNumber })),
    });
    refreshStackSurfaces(repoRoot, "stackSubmitted");
    const created = result.layers.filter((layer) => layer.createdPullRequest).length;
    const forced = result.layers.filter((layer) => layer.push === "force-with-lease").length;
    vscode.window.showInformationMessage(
      vscode.l10n.t(
        "Stack synced: {0} layer(s), {1} new PR(s), {2} force-with-lease push(es).",
        result.layers.length,
        created,
        forced
      )
    );
  } catch (error) {
    showStackError("pull request stack submit failed", error, { repoRoot, branch: arg?.branch });
  }
}

/**
 * merged layer의 direct child를 이전 base로 승격하고 restack→Submit/Sync→cleanup 제안을 이어 간다.
 * @param deps 명령 공용 의존성
 * @param arg Graph에서 전달한 merged layer
 */
export async function advancePullRequestStack(
  deps: CommandDeps,
  arg?: PullRequestStackCommandArg
): Promise<void> {
  const repoRoot = await resolveRepoRoot(deps, arg?.repoRoot);
  if (!repoRoot) return;
  try {
    if (!await ensureNoPendingRestack(repoRoot)) return;
    const service = new PullRequestStackAdvanceService(repoRoot);
    const branch = arg?.branch || await pickAdvanceCandidate(service);
    if (!branch) return;
    const remote = await pickRemote(repoRoot);
    if (!remote) return;
    const advance = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Preparing stack advance..."),
    }, () => service.createPlan(branch, remote));
    if (!await confirmAdvancePlan(advance.restack, advance.mergedPullRequest.number, advance.previousParentBranch)) return;
    logInfo("pull request stack advance confirmed", {
      repoRoot,
      mergedBranch: advance.mergedBranch,
      mergedPullRequest: advance.mergedPullRequest.number,
      previousParentBranch: advance.previousParentBranch,
      promotedBranches: advance.promotedBranches,
      operationId: advance.restack.operationId,
    });
    const release = acquireStackMutation(repoRoot);
    if (!release) return;
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Advancing pull request stack..."),
      }, () => new PullRequestStackRestackService(repoRoot).execute(advance.restack));
      await presentRestackResult(repoRoot, result);
      if (result.status === "completed" && result.postAction) {
        await completeAdvancePostAction(repoRoot, result.postAction);
      }
    } finally {
      release();
    }
  } catch (error) {
    showStackError("pull request stack advance failed", error, { repoRoot, branch: arg?.branch });
  }
}

/**
 * Advance restack 완료 뒤 promoted PR을 자동 동기화하고 merged branch/worktree 정리를 제안한다.
 * - 충돌 후 generic Continue 경로도 이 함수를 재사용한다.
 * @param repoRoot 대상 저장소 또는 linked worktree 루트
 * @param postAction pending restack state에 저장된 Advance 정보
 */
export async function completeAdvancePostAction(
  repoRoot: string,
  postAction: PullRequestStackRestackPostAction
): Promise<void> {
  const service = new PullRequestStackAdvanceService(repoRoot);
  const synced = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: vscode.l10n.t("Syncing promoted pull requests..."),
  }, () => service.syncPromotedStacks(postAction, true));
  logInfo("pull request stack advance synced", {
    repoRoot,
    mergedBranch: synced.mergedBranch,
    promotedBranches: synced.promotedBranches,
  });
  const preview = await service.getCleanupPreview(postAction.mergedBranch);
  if (preview.canAutoCleanup) {
    const cleanup = vscode.l10n.t("Remove Merged Layer");
    const detail = preview.worktreePath
      ? vscode.l10n.t(" This also removes linked worktree '{0}'.", preview.worktreePath)
      : "";
    const confirmed = await vscode.window.showWarningMessage(
      vscode.l10n.t("Remove merged local branch '{0}'?{1}", postAction.mergedBranch, detail),
      { modal: true },
      cleanup
    );
    if (confirmed === cleanup) {
      const result = await service.cleanupMergedLayer(postAction.mergedBranch);
      logInfo("merged pull request stack layer cleaned", { repoRoot, ...result });
    }
  } else if (preview.reason) {
    vscode.window.showInformationMessage(
      vscode.l10n.t("Promoted PRs were synced. Merged layer was kept: {0}", preview.reason)
    );
  }
  refreshStackSurfaces(repoRoot, "stackAdvanced");
}

/** stack rebase 완료/충돌 결과를 Graph와 Conflicts view에 반영한다. */
async function presentRestackResult(
  repoRoot: string,
  result: PullRequestStackRestackResult
): Promise<void> {
  if (result.status === "conflicts") {
    logInfo("pull request stack restack paused", {
      repoRoot,
      branch: result.branch,
      worktreePath: result.worktreePath,
      conflicts: result.conflictFiles,
    });
    if (result.conflictFiles[0]) {
      await vscode.commands.executeCommand("gitSimpleCompare.openConflictEditor", {
        root: result.worktreePath,
        path: result.conflictFiles[0],
      });
    }
    await vscode.commands.executeCommand("gitSimpleCompare.refreshConflicts");
    await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Restack paused on '{0}'. Resolve conflicts in '{1}', then Continue or Abort. Remaining layers continue automatically.",
        result.branch,
        result.worktreePath
      )
    );
    return;
  }
  if (result.status === "completed") {
    logInfo("pull request stack restack completed", {
      repoRoot,
      operationId: result.operationId,
      rewrittenBranches: result.rewrittenBranches,
      backupRefs: result.backupRefs,
    });
    refreshStackSurfaces(repoRoot, "stackRestacked");
    vscode.window.showInformationMessage(
      result.rewrittenBranches.length
        ? vscode.l10n.t("Restacked {0} layer(s). Safety refs were kept under refs/gitsimplecompare/stack-backups/.", result.rewrittenBranches.length)
        : vscode.l10n.t("The stack already matches its current parent branches.")
    );
  }
}

/** 계획의 old→new parent 경계와 추론 경고를 modal preview 문자열로 만든다. */
async function confirmRestackPlan(
  plan: PullRequestStackRestackPlan,
  action: string
): Promise<boolean> {
  const inferredLabel = vscode.l10n.t("inferred boundary");
  const lines = plan.steps.map((step) =>
    `${step.action === "rebase" ? "↻" : "✓"} ${step.branch}: ${step.parentBranch} ` +
    `${shortHash(step.oldParentHead)} → ${shortHash(step.previewParentHead)}` +
    `${step.inferredBoundary ? ` (${inferredLabel})` : ""}`
  );
  const inferred = plan.steps.some((step) => step.inferredBoundary)
    ? vscode.l10n.t("\n\nAt least one old parent boundary was inferred from merge-base. Review it carefully.")
    : "";
  const confirmed = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Run this stack plan? A backup ref is created for every layer before history is rewritten.\n\n{0}{1}",
      lines.join("\n"),
      inferred
    ),
    { modal: true },
    action
  );
  return confirmed === action;
}

/** Advance 관계 변경과 restack plan을 한 확인창에서 보여 준다. */
async function confirmAdvancePlan(
  plan: PullRequestStackRestackPlan,
  pullRequestNumber: number,
  parentBranch: string
): Promise<boolean> {
  const action = vscode.l10n.t("Advance Stack");
  const promoted = plan.steps.filter((step) => step.parentBranch === parentBranch)
    .map((step) => step.branch).join(", ");
  const confirmed = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "PR #{0} is merged. Promote {1} onto '{2}', restack descendants, then push and update their PR bases?",
      pullRequestNumber,
      promoted,
      parentBranch
    ),
    { modal: true },
    action
  );
  return confirmed === action;
}

/** Add Layer에서 사용할 parent를 current branch 우선으로 선택받는다. */
async function pickParentBranch(
  repoRoot: string,
  branches: StackLocalBranch[]
): Promise<string | undefined> {
  const currentBranch = await runGit(["branch", "--show-current"], repoRoot)
    .then((value) => value.trim(), () => "");
  const selected = await vscode.window.showQuickPick(
    [...branches].sort((left, right) =>
      Number(right.name === currentBranch) - Number(left.name === currentBranch)
      || left.name.localeCompare(right.name)
    ).map((branch) => ({
      label: branch.name === currentBranch ? `$(check) ${branch.name}` : `$(git-branch) ${branch.name}`,
      description: branch.parentBranch
        ? vscode.l10n.t("stacked on {0}", branch.parentBranch)
        : vscode.l10n.t("regular branch"),
      detail: branch.subject,
      branch: branch.name,
    })),
    { title: vscode.l10n.t("Add Pull Request Stack Layer"), placeHolder: vscode.l10n.t("Select the parent branch") }
  );
  return selected?.branch;
}

/** local stack layer를 사용자에게 선택받는다. */
async function pickStackBranch(repoRoot: string, placeHolder: string): Promise<string | undefined> {
  const branches = (await new PullRequestStackMetadataService(repoRoot).listBranches())
    .filter((branch) => branch.parentBranch);
  if (!branches.length) {
    vscode.window.showWarningMessage(vscode.l10n.t("No local pull request stack layers were found."));
    return undefined;
  }
  const selected = await vscode.window.showQuickPick(branches.map((branch) => ({
    label: `$(layers) ${branch.name}`,
    description: `${branch.parentBranch} ← ${branch.name}`,
    detail: branch.subject,
    branch: branch.name,
  })), { placeHolder });
  return selected?.branch;
}

/** Git remote를 origin 우선으로 선택받는다. */
async function pickRemote(repoRoot: string): Promise<string | undefined> {
  const remotes = await new PullRequestStackService(repoRoot).listRemotes();
  if (!remotes.length) {
    vscode.window.showWarningMessage(vscode.l10n.t("Add a Git remote before submitting a pull request stack."));
    return undefined;
  }
  if (remotes.length === 1) return remotes[0];
  const selected = await vscode.window.showQuickPick(
    remotes.map((remote) => ({ label: `$(cloud-upload) ${remote}`, remote })),
    { placeHolder: vscode.l10n.t("Select the GitHub remote for this stack") }
  );
  return selected?.remote;
}

/** 새로 만드는 PR의 draft 상태를 고른다. */
async function pickDraftMode(): Promise<boolean | undefined> {
  const selected = await vscode.window.showQuickPick([
    {
      label: vscode.l10n.t("$(git-pull-request-draft) Create New PRs as Draft"),
      description: vscode.l10n.t("recommended for a stack still being reviewed"),
      draft: true,
    },
    {
      label: vscode.l10n.t("$(git-pull-request) Create New PRs as Ready"),
      draft: false,
    },
  ], { placeHolder: vscode.l10n.t("Choose the state for newly created pull requests") });
  return selected?.draft;
}

/** GitHub MERGED 상태인 local layer 후보를 선택받는다. */
async function pickAdvanceCandidate(
  service: PullRequestStackAdvanceService
): Promise<string | undefined> {
  const candidates = await service.listCandidates();
  if (!candidates.length) {
    vscode.window.showWarningMessage(vscode.l10n.t("No merged stack layer with a local child was found."));
    return undefined;
  }
  const selected = await vscode.window.showQuickPick(candidates.map((candidate) => ({
    label: `$(git-merge) #${candidate.pullRequestNumber} ${candidate.branch}`,
    description: vscode.l10n.t("promote {0}", candidate.childBranches.join(", ")),
    detail: `${candidate.baseBranch} ← ${candidate.branch}`,
    branch: candidate.branch,
  })), { placeHolder: vscode.l10n.t("Select the merged layer to advance") });
  return selected?.branch;
}

/** branch 이름을 Git으로 검증하고 기존 branch 중복을 즉시 알려 준다. */
async function validateNewBranch(
  metadata: PullRequestStackMetadataService,
  branches: StackLocalBranch[],
  value: string
): Promise<string | undefined> {
  const branch = value.trim();
  if (!branch) return vscode.l10n.t("A branch name is required.");
  if (branches.some((item) => item.name === branch)) return vscode.l10n.t("Branch '{0}' already exists.", branch);
  try {
    await runGit(["check-ref-format", "--branch", branch], metadata.repoRoot);
    return undefined;
  } catch {
    return vscode.l10n.t("'{0}' is not a valid Git branch name.", branch);
  }
}

/** linked worktree 기본 경로를 제안하고 사용자가 절대 경로를 확인/수정하게 한다. */
async function pickWorktreePath(repoRoot: string, branch: string): Promise<string | undefined> {
  const safeName = branch.replace(/[^A-Za-z0-9._-]+/g, "-");
  const suggestion = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-${safeName}`);
  const value = await vscode.window.showInputBox({
    title: vscode.l10n.t("Create Linked Worktree"),
    prompt: vscode.l10n.t("Absolute path for the new stack layer worktree"),
    value: suggestion,
    validateInput: (input) => path.isAbsolute(input.trim())
      ? undefined
      : vscode.l10n.t("Enter an absolute worktree path."),
  });
  return value?.trim() || undefined;
}

/** 저장소 단위 mutation lease를 얻지 못하면 겹친 동작을 안내한다. */
function acquireStackMutation(repoRoot: string): (() => void) | undefined {
  const release = tryAcquireConflictMutation(repoRoot);
  if (!release) {
    vscode.window.showWarningMessage(vscode.l10n.t("Another Git conflict action is already running."));
  }
  return release;
}

/** pending restack 중 topology 변경이나 원격 게시가 겹치지 않도록 새 stack 동작을 막는다. */
async function ensureNoPendingRestack(repoRoot: string): Promise<boolean> {
  if (!await new PullRequestStackRestackService(repoRoot).hasPendingRestack()) {
    return true;
  }
  vscode.window.showWarningMessage(
    vscode.l10n.t("Finish or abort the current pull request stack restack first.")
  );
  return false;
}

/** Graph, PR 목록, Changes 상태를 stack mutation 뒤 최신화한다. */
function refreshStackSurfaces(repoRoot: string, reason: string): void {
  GitGraphPanel.refreshOpen(repoRoot, reason);
  void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges", { reason });
}

/** 명시 root, Changes 활성 root, workspace repository 선택 순서로 대상 저장소를 찾는다. */
async function resolveRepoRoot(
  deps: CommandDeps,
  requestedRoot?: string
): Promise<string | undefined> {
  if (requestedRoot) return requestedRoot;
  const active = deps.changesView.getActiveRepo();
  if (active) return active;
  const repositories = await discoverRepositories(deps.registry);
  if (repositories.length === 1) return repositories[0].root;
  const selected = await vscode.window.showQuickPick(
    repositories.map((repo) => ({ label: repo.root, repoRoot: repo.root })),
    { placeHolder: vscode.l10n.t("Select a repository for pull request stack action") }
  );
  return selected?.repoRoot;
}

/** stack 오류를 OUTPUT에 재현 문맥과 함께 남기고 사용자에게 짧게 표시한다. */
function showStackError(
  event: string,
  error: unknown,
  context: Record<string, unknown>
): void {
  logError(event, error, context);
  vscode.window.showErrorMessage(
    vscode.l10n.t("Pull request stack action failed: {0}", errorText(error))
  );
}

/** commit OID를 preview용 8자로 줄인다. */
function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

/** unknown 오류를 UI 문자열로 정규화한다. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
