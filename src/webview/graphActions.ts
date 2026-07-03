// git graph 웹뷰에서 요청한 git 액션을 처리하는 모듈.
// - 패널은 메시지 라우팅만 담당하고, checkout/branch/tag/fetch 같은 git 동작과 확인 UI 는 여기로 모은다.
import * as vscode from "vscode";
import {
  GitLogService,
  ONGOING_COMMIT_HASH,
  STAGED_COMMIT_HASH,
} from "../git/gitLogService";
import { showErrorWithOutput } from "../ui/outputLog";
import {
  focusCheckoutConflicts,
  isCheckoutConflictError,
  retryCheckoutWithConflicts,
} from "./graphCheckoutConflicts";
import {
  branchAction,
  checkoutBranch,
  checkoutRemoteBranch,
  cloneBranch,
  createBranch,
  deleteBranch,
} from "./graphBranchActions";
import { renameBranch } from "./graphBranchRename";
import { handleBranchMergeAction } from "./graphBranchMergeActions";
import { FromWebviewMessage, ToWebviewMessage } from "./graphProtocol";
import { restoreBranchFromReflog } from "./graphReflogRestoreActions";
import {
  handlePullRequestAction,
  type GraphPullRequestActionDeps,
} from "./graphPullRequestActions";
import {
  fetchAll,
  fetchTags,
  forcePushCurrent,
  openRemoteBranch,
  pullCurrent,
  pushCurrent,
} from "./graphSyncActions";
import {
  checkoutTag,
  copyTagName,
  createBranchFromTag,
  createTag,
  deleteRemoteTag,
  deleteTag,
  pushTag,
  renameTag,
  tagAction,
} from "./graphTagActions";

type GraphActionMessage = Extract<
  FromWebviewMessage,
  {
    type:
      | "fetch"
      | "fetchTags"
      | "pull"
      | "push"
      | "forcePush"
      | "openRemoteBranch"
      | "checkoutBranch"
      | "checkoutRemoteBranch"
      | "checkoutCommit"
      | "createBranch"
      | "restoreBranchFromReflog"
      | "cloneBranch"
      | "renameBranch"
      | "deleteBranch"
      | "branchAction"
      | "branchMergeAction"
      | "commitAction"
      | "undoCommit"
      | "createTag"
      | "checkoutTag"
      | "createBranchFromTag"
      | "deleteTag"
      | "deleteRemoteTag"
      | "pushTag"
      | "copyTagName"
      | "renameTag"
      | "tagAction"
      | "cherryPick"
      | "revertCommit"
      | "pullRequestAction"
      | "copyCommitHash"
      | "copyCommitMessage";
  }
>;

interface GraphActionDeps extends GraphPullRequestActionDeps {
  logService: GitLogService;
  refreshCheckout: () => Promise<void>;
  refreshGraph: () => Promise<void>;
  post: (message: ToWebviewMessage) => void;
}

/** 메시지가 graph action 계열인지 확인한다. */
export function isGraphActionMessage(
  msg: FromWebviewMessage
): msg is GraphActionMessage {
  return GRAPH_ACTION_TYPES.has(msg.type);
}

/** graph action 메시지를 실제 git 동작으로 처리한다. */
export async function handleGraphAction(
  msg: GraphActionMessage,
  deps: GraphActionDeps
): Promise<void> {
  try {
    await dispatchGraphAction(msg, deps);
  } catch (err) {
    // 전체 git 출력(원격 거절/훅 실패 등)은 토스트에서 잘리므로 OUTPUT 채널에 남기고 "출력 보기" 액션을 제공한다.
    showErrorWithOutput(
      "graph action failed",
      err,
      vscode.l10n.t("Graph action failed: {0}", errText(err)),
      { type: msg.type }
    );
  }
}

const GRAPH_ACTION_TYPES = new Set<string>([
  "fetch",
  "fetchTags",
  "pull",
  "push",
  "forcePush",
  "openRemoteBranch",
  "checkoutBranch",
  "checkoutRemoteBranch",
  "checkoutCommit",
  "createBranch",
  "restoreBranchFromReflog",
  "cloneBranch",
  "renameBranch",
  "deleteBranch",
  "branchAction",
  "branchMergeAction",
  "commitAction",
  "undoCommit",
  "createTag",
  "checkoutTag",
  "createBranchFromTag",
  "deleteTag",
  "deleteRemoteTag",
  "pushTag",
  "copyTagName",
  "renameTag",
  "tagAction",
  "cherryPick",
  "revertCommit",
  "pullRequestAction",
  "copyCommitHash",
  "copyCommitMessage",
]);

