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

/** Graph row와 Command Palette가 모든 Stack 명령에 전달하는 최소 컨텍스트 */
export interface PullRequestStackCommandArg { repoRoot?: string; branch?: string; parentBranch?: string; parentHash?: string; }

/** 선택 parent tip에서 local child layer와 선택적 linked worktree를 만든다. */
export async function addPullRequestStackLayer(deps: CommandDeps, arg?: PullRequestStackCommandArg): Promise<void> { const repoRoot=await resolveRepoRoot(deps,arg?.repoRoot); if(!repoRoot)return; const metadata=new PullRequestStackMetadataService(repoRoot); try { if(!await ensureNoPendingRestack(repoRoot))return; const branches=await metadata.listBranches(); const parentBranch=arg?.parentBranch||arg?.branch||await pickParentBranch(repoRoot,branches); if(!parentBranch)return; const parentRef=arg?.parentHash||await metadata.resolveBranchHead(parentBranch); const branch=await vscode.window.showInputBox({title:vscode.l10n.t("Add Pull Request Stack Layer"),prompt:vscode.l10n.t("New child branch above '{0}'",parentBranch),placeHolder:"feature/next-layer",validateInput:value=>validateNewBranch(metadata,branches,value)}); if(!branch)return; const mode=await vscode.window.showQuickPick([{label:vscode.l10n.t("$(multiple-windows) Create Linked Worktree"),description:vscode.l10n.t("recommended; start editing the new layer separately"),worktree:true},{label:vscode.l10n.t("$(git-branch) Create Branch Only"),description:vscode.l10n.t("keep the current checkout unchanged"),worktree:false}],{title:vscode.l10n.t("Add Pull Request Stack Layer")}); if(!mode)return; const worktreePath=mode.worktree?await pickWorktreePath(repoRoot,branch):undefined; if(mode.worktree&&!worktreePath)return; const create=vscode.l10n.t("Create Layer"); if(await vscode.window.showInformationMessage(worktreePath?vscode.l10n.t("Create '{0}' above '{1}' in linked worktree '{2}'?",branch,parentBranch,worktreePath):vscode.l10n.t("Create branch '{0}' above '{1}'?",branch,parentBranch),{modal:true},create)!==create)return; await withLease(repoRoot,()=>metadata.createLayer({branch,parentBranch,parentRef,worktreePath})); logInfo("pull request stack layer created",{repoRoot,branch,parentBranch,parentRef,worktreePath}); refreshStackSurfaces(repoRoot,"stackLayerCreated"); } catch(error){showStackError("pull request stack layer creation failed",error,{repoRoot});} }

/** 선택 layer의 local parent만 편집하고 Restack 안내를 표시한다. */
export async function editPullRequestStackParent(deps:CommandDeps,arg?:PullRequestStackCommandArg):Promise<void>{const repoRoot=await resolveRepoRoot(deps,arg?.repoRoot);if(!repoRoot)return;try{if(!await ensureNoPendingRestack(repoRoot))return;const metadata=new PullRequestStackMetadataService(repoRoot);const branches=await metadata.listBranches();const branch=arg?.branch||await pickStackBranch(repoRoot,vscode.l10n.t("Select a local Stack layer"));if(!branch)return;const current=branches.find(item=>item.name===branch);if(!current?.parentBranch){vscode.window.showWarningMessage(vscode.l10n.t("This layer has no local stack metadata to edit."));return;}const forbidden=descendantNames(branches,branch);const parent=await vscode.window.showQuickPick(branches.filter(item=>item.name!==branch&&!forbidden.has(item.name)).map(item=>({label:`$(git-branch) ${item.name}`,branch:item.name})),{title:vscode.l10n.t("Edit Stack Parent")});if(!parent)return;const action=vscode.l10n.t("Edit Local Parent");if(await vscode.window.showWarningMessage(vscode.l10n.t("Change only the local Stack parent of '{0}' from '{1}' to '{2}'? Git history and GitHub pull requests will not change. The recorded restack boundary is preserved.",branch,current.parentBranch,parent.branch),{modal:true},action)!==action)return;logInfo("pull request stack parent edit attempted",{repoRoot,branch,parent:parent.branch});await withLease(repoRoot,()=>metadata.editParent(branch,parent.branch));refreshStackSurfaces(repoRoot,"stackParentEdited");logInfo("pull request stack parent edit succeeded",{repoRoot,branch,parent:parent.branch});vscode.window.showInformationMessage(vscode.l10n.t("Local Stack parent updated. Restack, then Submit / Sync if the published PR base must follow it."));}catch(error){showStackError("pull request stack parent edit failed",error,{repoRoot});}}

