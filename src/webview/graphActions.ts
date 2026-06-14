// git graph 웹뷰에서 요청한 git 액션을 처리하는 모듈.
// - 패널은 메시지 라우팅만 담당하고, checkout/branch/tag/fetch 같은 git 동작과 확인 UI 는 여기로 모은다.
import * as vscode from "vscode";
import {
  GitLogService,
  ONGOING_COMMIT_HASH,
  STAGED_COMMIT_HASH,
} from "../git/gitLogService";
import { logError } from "../ui/outputLog";
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
import { FromWebviewMessage } from "./graphProtocol";
import {
  fetchAll,
  fetchTags,
  openRemoteBranch,
  pullCurrent,
  pushCurrent,
} from "./graphSyncActions";

type GraphActionMessage = Extract<
  FromWebviewMessage,
  {
    type:
      | "fetch"
      | "fetchTags"
      | "pull"
      | "push"
      | "openRemoteBranch"
      | "checkoutBranch"
      | "checkoutRemoteBranch"
      | "checkoutCommit"
      | "createBranch"
      | "cloneBranch"
      | "deleteBranch"
      | "branchAction"
      | "commitAction"
      | "undoCommit"
      | "createTag"
      | "deleteTag"
      | "pushTag"
      | "tagAction"
      | "cherryPick"
      | "copyCommitHash"
      | "copyCommitMessage";
  }
>;

interface GraphActionDeps {
  logService: GitLogService;
  refreshCheckout: () => Promise<void>;
  refreshGraph: () => Promise<void>;
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
    logError("graph action failed", err, { type: msg.type });
    vscode.window.showErrorMessage(
      vscode.l10n.t("Graph action failed: {0}", errText(err))
    );
  }
}

const GRAPH_ACTION_TYPES = new Set<string>([
  "fetch",
  "fetchTags",
  "pull",
  "push",
  "openRemoteBranch",
  "checkoutBranch",
  "checkoutRemoteBranch",
  "checkoutCommit",
  "createBranch",
  "cloneBranch",
  "deleteBranch",
  "branchAction",
  "commitAction",
  "undoCommit",
  "createTag",
  "deleteTag",
  "pushTag",
  "tagAction",
  "cherryPick",
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
    case "cloneBranch":
      await cloneBranch(deps, msg.branch, msg.checkout);
      return;
    case "deleteBranch":
      await deleteBranch(deps, msg.branch, msg.kind);
      return;
    case "branchAction":
      await branchAction(deps, msg.branch, msg.kind);
      return;
    case "commitAction":
      await commitAction(deps, msg.hash);
      return;
    case "undoCommit":
      await undoCommit(deps, msg.hash);
      return;
    case "createTag":
      await createTag(deps, msg.hash);
      return;
    case "deleteTag":
      await deleteTag(deps, msg.tag);
      return;
    case "pushTag":
      await pushTag(deps, msg.tag);
      return;
    case "tagAction":
      await tagAction(deps, msg.tag);
      return;
    case "cherryPick":
      await cherryPick(deps, msg.hash);
      return;
    case "copyCommitHash":
      await vscode.env.clipboard.writeText(msg.hash);
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
  if (!isRealCommit(hash)) {
    return;
  }
  const ok = await confirm(
    vscode.l10n.t("Checkout commit '{0}' as detached HEAD?", shortHash(hash)),
    vscode.l10n.t("Checkout")
  );
  if (!ok) {
    return;
  }
  try {
    await deps.logService.checkoutCommitDetached(hash);
  } catch (err) {
    if (!isCheckoutConflictError(err)) {
      throw err;
    }
    const result = await retryCheckoutWithConflicts(
      err,
      deps.logService.repoRoot,
      hash,
      () => deps.logService.checkoutCommitDetached(hash, true)
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
    vscode.l10n.t("Checked out commit '{0}'.", shortHash(hash))
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

/** 선택 커밋에 새 tag 를 만든다. */
async function createTag(deps: GraphActionDeps, hash: string): Promise<void> {
  if (!isRealCommit(hash)) {
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("New tag name"),
    validateInput: (value) =>
      value.trim() ? undefined : vscode.l10n.t("Tag name is required."),
  });
  if (!name) {
    return;
  }
  await deps.logService.createTag(name.trim(), hash);
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Tag '{0}' created.", name.trim())
  );
}

/** tag chip 의 빠른 액션 메뉴를 보여준다. */
async function tagAction(deps: GraphActionDeps, tag: string): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: vscode.l10n.t("Push Tag"), action: "push" },
      { label: vscode.l10n.t("Delete Local Tag"), action: "deleteLocal" },
      { label: vscode.l10n.t("Delete Remote Tag"), action: "deleteRemote" },
      { label: vscode.l10n.t("Fetch Tags"), action: "fetch" },
    ],
    { placeHolder: tag }
  );
  if (!pick) {
    return;
  }
  if (pick.action === "push") {
    await pushTag(deps, tag);
  } else if (pick.action === "deleteLocal") {
    await deleteTag(deps, tag);
  } else if (pick.action === "deleteRemote") {
    await deleteRemoteTag(deps, tag);
  } else {
    await fetchTags(deps);
  }
}

/** 로컬 tag 를 삭제한다. tag 를 넘기지 않으면 목록에서 고른다. */
async function deleteTag(deps: GraphActionDeps, tagName?: string): Promise<void> {
  const tag = tagName ?? (await pickTag(deps));
  if (!tag || !(await confirm(vscode.l10n.t("Delete local tag '{0}'?", tag), vscode.l10n.t("Delete")))) {
    return;
  }
  await deps.logService.deleteTag(tag);
  await deps.refreshGraph();
  vscode.window.showInformationMessage(vscode.l10n.t("Tag '{0}' deleted.", tag));
}

/** 원격 tag 삭제를 수행한다. */
async function deleteRemoteTag(deps: GraphActionDeps, tag: string): Promise<void> {
  const remote = await pickRemote(deps);
  if (!remote || !(await confirm(vscode.l10n.t("Delete remote tag '{0}' from '{1}'?", tag, remote), vscode.l10n.t("Delete")))) {
    return;
  }
  await deps.logService.deleteRemoteTag(remote, tag);
  vscode.window.showInformationMessage(
    vscode.l10n.t("Remote tag '{0}' deleted.", tag)
  );
}

/** tag 를 원격 저장소로 push 한다. tag 를 넘기지 않으면 목록에서 고른다. */
async function pushTag(deps: GraphActionDeps, tagName?: string): Promise<void> {
  const tag = tagName ?? (await pickTag(deps));
  const remote = tag ? await pickRemote(deps) : undefined;
  if (!tag || !remote) {
    return;
  }
  await deps.logService.pushTag(remote, tag);
  vscode.window.showInformationMessage(vscode.l10n.t("Tag '{0}' pushed.", tag));
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

/** tag 목록에서 작업 대상을 고른다. */
async function pickTag(deps: GraphActionDeps): Promise<string | undefined> {
  const tags = await deps.logService.getTags();
  return vscode.window.showQuickPick(tags, {
    placeHolder: vscode.l10n.t("Select a tag"),
  });
}

/** 원격 저장소 목록에서 작업 대상을 고른다. */
async function pickRemote(deps: GraphActionDeps): Promise<string | undefined> {
  const remotes = await deps.logService.getRemotes();
  if (remotes.length === 0) {
    vscode.window.showWarningMessage(vscode.l10n.t("No git remote found."));
    return undefined;
  }
  return remotes.length === 1
    ? remotes[0]
    : vscode.window.showQuickPick(remotes, {
        placeHolder: vscode.l10n.t("Select a remote"),
      });
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