/** 메시지 종류별 세부 처리로 분기한다. */
async function dispatchGraphAction(
  msg: GraphActionMessage,
  deps: GraphActionDeps
): Promise<void> {
  switch (msg.type) {
    case "fetch":
      await fetchAll(deps);
      return;
    case "fetchTags":
      await fetchTags(deps);
      return;
    case "pull":
      await pullCurrent(deps);
      return;
    case "push":
      await pushCurrent(deps);
      return;
    case "forcePush":
      await forcePushCurrent(deps);
      return;
    case "openRemoteBranch":
      await openRemoteBranch(deps);
      return;
    case "checkoutBranch":
      await checkoutBranch(deps, msg.branch);
      return;
    case "checkoutRemoteBranch":
      await checkoutRemoteBranch(deps, msg.branch);
      return;
    case "checkoutCommit":
      await checkoutCommit(deps, msg.hash);
      return;
    case "createBranch":
      await createBranch(deps, msg.hash, isRealCommit);
      return;
    case "restoreBranchFromReflog":
      await restoreBranchFromReflog(deps, msg.hash, isRealCommit);
      return;
    case "cloneBranch":
      await cloneBranch(deps, msg.branch, msg.checkout);
      return;
    case "renameBranch":
      await renameBranch(deps, msg.branch);
      return;
    case "deleteBranch":
      await deleteBranch(deps, msg.branch, msg.kind);
      return;
    case "branchAction":
      await branchAction(deps, msg.branch, msg.kind);
      return;
    case "branchMergeAction":
      await handleBranchMergeAction(deps, msg.branch, msg.action, msg.kind ?? "local");
      return;
    case "commitAction":
      await commitAction(deps, msg.hash);
      return;
    case "undoCommit":
      await undoCommit(deps, msg.hash);
      return;
    case "createTag":
      await createTag(deps, msg.hash, isRealCommit);
      return;
    case "checkoutTag":
      await checkoutTag(deps, msg.tag, msg.target);
      return;
    case "createBranchFromTag":
      await createBranchFromTag(deps, msg.tag, msg.target);
      return;
    case "deleteTag":
      await deleteTag(deps, msg.tag);
      return;
    case "deleteRemoteTag":
      await deleteRemoteTag(deps, msg.tag, msg.remote);
      return;
    case "pushTag":
      await pushTag(deps, msg.tag);
      return;
    case "copyTagName":
      await copyTagName(msg.tag);
      return;
    case "renameTag":
      await renameTag(deps, msg.tag);
      return;
    case "tagAction":
      await tagAction(deps, msg.tag, msg.target, msg.remote);
      return;
    case "cherryPick":
      await cherryPick(deps, msg.hash);
      return;
    case "revertCommit":
      await revertCommit(deps, msg.hash, msg.parents ?? []);
      return;
    case "pullRequestAction":
      await handlePullRequestAction(deps, msg.number, msg.action);
      return;
    case "copyCommitHash":
      await vscode.env.clipboard.writeText(msg.hash.trim());
      vscode.window.showInformationMessage(vscode.l10n.t("Commit hash copied."));
      return;
    case "copyCommitMessage":
      await vscode.env.clipboard.writeText(msg.message);
      vscode.window.showInformationMessage(vscode.l10n.t("Commit message copied."));
      return;
  }
}

/** 특정 커밋으로 detached HEAD checkout 을 수행한다. */
async function checkoutCommit(
  deps: GraphActionDeps,
  hash: string
): Promise<void> {
  const targetHash = hash.trim();
  if (!isRealCommit(targetHash)) {
    return;
  }
  const ok = await confirm(
    vscode.l10n.t("Checkout commit '{0}' as detached HEAD?", shortHash(targetHash)),
    vscode.l10n.t("Checkout")
  );
  if (!ok) {
    return;
  }
  try {
    await deps.logService.checkoutCommitDetached(targetHash);
  } catch (err) {
    if (!isCheckoutConflictError(err)) {
      throw err;
    }
    const result = await retryCheckoutWithConflicts(
      err,
      deps.logService.repoRoot,
      targetHash,
      () => deps.logService.checkoutCommitDetached(targetHash, true)
    );
    if (result === "cancelled") {
      return;
    }
    await deps.refreshGraph();
    if (await focusCheckoutConflicts(deps.logService.repoRoot)) {
      return;
    }
    if (result === "conflicts") {
      return;
    }
  }
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Checked out commit '{0}'.", shortHash(targetHash))
  );
}

/** commit row/node 의 빠른 액션 메뉴를 보여준다. */
async function commitAction(
  deps: GraphActionDeps,
  hash: string
): Promise<void> {
  if (!(await undoableHeadBranch(deps, hash))) {
    return;
  }
  const pick = await vscode.window.showQuickPick(
    [{ label: vscode.l10n.t("Undo Commit"), action: "undo" }],
    { placeHolder: shortHash(hash) }
  );
  if (pick?.action === "undo") {
    await undoCommit(deps, hash);
  }
}