/** 선택 local Stack 성분의 config 관계만 삭제한다. */
export async function deleteLocalPullRequestStack(deps:CommandDeps,arg?:PullRequestStackCommandArg):Promise<void>{const repoRoot=await resolveRepoRoot(deps,arg?.repoRoot);if(!repoRoot)return;try{if(!await ensureNoPendingRestack(repoRoot))return;const metadata=new PullRequestStackMetadataService(repoRoot);const branch=arg?.branch||await pickStackBranch(repoRoot,vscode.l10n.t("Select a local Stack layer"));if(!branch)return;const preview=await metadata.previewComponent(branch);const action=vscode.l10n.t("Delete Local Stack");if(await vscode.window.showWarningMessage(vscode.l10n.t("Delete {0} local Stack relationship(s) for: {1}? Only local Stack metadata is removed. Branches, worktrees, commits, remote branches, and pull requests are kept. Published PR stacks can remain visible.",preview.relationCount,preview.branches.join(", ")),{modal:true},action)!==action)return;logInfo("local pull request stack deletion attempted",{repoRoot,branch,relationCount:preview.relationCount});await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:vscode.l10n.t("Deleting local Stack metadata..."),cancellable:false},()=>withLease(repoRoot,()=>metadata.deleteComponent(branch)));refreshStackSurfaces(repoRoot,"localStackDeleted");logInfo("local pull request stack deletion succeeded",{repoRoot,branch,relationCount:preview.relationCount});}catch(error){showStackError("local pull request stack deletion failed",error,{repoRoot});}}

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


/** commit OID를 preview용 8자로 줄인다. */
function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

/** parent 선택, local Stack 선택, 설정 mutation과 공통 오류/새로고침을 지원한다. */
async function pickParentBranch(root:string,branches:StackLocalBranch[]):Promise<string|undefined>{const current=await runGit(["branch","--show-current"],root).then(v=>v.trim(),()=>"");const item=await vscode.window.showQuickPick(branches.map(branch=>({label:branch.name===current?`$(check) ${branch.name}`:`$(git-branch) ${branch.name}`,branch:branch.name})),{title:vscode.l10n.t("Add Pull Request Stack Layer")});return item?.branch;}
async function pickStackBranch(root:string,placeHolder:string):Promise<string|undefined>{const branches=(await new PullRequestStackMetadataService(root).listBranches()).filter(branch=>branch.parentBranch);if(!branches.length){vscode.window.showWarningMessage(vscode.l10n.t("No local pull request stack layers were found."));return undefined;}const item=await vscode.window.showQuickPick(branches.map(branch=>({label:`$(layers) ${branch.name}`,description:`${branch.parentBranch} ← ${branch.name}`,branch:branch.name})),{placeHolder});return item?.branch;}
async function validateNewBranch(metadata:PullRequestStackMetadataService,branches:StackLocalBranch[],value:string):Promise<string|undefined>{const branch=value.trim();if(!branch)return vscode.l10n.t("A branch name is required.");if(branches.some(item=>item.name===branch))return vscode.l10n.t("Branch '{0}' already exists.",branch);try{await runGit(["check-ref-format","--branch",branch],metadata.repoRoot);return undefined;}catch{return vscode.l10n.t("'{0}' is not a valid Git branch name.",branch);}}
async function pickWorktreePath(root:string,branch:string):Promise<string|undefined>{const value=await vscode.window.showInputBox({title:vscode.l10n.t("Create Linked Worktree"),value:path.join(path.dirname(root),`${path.basename(root)}-${branch.replace(/[^A-Za-z0-9._-]+/g,"-")}`),validateInput:input=>path.isAbsolute(input.trim())?undefined:vscode.l10n.t("Enter an absolute worktree path.")});return value?.trim()||undefined;}
function descendantNames(branches:StackLocalBranch[],branch:string):Set<string>{const found=new Set<string>(),pending=[branch];while(pending.length){const parent=pending.pop()!;for(const item of branches)if(item.parentBranch===parent&&!found.has(item.name)){found.add(item.name);pending.push(item.name);}}return found;}
async function ensureNoPendingRestack(root:string):Promise<boolean>{if(!await new PullRequestStackRestackService(root).hasPendingRestack())return true;logInfo("pull request stack management skipped",{repoRoot:root,reason:"pendingRestack"});vscode.window.showWarningMessage(vscode.l10n.t("Finish or abort the current pull request stack restack first."));return false;}
function acquireStackMutation(root:string):(()=>void)|undefined{const release=tryAcquireConflictMutation(root);if(!release)vscode.window.showWarningMessage(vscode.l10n.t("Another Git conflict action is already running."));return release;}
async function withLease<T>(root:string,action:()=>Promise<T>):Promise<T>{const release=acquireStackMutation(root);if(!release)throw new Error(vscode.l10n.t("Another Git conflict action is already running."));try{return await action();}finally{release();}}
function refreshStackSurfaces(root:string,reason:string):void{GitGraphPanel.refreshOpen(root,reason);void vscode.commands.executeCommand("gitSimpleCompare.refreshChanges",{reason});}
async function resolveRepoRoot(deps:CommandDeps,requested?:string):Promise<string|undefined>{if(requested)return requested;const active=deps.changesView.getActiveRepo();if(active)return active;const repositories=await discoverRepositories(deps.registry);if(repositories.length===1)return repositories[0].root;const item=await vscode.window.showQuickPick(repositories.map(repo=>({label:repo.root,repoRoot:repo.root})),{placeHolder:vscode.l10n.t("Select a repository for pull request stack action")});return item?.repoRoot;}
function showStackError(event:string,error:unknown,context:Record<string,unknown>):void{logError(event,error,context);vscode.window.showErrorMessage(vscode.l10n.t("Pull request stack action failed: {0}",error instanceof Error?error.message:String(error)));}
