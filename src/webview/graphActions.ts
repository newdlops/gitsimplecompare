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
  confirmCheckoutWithConflicts,
  focusCheckoutConflicts,
  isCheckoutConflictError,
} from "./graphCheckoutConflicts";
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

type BranchKind = "local" | "remote";

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
      await createBranch(deps, msg.hash);
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

/** 로컬 브랜치로 checkout 한다. */
async function checkoutBranch(
  deps: GraphActionDeps,
  branchName: string
): Promise<void> {
  const branch = (await deps.logService.getLocalBranches()).find(
    (item) => item.name === branchName
  );
  if (!branch) {
    vscode.window.showWarningMessage(
      vscode.l10n.t("Branch not found: {0}", branchName)
    );
    return;
  }
  if (branch.current) {
    return;
  }
  try {
    await deps.logService.checkoutLocalBranch(branch.name);
  } catch (err) {
    if (!isCheckoutConflictError(err)) {
      throw err;
    }
    if (!(await confirmCheckoutWithConflicts(err))) {
      return;
    }
    await deps.logService.checkoutLocalBranch(branch.name, true);
    await deps.refreshGraph();
    if (await focusCheckoutConflicts(deps.logService.repoRoot)) {
      return;
    }
  }
  await deps.refreshCheckout();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Checked out branch '{0}'.", branch.name)
  );
}

/** 원격 브랜치 chip 클릭 시 같은 이름의 로컬 브랜치를 만들고 checkout 한다. */
async function checkoutRemoteBranch(
  deps: GraphActionDeps,
  remoteBranch: string
): Promise<void> {
  const localName = localNameForRemoteBranch(remoteBranch);
  const existing = (await deps.logService.getLocalBranches()).find(
    (branch) => branch.name === localName
  );
  if (existing) {
    const ok = await confirm(
      vscode.l10n.t("Local branch '{0}' already exists. Checkout it?", localName),
      vscode.l10n.t("Checkout")
    );
    if (ok) {
      await checkoutBranch(deps, localName);
    }
    return;
  }

  const ok = await confirm(
    vscode.l10n.t(
      "Create local branch '{0}' from '{1}' and checkout?",
      localName,
      remoteBranch
    ),
    vscode.l10n.t("Create and Checkout")
  );
  if (!ok) {
    return;
  }

  try {
    await deps.logService.checkoutRemoteBranchAsLocal(remoteBranch);
  } catch (err) {
    if (!isCheckoutConflictError(err)) {
      throw err;
    }
    if (!(await confirmCheckoutWithConflicts(err))) {
      return;
    }
    await deps.logService.checkoutRemoteBranchAsLocal(remoteBranch, true);
    await deps.refreshGraph();
    if (await focusCheckoutConflicts(deps.logService.repoRoot)) {
      return;
    }
  }

  await deps.refreshCheckout();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Branch '{0}' created and checked out.", localName)
  );
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
  await deps.logService.checkoutCommitDetached(hash);
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Checked out commit '{0}'.", shortHash(hash))
  );
}

/** 선택 커밋에서 새 브랜치를 만든다. */
async function createBranch(
  deps: GraphActionDeps,
  hash: string
): Promise<void> {
  if (!isRealCommit(hash)) {
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t("New branch name"),
    validateInput: (value) =>
      value.trim() ? undefined : vscode.l10n.t("Branch name is required."),
  });
  if (!name) {
    return;
  }
  await deps.logService.createBranchAt(name.trim(), hash);
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Branch '{0}' created.", name.trim())
  );
}

/** 브랜치 chip 의 빠른 액션 메뉴를 보여준다. */
async function branchAction(
  deps: GraphActionDeps,
  branch: string,
  kind: BranchKind
): Promise<void> {
  if (kind === "remote") {
    return;
  }
  if (await vscode.window.showQuickPick([{ label: vscode.l10n.t("Checkout Branch") }], { placeHolder: branch })) {
    await checkoutBranch(deps, branch);
  }
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

/** 로컬/원격 브랜치를 삭제한다. 브랜치를 넘기지 않으면 목록에서 고른다. */
async function deleteBranch(
  deps: GraphActionDeps,
  branchName?: string,
  kind?: BranchKind
): Promise<void> {
  const branch = branchName
    ? { name: branchName, kind: kind ?? branchKind(branchName) }
    : await pickBranch(deps);
  if (!branch) {
    return;
  }
  const label =
    branch.kind === "remote"
      ? vscode.l10n.t("Delete remote branch '{0}'?", branch.name)
      : vscode.l10n.t("Delete local branch '{0}'?", branch.name);
  if (!(await confirm(label, vscode.l10n.t("Delete")))) {
    return;
  }
  if (branch.kind === "remote") {
    await deps.logService.deleteRemoteBranch(branch.name);
  } else {
    await deps.logService.deleteLocalBranch(branch.name);
  }
  await deps.refreshGraph();
  vscode.window.showInformationMessage(
    vscode.l10n.t("Branch '{0}' deleted.", branch.name)
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

/** 브랜치 목록에서 삭제 대상을 고른다. */
async function pickBranch(
  deps: GraphActionDeps
): Promise<{ name: string; kind: BranchKind } | undefined> {
  const branches = await deps.logService.getBranches();
  const pick = await vscode.window.showQuickPick(
    branches.map((branch) => ({
      label: branch.name,
      description: branch.kind,
      branch,
    })),
    { placeHolder: vscode.l10n.t("Select a branch") }
  );
  return pick?.branch;
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

/** 원격 브랜치처럼 보이는 이름이면 remote 로 간주한다. */
function branchKind(name: string): BranchKind {
  return name.includes("/") ? "remote" : "local";
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

/** origin/feature 형태의 remote ref 에서 feature 를 로컬 브랜치명으로 사용한다. */
function localNameForRemoteBranch(remoteBranch: string): string {
  const slash = remoteBranch.indexOf("/");
  return slash >= 0 ? remoteBranch.slice(slash + 1) : remoteBranch;
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