/** 현재 로컬 브랜치의 최신 unpushed commit 을 soft reset 으로 되돌린다. */
async function undoCommit(
  deps: GraphActionDeps,
  hash: string
): Promise<void> {
  const branch = await undoableHeadBranch(deps, hash);
  if (!branch) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Only the latest unpushed commit on the current local branch can be undone.")
    );
    return;
  }
  const ok = await confirm(
    vscode.l10n.t(
      "Undo latest unpushed commit on '{0}'? Changes will remain staged.",
      branch.name
    ),
    vscode.l10n.t("Undo Commit")
  );
  if (!ok) {
    return;
  }
  await deps.logService.undoLastUnpushedCommit(hash);
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Commit undone. Changes remain staged.")
  );
}

/** 선택 커밋을 현재 브랜치에 cherry-pick 한다. */
async function cherryPick(deps: GraphActionDeps, hash: string): Promise<void> {
  if (!isRealCommit(hash)) {
    return;
  }
  if (!(await confirm(vscode.l10n.t("Cherry-pick commit '{0}'?", shortHash(hash)), vscode.l10n.t("Cherry-pick")))) {
    return;
  }
  await deps.logService.cherryPick(hash);
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Commit '{0}' cherry-picked.", shortHash(hash))
  );
}

/**
 * 현재 로컬 브랜치에 포함된 커밋을 revert 해서 새 커밋을 만든다.
 * @param deps   graph action 실행에 필요한 서비스와 새로고침 함수
 * @param hash   revert 대상 커밋 해시
 * @param parents 웹뷰 detail 이 알고 있는 부모 해시 목록
 */
async function revertCommit(
  deps: GraphActionDeps,
  hash: string,
  parents: string[]
): Promise<void> {
  if (!isRealCommit(hash)) {
    return;
  }
  if (
    !(await confirm(
      vscode.l10n.t("Revert commit '{0}' on the current branch?", shortHash(hash)),
      vscode.l10n.t("Revert")
    ))
  ) {
    return;
  }
  const mainline = await pickRevertMainline(deps, hash, parents);
  if (mainline === null) {
    return;
  }
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Reverting commit '{0}'", shortHash(hash)),
      cancellable: false,
    },
    () => deps.logService.revertCommitOnCurrentBranch(hash, mainline)
  );
  if (result.status === "conflicts") {
    await deps.refreshGraph();
    await vscode.commands.executeCommand("gitSimpleCompare.refreshConflicts");
    await vscode.commands.executeCommand("gitSimpleCompare.conflicts.focus");
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Revert paused with conflicts. Resolve them in the Conflicts view, then Continue."
      )
    );
    return;
  }
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t(
      "Commit '{0}' reverted on '{1}'.",
      shortHash(result.targetHash),
      result.branch
    )
  );
}

/**
 * merge commit revert 에 필요한 mainline parent 를 고른다.
 * @returns parent 번호, 필요 없으면 undefined, 사용자가 취소하면 null
 */
async function pickRevertMainline(
  deps: GraphActionDeps,
  hash: string,
  knownParents: string[]
): Promise<number | undefined | null> {
  const parents =
    knownParents.length > 0
      ? knownParents
      : await deps.logService.getCommitParents(hash);
  if (parents.length <= 1) {
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    parents.map((parent, index) => ({
      label: vscode.l10n.t("Parent {0}", index + 1),
      description: shortHash(parent),
      detail: vscode.l10n.t(
        "Use parent {0} as the mainline for reverting merge commit {1}.",
        index + 1,
        shortHash(hash)
      ),
      mainline: index + 1,
    })),
    {
      placeHolder: vscode.l10n.t(
        "Select the mainline parent for merge commit '{0}'",
        shortHash(hash)
      ),
    }
  );
  return pick?.mainline ?? null;
}

/** 확인이 필요한 파괴적/상태 변경 작업을 모달로 확인한다. */
async function confirm(message: string, label: string): Promise<boolean> {
  return (
    (await vscode.window.showWarningMessage(message, { modal: true }, label)) ===
    label
  );
}

/** 현재 local HEAD 이면서 remote 에 push 되지 않은 커밋이면 브랜치 상태를 반환한다. */
async function undoableHeadBranch(
  deps: GraphActionDeps,
  hash: string
): Promise<{ name: string; hash: string; upstream?: string; ahead: number; gone: boolean } | undefined> {
  const branch = (await deps.logService.getLocalBranches()).find(
    (item) => item.current
  );
  if (!branch || branch.hash !== hash || !isUnpushed(branch)) {
    return undefined;
  }
  return branch;
}

/** remote 에 아직 반영되지 않은 local branch 상태인지 확인한다. */
function isUnpushed(branch: { upstream?: string; ahead: number; gone: boolean }): boolean {
  return branch.ahead > 0 || !branch.upstream || branch.gone;
}

/** 가상 커밋을 실제 git 작업 대상에서 제외한다. */
function isRealCommit(hash: string): boolean {
  return hash !== ONGOING_COMMIT_HASH && hash !== STAGED_COMMIT_HASH;
}

/** 긴 커밋 해시를 UI 표시용으로 줄인다. */
function shortHash(hash: string): string {
  return hash.slice(0, 10);
}

/** 오류 메시지를 사용자에게 보여줄 짧은 문자열로 만든다. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
